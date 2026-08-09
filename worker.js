/**
 * Trivia Rumble Elite — Cloudflare Worker
 *
 * Serves the whole game: static assets, Discord OAuth exchange,
 * question generation (opencode.ai / big-pickle), Firebase proxies.
 *
 * Game model (single GLOBAL room, time-sliced — see README):
 *  - trivia/global/game    = { questionStart, slotDuration, bankLen, startedAt }
 *  - trivia/global/bank/<i> = { question, options, correctAnswer }
 *  - trivia/global/players/<uid> = { id, username, avatarUrl, score, lastSeen, online }  (persistent)
 *  - trivia/global/answers/<slot>/<uid> = { answer, at }   (per-question answers)
 *  - trivia/global/meta    = { generating: <ts> }          (bank generation lock)
 *
 * All clients compute the current question deterministically:
 *   slot = floor((now - questionStart) / slotDuration)
 *   question = bank[slot % bank.length]
 */

const FB_DEFAULT_HOST = "pop-party-1-default-rtdb.firebaseio.com";
const SLOT_DURATION = 20000;   // 20 seconds per question
const BANK_BATCH = 20;         // questions generated per top-up
const BANK_MAX = 1000;         // reset bank above this size (raised: batch top-ups from GitHub Actions)
const TOP_UP_THRESHOLD = 20;   // top up when fewer than this many questions remain
const GEN_LOCK_MS = 45000;     // lock window for concurrent top-ups
const USED_MAX = 600;          // keep this many past questions in meta.used (FIFO)
const AVOID_PROMPT_N = 60;     // how many past questions to send to the AI as "do not repeat"

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}


// ── Support page (proxied so it opens INSIDE the Discord activity) ─────────
// Discord's Activity sandbox blocks external windows/navigation, so a plain
// target="_blank" link does nothing inside the game. Serving the support
// page same-origin (like /privacy + /terms) makes it open in-window. The
// voice-support page is self-contained (inline CSS, Paystack inline.js only),
// so proxying just the HTML is enough; we inject a back-to-game bar on top.
const SUPPORT_URL = "https://walusimbi-leon1.github.io/voice-support/";
async function handleSupport() {
  // Keep /support working for any cached links: bounce to the real
  // donate page. In Discord the game JS intercepts and uses
  // openExternalLink instead; in a browser this redirect is fine.
  return Response.redirect(SUPPORT_URL, 302);
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

// ── Firebase direct helpers (server side) ───────────────────────────────────
function fbUrl(env, path) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  return `https://${host}/${path}.json`;
}

async function fbGet(env, path) {
  const res = await fetch(fbUrl(env, path));
  if (!res.ok) throw new Error(`fbGet ${path} → ${res.status}`);
  return res.json();
}

async function fbPut(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPut ${path} → ${res.status}`);
  return res.json();
}

async function fbPatch(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPatch ${path} → ${res.status}`);
  return res.json();
}

async function fbDelete(env, path) {
  const res = await fetch(fbUrl(env, path), { method: "DELETE" });
  if (!res.ok) throw new Error(`fbDelete ${path} → ${res.status}`);
  return res.json();
}

function bankCount(bank) {
  return bank && typeof bank === "object" ? Object.keys(bank).length : 0;
}

// Normalize a question for duplicate comparison (case/space/punct-insensitive).
function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── "No repeats" bookkeeping ────────────────────────────────────────────────
// meta.used = FIFO array of question texts that have already been served or
// queued. New AI/static questions are filtered against it, and it is sent to
// the model so it avoids repeats AND close paraphrases.
async function readUsed(env) {
  const meta = (await fbGet(env, "trivia/global/meta").catch(() => null)) || {};
  return Array.isArray(meta.used) ? meta.used : [];
}

async function markUsed(env, questions) {
  if (!questions || !questions.length) return;
  const meta = (await fbGet(env, "trivia/global/meta").catch(() => null)) || {};
  const used = Array.isArray(meta.used) ? meta.used : [];
  for (const q of questions) {
    if (q?.question) used.push(q.question);
  }
  const trimmed = used.slice(-USED_MAX);
  await fbPatch(env, "trivia/global/meta", { used: trimmed }).catch(() => {});
}

// Drop questions whose text (normalized) matches anything already used/queued.
function filterFresh(questions, usedSet, bankSet) {
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    if (!q?.question) continue;
    const n = norm(q.question);
    if (!n) continue;
    if (usedSet.has(n) || bankSet.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(q);
  }
  return out;
}

// ── Discord OAuth exchange (Arrow Blast pattern) ────────────────────────────
async function handleExchange(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let code;
  try {
    const body = await request.json();
    code = body && body.code;
  } catch {
    return json({ error: "Bad request — code required" }, 400);
  }
  if (!code || typeof code !== "string") return json({ error: "Bad request — code required" }, 400);

  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const redirectUri = env.REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return json({ error: "Server configuration error — DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set" }, 500);
  }

  try {
    const resp = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ error: data.error, description: data.error_description }, resp.status);
    }
    return json({ access_token: data.access_token });
  } catch (err) {
    console.error("[Exchange] Internal error:", err.message);
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Question generation via opencode.ai (big-pickle) ────────────────────────
async function generateWithOpenCode(prompt, env) {
  const apiKey = env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY not set");
  const model = env.MODEL || "big-pickle";
  const response = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a trivia question generator. Generate engaging, factual trivia questions with exactly 4 answer options and one correct answer. Always respond with valid JSON only — no markdown, no extra text." },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      max_tokens: 16384, // big-pickle is a reasoning model — 4096 was too small, JSON got truncated
    }),
  });
  if (!response.ok) throw new Error(`opencode.ai ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("opencode.ai empty response");
  return content;
}

function parseQuestions(raw, count) {
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("No JSON array in response");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  const out = [];
  for (const q of parsed) {
    if (typeof q?.question !== "string" || !Array.isArray(q?.options) || q.options.length !== 4) continue;
    let a = q.correctAnswer;
    if (typeof a === "string") a = parseInt(a, 10);
    if (typeof a !== "number" || a < 0 || a > 3) continue;
    out.push({ question: q.question, options: q.options.map(String), correctAnswer: a });
    if (out.length >= count) break;
  }
  if (!out.length) throw new Error("No valid questions parsed");
  return out;
}

async function generateQuestions(count, env, avoidTexts) {
  const avoid =
    avoidTexts && avoidTexts.length
      ? "\n\nHere are recently used questions. Do NOT repeat these or closely paraphrase them — make every question fresh and distinct:\n" +
        avoidTexts
          .slice(-AVOID_PROMPT_N)
          .map((t) => `- ${t}`)
          .join("\n")
      : "";
  const prompt = `Generate ${count} unique trivia questions spanning a fun mix of categories: science, history, geography, entertainment, sports, technology, general knowledge. Vary the difficulty.${avoid}
Return ONLY a JSON array (no markdown) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0}]
"correctAnswer" must be the index (0-3) of the correct option.`;
  const raw = await generateWithOpenCode(prompt, env);
  return parseQuestions(raw, count);
}

// ── Built-in question bank (instant seed + fallback) ────────────────────────
const CATEGORIES = ["general", "science", "history", "geography", "entertainment", "sports", "technology", "art", "literature", "music"];

const QUESTION_BANK = {
  general: [
    { q: "What is the capital of France?", o: ["Paris", "Lyon", "Marseille", "Nice"], a: 0 },
    { q: "How many continents are there on Earth?", o: ["5", "6", "7", "8"], a: 2 },
    { q: "What gas do plants absorb from the air?", o: ["Oxygen", "Carbon dioxide", "Nitrogen", "Hydrogen"], a: 1 },
    { q: "How many sides does a hexagon have?", o: ["5", "6", "7", "8"], a: 1 },
    { q: "Which planet is known as the Red Planet?", o: ["Venus", "Mars", "Jupiter", "Saturn"], a: 1 },
    { q: "What is the largest mammal in the world?", o: ["Elephant", "Blue whale", "Giraffe", "Hippo"], a: 1 },
    { q: "How many legs does a spider have?", o: ["6", "8", "10", "12"], a: 1 },
    { q: "What is the freezing point of water in Celsius?", o: ["0°", "32°", "100°", "-10°"], a: 0 },
    { q: "Which organ pumps blood around the body?", o: ["Lungs", "Brain", "Heart", "Liver"], a: 2 },
    { q: "What is the largest ocean on Earth?", o: ["Atlantic", "Indian", "Arctic", "Pacific"], a: 3 },
    { q: "How many colors are in a rainbow?", o: ["5", "6", "7", "8"], a: 2 },
    { q: "Which animal is known as the King of the Jungle?", o: ["Tiger", "Lion", "Elephant", "Bear"], a: 1 },
    { q: "What do bees produce?", o: ["Milk", "Honey", "Sugar", "Wax only"], a: 1 },
    { q: "Which of these is a fruit?", o: ["Carrot", "Potato", "Tomato", "Onion"], a: 2 },
    { q: "What is the smallest prime number?", o: ["0", "1", "2", "3"], a: 2 },
    { q: "How many minutes are in an hour?", o: ["30", "60", "90", "100"], a: 1 },
  ],
  science: [
    { q: "What is the chemical symbol for water?", o: ["H2O", "CO2", "O2", "NaCl"], a: 0 },
    { q: "What force pulls objects toward Earth?", o: ["Magnetism", "Gravity", "Friction", "Inertia"], a: 1 },
    { q: "What is the hardest natural substance on Earth?", o: ["Iron", "Gold", "Diamond", "Quartz"], a: 2 },
    { q: "Which particle orbits the nucleus of an atom?", o: ["Proton", "Neutron", "Electron", "Photon"], a: 2 },
    { q: "What is the speed of light approximately?", o: ["300,000 km/s", "150,000 km/s", "1,000 km/s", "3,000 km/s"], a: 0 },
    { q: "What gas makes up most of Earth's atmosphere?", o: ["Oxygen", "Carbon dioxide", "Nitrogen", "Argon"], a: 2 },
    { q: "What is the powerhouse of the cell?", o: ["Nucleus", "Mitochondria", "Ribosome", "Membrane"], a: 1 },
    { q: "Which planet has the most moons?", o: ["Mars", "Venus", "Jupiter", "Mercury"], a: 2 },
    { q: "What is the chemical symbol for gold?", o: ["Go", "Gd", "Au", "Ag"], a: 2 },
    { q: "What type of rock forms from cooling magma?", o: ["Sedimentary", "Metamorphic", "Igneous", "Fossil"], a: 2 },
    { q: "How many bones are in the adult human body?", o: ["106", "206", "306", "406"], a: 1 },
    { q: "What is the study of weather called?", o: ["Geology", "Meteorology", "Astronomy", "Ecology"], a: 1 },
    { q: "Which vitamin is produced by sunlight on skin?", o: ["Vitamin A", "Vitamin B", "Vitamin C", "Vitamin D"], a: 3 },
    { q: "What is the largest organ of the human body?", o: ["Liver", "Brain", "Skin", "Lungs"], a: 2 },
    { q: "Which scientist proposed the theory of relativity?", o: ["Newton", "Einstein", "Hawking", "Galileo"], a: 1 },
    { q: "What is the boiling point of water in Celsius?", o: ["50°", "75°", "100°", "125°"], a: 2 },
  ],
  history: [
    { q: "Who was the first President of the United States?", o: ["Lincoln", "Washington", "Jefferson", "Adams"], a: 1 },
    { q: "In which year did World War II end?", o: ["1943", "1944", "1945", "1946"], a: 2 },
    { q: "Who built the pyramids of Giza?", o: ["Romans", "Greeks", "Ancient Egyptians", "Babylonians"], a: 2 },
    { q: "What wall fell in 1989?", o: ["Great Wall of China", "Berlin Wall", "Hadrian's Wall", "Wailing Wall"], a: 1 },
    { q: "Who was the first man to walk on the Moon?", o: ["Buzz Aldrin", "Yuri Gagarin", "Neil Armstrong", "Michael Collins"], a: 2 },
    { q: "Which empire was ruled by Julius Caesar?", o: ["Greek", "Persian", "Roman", "Ottoman"], a: 2 },
    { q: "The Titanic sank in which year?", o: ["1905", "1912", "1918", "1923"], a: 1 },
    { q: "Who painted the Mona Lisa?", o: ["Michelangelo", "Van Gogh", "Leonardo da Vinci", "Raphael"], a: 2 },
    { q: "Which country gifted the Statue of Liberty to the USA?", o: ["England", "France", "Spain", "Italy"], a: 1 },
    { q: "World War I began in which year?", o: ["1912", "1914", "1916", "1918"], a: 1 },
    { q: "Who was known as the Iron Lady?", o: ["Queen Victoria", "Margaret Thatcher", "Angela Merkel", "Indira Gandhi"], a: 1 },
    { q: "The ancient city of Rome was founded on how many hills?", o: ["5", "7", "9", "11"], a: 1 },
    { q: "Which explorer discovered America in 1492?", o: ["Magellan", "Vasco da Gama", "Columbus", "Cook"], a: 2 },
    { q: "Who wrote the Declaration of Independence primarily?", o: ["Washington", "Franklin", "Jefferson", "Hamilton"], a: 2 },
    { q: "The Great Fire of London was in which year?", o: ["1556", "1666", "1776", "1886"], a: 1 },
    { q: "Which ancient civilization built Machu Picchu?", o: ["Aztec", "Maya", "Inca", "Olmec"], a: 2 },
  ],
  geography: [
    { q: "What is the longest river in the world?", o: ["Amazon", "Nile", "Yangtze", "Mississippi"], a: 1 },
    { q: "Which country is the largest by area?", o: ["Canada", "China", "USA", "Russia"], a: 3 },
    { q: "What is the smallest country in the world?", o: ["Monaco", "Vatican City", "Malta", "San Marino"], a: 1 },
    { q: "Which desert is the largest hot desert?", o: ["Gobi", "Kalahari", "Sahara", "Mojave"], a: 2 },
    { q: "Mount Everest is on the border of which two countries?", o: ["India & Pakistan", "Nepal & China", "India & Nepal", "China & Bhutan"], a: 1 },
    { q: "What is the capital of Japan?", o: ["Osaka", "Kyoto", "Tokyo", "Seoul"], a: 2 },
    { q: "Which continent is the Sahara Desert on?", o: ["Asia", "Africa", "Australia", "South America"], a: 1 },
    { q: "What is the largest island in the world?", o: ["Madagascar", "Borneo", "Greenland", "Sumatra"], a: 2 },
    { q: "Which country has the most people?", o: ["USA", "India", "China", "Indonesia"], a: 1 },
    { q: "The Amazon Rainforest is mostly in which country?", o: ["Peru", "Colombia", "Brazil", "Venezuela"], a: 2 },
    { q: "What is the capital of Australia?", o: ["Sydney", "Melbourne", "Canberra", "Perth"], a: 2 },
    { q: "Which ocean is the deepest?", o: ["Atlantic", "Indian", "Arctic", "Pacific"], a: 3 },
    { q: "The Great Barrier Reef is off which country's coast?", o: ["Brazil", "Australia", "Thailand", "Mexico"], a: 1 },
    { q: "What is the capital of Egypt?", o: ["Alexandria", "Cairo", "Giza", "Luxor"], a: 1 },
    { q: "Which is the longest mountain range in the world?", o: ["Rockies", "Himalayas", "Andes", "Alps"], a: 2 },
    { q: "What is the capital of Kenya?", o: ["Mombasa", "Nairobi", "Kisumu", "Nakuru"], a: 1 },
  ],
  entertainment: [
    { q: "Who played Iron Man in the Marvel movies?", o: ["Chris Evans", "Robert Downey Jr.", "Chris Hemsworth", "Mark Ruffalo"], a: 1 },
    { q: "Who sang 'Thriller'?", o: ["Prince", "Michael Jackson", "Stevie Wonder", "James Brown"], a: 1 },
    { q: "Which TV series features the character Walter White?", o: ["The Wire", "Breaking Bad", "Ozark", "Narcos"], a: 1 },
    { q: "Who directed 'Jurassic Park'?", o: ["James Cameron", "Steven Spielberg", "George Lucas", "Ridley Scott"], a: 1 },
    { q: "What is the name of Harry Potter's owl?", o: ["Scabbers", "Hedwig", "Crookshanks", "Fang"], a: 1 },
    { q: "Which band performed 'Bohemian Rhapsody'?", o: ["The Beatles", "Queen", "Pink Floyd", "Led Zeppelin"], a: 1 },
    { q: "Who voiced Woody in Toy Story?", o: ["Tim Allen", "Tom Hanks", "Billy Crystal", "John Goodman"], a: 1 },
    { q: "Which movie features the quote 'May the Force be with you'?", o: ["Star Wars", "Star Trek", "Guardians of the Galaxy", "Dune"], a: 0 },
    { q: "What is the name of the wizard school in Harry Potter?", o: ["Durmstrang", "Hogwarts", "Beauxbatons", "Ilvermorny"], a: 1 },
    { q: "Who played Jack in Titanic?", o: ["Brad Pitt", "Leonardo DiCaprio", "Johnny Depp", "Tom Cruise"], a: 1 },
    { q: "Which superhero can shoot webs from his hands?", o: ["Batman", "Superman", "Spider-Man", "Flash"], a: 2 },
    { q: "What animated movie features a character named Elsa?", o: ["Moana", "Frozen", "Tangled", "Brave"], a: 1 },
    { q: "Who is known as the 'King of Pop'?", o: ["Elvis Presley", "Michael Jackson", "Prince", "Freddie Mercury"], a: 1 },
    { q: "Which game franchise features Mario?", o: ["Sonic", "Nintendo", "Sega", "Xbox"], a: 1 },
    { q: "Who wrote the 'Game of Thrones' books?", o: ["J.R.R. Tolkien", "George R.R. Martin", "J.K. Rowling", "C.S. Lewis"], a: 1 },
    { q: "What is the highest-grossing film of all time (2020s)?", o: ["Avatar", "Avengers: Endgame", "Titanic", "Star Wars"], a: 1 },
  ],
  sports: [
    { q: "How many players are on a soccer team?", o: ["9", "10", "11", "12"], a: 2 },
    { q: "Which country won the FIFA World Cup in 2022?", o: ["France", "Brazil", "Argentina", "Germany"], a: 2 },
    { q: "How many points is a touchdown worth in American football?", o: ["3", "6", "7", "10"], a: 1 },
    { q: "In which sport would you perform a slam dunk?", o: ["Volleyball", "Basketball", "Tennis", "Handball"], a: 1 },
    { q: "How many players are on a basketball team?", o: ["4", "5", "6", "7"], a: 1 },
    { q: "Which boxer was known as 'The Greatest'?", o: ["Mike Tyson", "Muhammad Ali", "Joe Frazier", "Floyd Mayweather"], a: 1 },
    { q: "What is the diameter of a basketball hoop in inches?", o: ["16", "18", "20", "24"], a: 1 },
    { q: "In tennis, what is a score of 0 called?", o: ["Zero", "Love", "Nil", "Ace"], a: 1 },
    { q: "Which country hosted the 2016 Summer Olympics?", o: ["China", "UK", "Brazil", "Japan"], a: 2 },
    { q: "How many holes are in a standard golf course?", o: ["9", "12", "18", "24"], a: 2 },
    { q: "Which sport uses a shuttlecock?", o: ["Squash", "Badminton", "Tennis", "Racquetball"], a: 1 },
    { q: "Who holds the record for most NBA points (as of 2024)?", o: ["Kareem Abdul-Jabbar", "Michael Jordan", "LeBron James", "Kobe Bryant"], a: 2 },
    { q: "How long is a standard marathon in miles?", o: ["21.1", "26.2", "31.1", "42.2"], a: 1 },
    { q: "Which country invented cricket?", o: ["Australia", "India", "England", "South Africa"], a: 2 },
    { q: "What color card does a referee show for a serious foul in soccer?", o: ["Yellow", "Red", "Blue", "Black"], a: 1 },
    { q: "In which sport do you 'checkmate' your opponent?", o: ["Go", "Chess", "Checkers", "Backgammon"], a: 1 },
  ],
  technology: [
    { q: "Who co-founded Apple Inc.?", o: ["Bill Gates", "Steve Jobs", "Elon Musk", "Mark Zuckerberg"], a: 1 },
    { q: "What does 'CPU' stand for?", o: ["Central Processing Unit", "Computer Power Unit", "Core Processing Unit", "Central Program Utility"], a: 0 },
    { q: "Which company makes the Android operating system?", o: ["Apple", "Microsoft", "Google", "Samsung"], a: 2 },
    { q: "What does 'HTTP' stand for?", o: ["HyperText Transfer Protocol", "High Transfer Text Protocol", "HyperText Transmission Process", "Home Tool Transfer Protocol"], a: 0 },
    { q: "Who created the first widely used web browser?", o: ["Bill Gates", "Tim Berners-Lee", "Steve Wozniak", "Larry Page"], a: 1 },
    { q: "What is the name of Apple's virtual assistant?", o: ["Alexa", "Cortana", "Siri", "Bixby"], a: 2 },
    { q: "Which social media platform was founded by Mark Zuckerberg?", o: ["Twitter", "Instagram", "Facebook", "LinkedIn"], a: 2 },
    { q: "What does 'RAM' stand for?", o: ["Read Access Memory", "Random Access Memory", "Rapid Application Memory", "Random Allocation Memory"], a: 1 },
    { q: "Which company makes the PlayStation?", o: ["Microsoft", "Nintendo", "Sony", "Sega"], a: 2 },
    { q: "What is the most popular programming language (2024)?", o: ["Java", "C++", "Python", "Ruby"], a: 2 },
    { q: "What year was the first iPhone released?", o: ["2005", "2007", "2009", "2011"], a: 1 },
    { q: "What does 'Wi-Fi' stand for?", o: ["Wireless Fidelity", "Wide Frequency", "Wireless Frequency", "Wired Fidelity"], a: 0 },
    { q: "Which company owns YouTube?", o: ["Apple", "Amazon", "Google", "Meta"], a: 2 },
    { q: "What is the main chip used in most smartphones called?", o: ["GPU", "CPU", "SSD", "RAM"], a: 1 },
    { q: "Which of these is a video game console?", o: ["Kindle", "Xbox", "AirPods", "Chromecast"], a: 1 },
    { q: "What does 'AI' stand for?", o: ["Automated Intelligence", "Artificial Intelligence", "Advanced Interface", "Autonomous Input"], a: 1 },
  ],
  art: [
    { q: "Who painted the 'Starry Night'?", o: ["Pablo Picasso", "Vincent van Gogh", "Claude Monet", "Salvador Dali"], a: 1 },
    { q: "What is the art of paper folding called?", o: ["Kirigami", "Origami", "Calligraphy", "Papier-mâché"], a: 1 },
    { q: "Who sculpted 'David'?", o: ["Leonardo da Vinci", "Donatello", "Michelangelo", "Raphael"], a: 2 },
    { q: "Which artist cut off his own ear?", o: ["Van Gogh", "Monet", "Picasso", "Rembrandt"], a: 0 },
    { q: "The 'Mona Lisa' is displayed in which museum?", o: ["The Met", "Louvre", "British Museum", "Prado"], a: 1 },
    { q: "What style of art did Salvador Dali pioneer?", o: ["Impressionism", "Surrealism", "Cubism", "Pop Art"], a: 1 },
    { q: "Who created Mickey Mouse?", o: ["Walt Disney", "Warner Bros", "Charles Schulz", "Hanna Barbera"], a: 0 },
    { q: "What is the color you get by mixing blue and yellow?", o: ["Purple", "Orange", "Green", "Brown"], a: 2 },
    { q: "Who painted the 'Scream'?", o: ["Munch", "Picasso", "Klimt", "Dali"], a: 0 },
    { q: "Which artist is famous for melting clocks?", o: ["Picasso", "Dali", "Warhol", "Monet"], a: 1 },
    { q: "What is the Japanese art of flower arranging called?", o: ["Ikebana", "Origami", "Bonsai", "Sumi-e"], a: 0 },
    { q: "Who is the artist behind 'Campbell's Soup Cans'?", o: ["Roy Lichtenstein", "Andy Warhol", "Keith Haring", "Banksy"], a: 1 },
    { q: "Which famous painting shows a woman with a mysterious smile?", o: ["Girl with a Pearl Earring", "Mona Lisa", "The Birth of Venus", "Whistler's Mother"], a: 1 },
    { q: "What material is used in fresco painting?", o: ["Oil", "Wet plaster", "Canvas", "Wood"], a: 1 },
    { q: "Who painted the ceiling of the Sistine Chapel?", o: ["Raphael", "Michelangelo", "Da Vinci", "Botticelli"], a: 1 },
    { q: "What is 'graffiti' art usually done with?", o: ["Oil paint", "Spray paint", "Watercolor", "Chalk"], a: 1 },
  ],
  literature: [
    { q: "Who wrote 'Romeo and Juliet'?", o: ["Charles Dickens", "William Shakespeare", "Jane Austen", "Mark Twain"], a: 1 },
    { q: "Who is the author of '1984'?", o: ["Aldous Huxley", "George Orwell", "Ray Bradbury", "H.G. Wells"], a: 1 },
    { q: "What is the first book of the Bible?", o: ["Exodus", "Genesis", "Leviticus", "Numbers"], a: 1 },
    { q: "Who wrote 'Pride and Prejudice'?", o: ["Charlotte Brontë", "Jane Austen", "Emily Brontë", "Mary Shelley"], a: 1 },
    { q: "Who created the character Sherlock Holmes?", o: ["Agatha Christie", "Arthur Conan Doyle", "Edgar Allan Poe", "Wilkie Collins"], a: 1 },
    { q: "What is the name of the whale in 'Moby Dick'?", o: ["Moby Dick", "Ahab", "Ishmael", "Queequeg"], a: 0 },
    { q: "Who wrote 'Harry Potter'?", o: ["J.R.R. Tolkien", "J.K. Rowling", "C.S. Lewis", "Philip Pullman"], a: 1 },
    { q: "Which author wrote 'The Great Gatsby'?", o: ["Ernest Hemingway", "F. Scott Fitzgerald", "John Steinbeck", "William Faulkner"], a: 1 },
    { q: "Who wrote 'The Lord of the Rings'?", o: ["C.S. Lewis", "J.R.R. Tolkien", "Terry Pratchett", "George R.R. Martin"], a: 1 },
    { q: "What is the longest book in the Bible?", o: ["Genesis", "Psalms", "Isaiah", "Ezekiel"], a: 1 },
    { q: "Who wrote 'To Kill a Mockingbird'?", o: ["Harper Lee", "Toni Morrison", "Flannery O'Connor", "Maya Angelou"], a: 0 },
    { q: "Which poet wrote 'The Raven'?", o: ["Robert Frost", "Edgar Allan Poe", "Walt Whitman", "Emily Dickinson"], a: 1 },
    { q: "Who wrote the 'Iliad'?", o: ["Socrates", "Plato", "Homer", "Aristotle"], a: 2 },
    { q: "What is the name of Scrooge's partner's ghost in 'A Christmas Carol'?", o: ["Bob Cratchit", "Jacob Marley", "Tiny Tim", "Mr. Fezziwig"], a: 1 },
    { q: "Who wrote 'Little Women'?", o: ["Louisa May Alcott", "Jane Austen", "Emily Dickinson", "Anne Brontë"], a: 0 },
    { q: "Which author wrote the 'Chronicles of Narnia'?", o: ["J.R.R. Tolkien", "C.S. Lewis", "J.K. Rowling", "Roald Dahl"], a: 1 },
  ],
  music: [
    { q: "How many strings does a standard guitar have?", o: ["4", "5", "6", "7"], a: 2 },
    { q: "Who is known as the 'Queen of Pop'?", o: ["Beyoncé", "Madonna", "Lady Gaga", "Taylor Swift"], a: 1 },
    { q: "What instrument has 88 keys?", o: ["Organ", "Piano", "Harpsichord", "Accordion"], a: 1 },
    { q: "Which band wrote 'Stairway to Heaven'?", o: ["The Rolling Stones", "Led Zeppelin", "Pink Floyd", "The Who"], a: 1 },
    { q: "Who is the best-selling music artist of all time?", o: ["Elvis Presley", "The Beatles", "Michael Jackson", "Madonna"], a: 1 },
    { q: "What genre of music originated in Jamaica?", o: ["Salsa", "Reggae", "Samba", "Flamenco"], a: 1 },
    { q: "How many strings does a violin have?", o: ["2", "3", "4", "6"], a: 2 },
    { q: "Who wrote the opera 'The Magic Flute'?", o: ["Beethoven", "Mozart", "Bach", "Chopin"], a: 1 },
    { q: "Which artist released 'Lemonade'?", o: ["Rihanna", "Beyoncé", "Nicki Minaj", "Alicia Keys"], a: 1 },
    { q: "What is the highest female singing voice?", o: ["Alto", "Mezzo-soprano", "Soprano", "Contralto"], a: 2 },
    { q: "Who sang 'Imagine'?", o: ["Paul McCartney", "John Lennon", "George Harrison", "Ringo Starr"], a: 1 },
    { q: "What term means the speed of music?", o: ["Pitch", "Tempo", "Volume", "Timbre"], a: 1 },
    { q: "Which country does the sitar come from?", o: ["China", "Japan", "India", "Pakistan"], a: 2 },
    { q: "Who is known as the 'King of Rock and Roll'?", o: ["Johnny Cash", "Elvis Presley", "Chuck Berry", "Buddy Holly"], a: 1 },
    { q: "How many musicians are in a quartet?", o: ["2", "3", "4", "5"], a: 2 },
    { q: "What instrument does Yo-Yo Ma play?", o: ["Violin", "Cello", "Viola", "Double bass"], a: 1 },
  ],
};

function builtinSeed(excludeSet) {
  const all = [];
  for (const cat of CATEGORIES) {
    for (const item of QUESTION_BANK[cat]) {
      if (excludeSet && excludeSet.has(norm(item.q))) continue;
      all.push({ question: item.q, options: item.o, correctAnswer: item.a });
    }
  }
  // deterministic-ish shuffle (Math.random is fine here)
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function pickQuestions(count, usedRaw) {
  const exclude = usedRaw && usedRaw.length ? new Set(usedRaw.map(norm)) : null;
  const all = builtinSeed(exclude);
  return all.slice(0, Math.min(count, all.length));
}

// Rotate the bank by a random offset so a recycled round doesn't start with
// the exact question the previous round ended on.
function rotateBank(arr) {
  if (arr.length < 2) return arr;
  const offset = 1 + Math.floor(Math.random() * (arr.length - 1));
  return arr.slice(offset).concat(arr.slice(0, offset));
}

// Emergency hard reset: the live slot has caught up with (or passed) the bank
// end, so the game would otherwise stall on "Preparing new questions…". Reuse
// the existing bank (rotated), pad with built-ins if it's tiny, and restart
// the question clock. Player scores persist; only per-question answers clear.
async function hardReset(env, bank, len, usedRaw) {
  let arr = Object.keys(bank)
    .map((k) => bank[k])
    .filter((q) => q && q.question);
  if (arr.length < 100) {
    // Pad with built-in questions (repeats allowed in an emergency — never stall).
    const norms = new Set(arr.map((q) => norm(q.question)));
    for (const q of builtinSeed()) {
      if (arr.length >= 100) break;
      if (norms.has(norm(q.question))) continue;
      arr.push(q);
      norms.add(norm(q.question));
    }
  }
  const rotated = rotateBank(arr);
  const patch = {};
  rotated.forEach((q, i) => (patch[i] = q));
  await fbPut(env, "trivia/global/bank", patch);
  await fbDelete(env, "trivia/global/answers").catch(() => {});
  await fbPut(env, "trivia/global/game", {
    questionStart: Date.now(),
    slotDuration: SLOT_DURATION,
    bankLen: rotated.length,
    startedAt: Date.now(),
  });
  await fbPut(env, "trivia/global/meta", { generating: 0, used: (await readUsed(env)) });
  return json({ bankLen: rotated.length, reset: true, source: "reuse" });
}

// ── /api/trivia — ensure the bank has questions ─────────────────────────────
async function handleTrivia(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const count = Math.max(5, Math.min(30, Number(body.count) || BANK_BATCH));

  try {
    const meta = (await fbGet(env, "trivia/global/meta").catch(() => null)) || {};
    const bank = (await fbGet(env, "trivia/global/bank").catch(() => null)) || {};
    const len = bankCount(bank);
    const usedRaw = Array.isArray(meta.used) ? meta.used : [];
    const usedSet = new Set(usedRaw.map(norm));
    const bankSet = new Set(Object.values(bank).filter((q) => q?.question).map((q) => norm(q.question)));

    // Someone is already generating — return current state
    if (meta.generating && Date.now() - meta.generating < GEN_LOCK_MS) {
      return json({ bankLen: len, generating: true });
    }
    // Don't let clients hammer back-to-back hard resets (concurrent stuck tabs).
    if (meta.lastReset && Date.now() - meta.lastReset < 15000) {
      return json({ bankLen: len, reset: false, recently: true });
    }

    // Empty bank → generate a fresh AI batch immediately (fallback: built-ins),
    // then start the question clock. AI first so the game never opens with the
    // same static questions every time.
    if (len === 0) {
      await fbPut(env, "trivia/global/meta", { generating: Date.now(), used: usedRaw });
      let questions;
      try {
        questions = await generateQuestions(count, env, usedRaw);
      } catch (err) {
        console.error("[Trivia] opencode.ai failed, using built-in:", err.message);
        questions = null;
      }
      if (!questions || !questions.length) questions = pickQuestions(count, usedRaw);
      let fresh = filterFresh(questions, usedSet, bankSet);
      if (!fresh.length) fresh = questions;
      if (!fresh.length) fresh = builtinSeed();   // absolute last resort — never stall
      const patch = {};
      fresh.forEach((q, i) => (patch[i] = q));
      await fbPut(env, "trivia/global/bank", patch);
      const game = await fbGet(env, "trivia/global/game").catch(() => null);
      await fbPut(env, "trivia/global/game", {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen: fresh.length,
        startedAt: game?.startedAt || Date.now(),
      });
      await markUsed(env, fresh);
      // Kick off AI generation in the background (doesn't block the response)
      ctxWait(ctx, env, count, usedRaw);
      return json({ bankLen: fresh.length, source: fresh.length ? "ai" : "seed" });
    }

    // Bank low → generate fresh batches via opencode.ai (avoiding repeats).
    // Loop up to 3 rounds of BANK_BATCH so we can also CATCH UP when the bank
    // is already behind the live slot (e.g. after a long downtime or deploy).
    await fbPut(env, "trivia/global/meta", { generating: Date.now(), used: usedRaw });
    const game0 = (await fbGet(env, "trivia/global/game").catch(() => null)) || {};
    const globalSlot = game0.questionStart ? Math.floor((Date.now() - game0.questionStart) / SLOT_DURATION) : 0;

    // Live slot has caught up with the bank → the game is stuck. Hard-reset:
    // reuse the bank, restart the clock. Never leave players on
    // "Preparing new questions…".
    if (globalSlot >= len) {
      const res = await hardReset(env, bank, len, usedRaw);
      await fbPatch(env, "trivia/global/meta", { lastReset: Date.now() }).catch(() => {});
      return res;
    }

    const need = Math.max(count, Math.min(60, globalSlot - len + TOP_UP_THRESHOLD));

    const allAccepted = [];
    let fromStatic = false;
    for (let round = 0; round < 3 && allAccepted.length < need; round++) {
      const want = Math.min(BANK_BATCH, need - allAccepted.length);
      let batch;
      try {
        batch = await generateQuestions(want, env, usedRaw);
      } catch (err) {
        console.error("[Trivia] opencode.ai failed, using built-in:", err.message);
        batch = null;
      }
      if (!batch || !batch.length) {
        batch = pickQuestions(want, usedRaw);
        fromStatic = true;
      }
      let fresh = filterFresh(batch, usedSet, bankSet);
      if (!fresh.length) fresh = batch;   // never stall the game
      if (!fresh.length) break;
      const patch = {};
      fresh.forEach((q, i) => (patch[len + allAccepted.length + i] = q));
      await fbPatch(env, "trivia/global/bank", patch);
      fresh.forEach((q) => q?.question && bankSet.add(norm(q.question)));
      allAccepted.push(...fresh);
    }
    if (!allAccepted.length) {
      // bank full of used static questions and AI failed — wait for next attempt
      await fbPut(env, "trivia/global/meta", { generating: 0, used: usedRaw });
      return json({ bankLen: len, skipped: true });
    }
    await markUsed(env, allAccepted);
    const bankLen = len + allAccepted.length;

    if (bankLen > BANK_MAX) {
      // Bank too big → reset: fresh bank + restart the question clock
      const patch = {};
      allAccepted.forEach((q, i) => (patch[i] = q));
      await fbPut(env, "trivia/global/bank", patch);
      await fbDelete(env, "trivia/global/answers").catch(() => {});
      await fbPut(env, "trivia/global/game", {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen: allAccepted.length,
        startedAt: Date.now(),
      });
      await fbPut(env, "trivia/global/meta", { generating: 0, used: (await readUsed(env)) });
      return json({ bankLen: allAccepted.length, reset: true, source: fromStatic ? "seed" : "ai" });
    }

    const game = await fbGet(env, "trivia/global/game").catch(() => null);
    if (game) {
      await fbPatch(env, "trivia/global/game", { bankLen });
    } else {
      await fbPut(env, "trivia/global/game", {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen,
        startedAt: Date.now(),
      });
    }
    await fbPut(env, "trivia/global/meta", { generating: 0, used: (await readUsed(env)) });
    return json({ bankLen, source: fromStatic ? "bank" : "ai" });
  } catch (err) {
    console.error("[Trivia] error:", err.message);
    await fbPut(env, "trivia/global/meta", { generating: 0 }).catch(() => {});
    return json({ error: err.message }, 500);
  }
}

// Background AI top-up (used when seeding) — run after the response is sent.
function ctxWait(ctx, env, count, usedRaw) {
  ctx?.waitUntil?.(
    (async () => {
      try {
        const used = (await readUsed(env)).slice();
        const usedSet = new Set(used.map(norm));
        const bank = (await fbGet(env, "trivia/global/bank").catch(() => null)) || {};
        const len = bankCount(bank);
        const bankSet = new Set(Object.values(bank).filter((q) => q?.question).map((q) => norm(q.question)));
        let questions;
        try {
          questions = await generateQuestions(count, env, used);
        } catch (err) {
          console.error("[Trivia] bg opencode.ai failed:", err.message);
          await fbPut(env, "trivia/global/meta", { generating: 0, lastError: err.message }).catch(() => {});
          return;
        }
        const fresh = filterFresh(questions, usedSet, bankSet);
        if (!fresh.length) {
          await fbPut(env, "trivia/global/meta", { generating: 0 }).catch(() => {});
          return;
        }
        const patch = {};
        fresh.forEach((q, i) => (patch[len + i] = q));
        await fbPatch(env, "trivia/global/bank", patch);
        const game = await fbGet(env, "trivia/global/game").catch(() => null);
        if (game) await fbPatch(env, "trivia/global/game", { bankLen: len + fresh.length });
        await markUsed(env, fresh);
        await fbPut(env, "trivia/global/meta", { generating: 0, used: (await readUsed(env)) }).catch(() => {});
        console.log("[Trivia] bg top-up appended", fresh.length);
      } catch (err) {
        console.error("[Trivia] bg top-up error:", err.message);
        await fbPut(env, "trivia/global/meta", { generating: 0, lastError: err.message }).catch(() => {});
      }
    })()
  );
}

// ── /api/time — clock sync for question timing ──────────────────────────────
async function handleTime(request, env) {
  const game = await fbGet(env, "trivia/global/game").catch(() => null);
  return json({ now: Date.now(), game: game || null });
}

// ── Firebase proxies (Dice Arena pattern) ───────────────────────────────────
function upstreamUrl(env, pathAfter, search) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  const u = new URL(`https://${host}${pathAfter}`);
  u.search = search;
  return u;
}

async function restProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("cf-connecting-ip");
  headers.set("origin", url.origin);
  // Honor X-Fb-Method (client fallback for sandboxes that block PUT/PATCH/DELETE)
  const method = headers.get("x-fb-method") || request.method;
  headers.delete("x-fb-method");
  const init = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }
  const res = await fetch(target, init);
  if (!url.pathname.startsWith("/firebase/trivia/global/meta/logs")) {
    logRequest(env, method, url.pathname, res.status);
  }
  const outHeaders = new Headers(res.headers);
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("Access-Control-Allow-Origin", url.origin);
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

async function sseProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase\/stream/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const upstream = await fetch(target, { headers: { Accept: "text/event-stream" } });
  if (!upstream.ok || !upstream.body) {
    return json({ error: `upstream ${upstream.status}` }, upstream.status);
  }
  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  headers.set("Access-Control-Allow-Origin", url.origin);
  return new Response(upstream.body, { status: 200, headers });
}

// ── Request diagnostics (ring buffer in Firebase, for debugging) ────────────
let logBuffer = [];
let logFlushing = false;
function logRequest(env, method, path, status) {
  logBuffer.push({ m: method, p: path.slice(0, 60), s: status, t: Date.now() });
  if (logBuffer.length > 30) logBuffer.shift();
  if (logFlushing) return;
  logFlushing = true;
  ctxWaitSafe(env, () => {
    try {
      return fbPut(env, "trivia/global/meta/logs", logBuffer.slice(-25));
    } finally {
      logFlushing = false;
    }
  });
}
function ctxWaitSafe(env, fn) {
  // fire-and-forget; never throws
  fn().catch(() => {});
}

// ── Static assets (inlined at build time by build.js) ───────────────────────
// Each value is replaced by a JSON string literal of the file contents.
// NOTE: do not wrap these in backticks — the files contain backticks of
// their own (template literals), which would break the outer literal.
const STATIC = {
  "index.html": __INDEX_HTML__,
  "style.css": __STYLE_CSS__,
  "discord.js": __DISCORD_JS__,
  "firebase.js": __FIREBASE_JS__,
  "app.js": __APP_JS__,
  "support.js": __SUPPORT_JS__,
  "vendor/discord-sdk.mjs": __VENDOR_DISCORD_SDK_MJS__,
  "privacy.html": __PRIVACY_HTML__,
  "terms.html": __TERMS_HTML__,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/firebase/stream/")) return await sseProxy(request, env, url);
      if (path.startsWith("/firebase/")) return await restProxy(request, env, url);
      if (path === "/api/exchange" && request.method === "POST") return await handleExchange(request, env);
      if (path === "/api/trivia") return await handleTrivia(request, env, ctx);
      if (path === "/api/time") return await handleTime(request, env);
      if (path === "/privacy") return html(STATIC["privacy.html"]);
      if (path === "/terms") return html(STATIC["terms.html"]);
      if (path === "/support") return await handleSupport();
      if (path === "/" || path === "") {
        return html(STATIC["index.html"]);
      }
      const assetPath = path.slice(1);
      const content = STATIC[assetPath];
      if (content !== undefined) {
        const ext = "." + (assetPath.split(".").pop() || "");
        return new Response(content, {
          headers: { "Content-Type": CONTENT_TYPES[ext] || "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      return notFound();
    } catch (err) {
      console.error("[TriviaRumbleElite] error:", err.message);
      return json({ error: "Internal error" }, 500);
    }
  },
};
