#!/usr/bin/env node
/**
 * Trivia Rumble Elite — batch question generator (GitHub Actions)
 *
 * Generates a bundle of trivia questions with opencode.ai (big-pickle) and
 * writes them straight into the Firebase Realtime Database bank that the
 * game worker reads. Runs on a schedule (every 30 min) so the game never
 * runs out of questions.
 *
 * Why not generate in the worker? The worker's per-request generation gets
 * throttled/truncated (big-pickle is a reasoning model — it spends thousands
 * of tokens on hidden reasoning, so a 20-question JSON with max_tokens 4096
 * gets cut off). Batch generation here:
 *   - uses a big token budget and small chunks → valid JSON every time
 *   - runs from GitHub runners (fresh IPs, no rate-limit history)
 *   - top-ups the shared Firebase bank directly (public-writable RTDB)
 *
 * Bank math: the game clock runs 24/7 at 20s/question → drains ~180
 * questions/hour. This script keeps bankLen − currentSlot ≈ RUNWAY (350),
 * i.e. ~2 hours of runway. Scheduled every 30 min that's plenty of margin.
 *
 * Modes:
 *   - APPEND: generate `want` fresh questions, append at the end of the
 *     bank, bump game.bankLen. The bank NEVER resets or shrinks — every
 *     question ever generated stays stored (Leon's rule). If the game is
 *     badly behind (slot past the bank end), we still just append a big
 *     batch; the worker's hardReset recycles the stored questions in the
 *     meantime, so the game never stalls and nothing is ever deleted.
 *
 * Exit codes: 0 = ok (may be "nothing to do"), 1 = failure (workflow alert).
 */

const SLOT_DURATION = 20000; // 20s per question (matches worker)
const RUNWAY = 350; // target: bankLen − slot after a run
const MIN_ADD = 60; // skip unless we'd add at least this many
const MAX_APPEND = 400; // max questions per run even when far behind
const CHUNK = 40; // questions per API call (reliable JSON output)
const MAX_TOKENS = 24000; // big budget: reasoning + 40 questions fits
const USED_MAX = 600; // keep this many past questions (matches worker)
const AVOID_N = 40; // how many past questions to send as "do not repeat"
const MAX_ATTEMPTS = 8; // max API calls per run
const API_TIMEOUT_MS = 240000;

const BASE_URL = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1";
const MODEL = process.env.MODEL || "big-pickle";
const FB_HOST = (process.env.FB_HOST || "pop-party-1-default-rtdb.firebaseio.com").replace(/^https?:\/\//, "");
const P = "trivia/global"; // RTDB namespace path

const API_KEY = process.env.OPENCODE_API_KEY;
if (!API_KEY) {
  console.error("OPENCODE_API_KEY not set");
  process.exit(1);
}

// ── Firebase helpers ────────────────────────────────────────────────────────
const fbUrl = (path) => `https://${FB_HOST}/${path}.json`;

async function fbGet(path) {
  const res = await fetch(fbUrl(path), { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`fbGet ${path} → ${res.status}`);
  return res.json();
}
async function fbPut(path, data) {
  const res = await fetch(fbUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbPut ${path} → ${res.status}`);
  return res.json();
}
async function fbPatch(path, data) {
  const res = await fetch(fbUrl(path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbPatch ${path} → ${res.status}`);
  return res.json();
}
async function fbDelete(path) {
  const res = await fetch(fbUrl(path), {
    method: "DELETE",
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbDelete ${path} → ${res.status}`);
}

// ── Question generation ─────────────────────────────────────────────────────
function norm(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function generateChunk(count, avoidTexts, attempt) {
  const avoid =
    avoidTexts && avoidTexts.length
      ? "\n\nHere are recently used questions. Do NOT repeat these or closely paraphrase them — make every question fresh and distinct:\n" +
        avoidTexts.map((t) => `- ${t}`).join("\n")
      : "";
  const prompt = `Generate ${count} unique trivia questions spanning a fun mix of categories: science, history, geography, entertainment, sports, technology, general knowledge. Vary the difficulty.${avoid}
Return ONLY a JSON array (no markdown, no reasoning text) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0}]
"correctAnswer" must be the index (0-3) of the correct option.`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a trivia question generator. Generate engaging, factual trivia questions with exactly 4 answer options and one correct answer. Always respond with valid JSON only — no markdown, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (res.status === 429) throw new Error(`rate limited (attempt ${attempt})`);
  if (!res.ok) throw new Error(`opencode.ai ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("empty content from model");

  // Strip markdown fences if the model was stubborn
  const cleaned = content.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array in response");

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response is not an array");

  const out = [];
  for (const q of parsed) {
    if (typeof q?.question !== "string" || !Array.isArray(q?.options) || q.options.length !== 4) continue;
    let a = q.correctAnswer;
    if (typeof a === "string") a = parseInt(a, 10);
    if (typeof a !== "number" || a < 0 || a > 3) continue;
    out.push({ question: q.question, options: q.options.map(String), correctAnswer: a });
  }
  return out;
}

async function generateFresh(want, usedTexts, bankTexts) {
  const avoidTexts = usedTexts.slice(-AVOID_N);
  const usedSet = new Set(usedTexts.map(norm));
  const bankSet = new Set((bankTexts || []).map(norm));
  const accepted = [];
  const seen = new Set();
  let attempts = 0;

  while (accepted.length < want && attempts < MAX_ATTEMPTS) {
    attempts++;
    const n = Math.min(CHUNK, want - accepted.length);
    let batch;
    try {
      batch = await generateChunk(n, avoidTexts, attempts);
    } catch (err) {
      console.warn(`  chunk ${attempts}: ${err.message}`);
      if (attempts >= 3) await new Promise((r) => setTimeout(r, 5000 * attempts)); // back off on repeated failures
      continue;
    }
    const fresh = batch.filter((q) => {
      const key = norm(q.question);
      if (usedSet.has(key) || bankSet.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    accepted.push(...fresh);
    console.log(`  chunk ${attempts}: got ${batch.length} raw, ${fresh.length} fresh (total ${accepted.length}/${want})`);
  }
  return accepted;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const meta = (await fbGet(`${P}/meta`).catch(() => null)) || {};
  const game = (await fbGet(`${P}/game`).catch(() => null)) || {};
  const bank = (await fbGet(`${P}/bank`).catch(() => null)) || {};
  const usedRaw = Array.isArray(meta.used) ? meta.used : [];

  const len = Object.keys(bank).length;
  const now = Date.now();
  const slot = game.questionStart ? Math.floor((now - game.questionStart) / SLOT_DURATION) : 0;
  const margin = len - slot;

  console.log(
    JSON.stringify({ bankLen: len, slot, margin, used: usedRaw.length, questionStart: game.questionStart || null, mode: "—" })
  );

  const raw = RUNWAY - margin;
  if (raw <= 0) {
    console.log(`Bank healthy (margin ${margin} ≥ ${RUNWAY}) — nothing to do.`);
    return;
  }
  const want = Math.min(MAX_APPEND, Math.max(MIN_ADD, raw));

  console.log(`Mode: APPEND — generating up to ${want} questions...`);
  const bankTexts = Object.values(bank).filter((q) => q?.question).map((q) => q.question);
  const fresh = await generateFresh(want, usedRaw, bankTexts);
  if (!fresh.length) throw new Error("generated 0 fresh questions after retries");

  // Lock the bank (worker honors meta.generating and won't top-up concurrently)
  await fbPut(`${P}/meta`, { generating: Date.now(), used: usedRaw });

  const patch = {};
  fresh.forEach((q, i) => (patch[len + i] = q));
  await fbPatch(`${P}/bank`, patch);
  if (game && game.questionStart) {
    await fbPatch(`${P}/game`, { bankLen: len + fresh.length });
  } else {
    // First-ever seed: start the question clock too (the old RESET path did
    // this; append-only must still boot a fresh game).
    await fbPut(`${P}/game`, {
      questionStart: now,
      slotDuration: SLOT_DURATION,
      bankLen: len + fresh.length,
      startedAt: now,
    });
  }
  console.log(`APPEND done: ${fresh.length} added (bank ${len} → ${len + fresh.length}).`);

  // Record used (FIFO, capped)
  const newUsed = [...usedRaw, ...fresh.map((q) => q.question)].slice(-USED_MAX);
  await fbPut(`${P}/meta`, { generating: 0, used: newUsed });

  console.log("Done. New margin ≈", len + fresh.length - slot);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
