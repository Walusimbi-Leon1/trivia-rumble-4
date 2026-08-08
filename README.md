# 🎮 Trivia Rumble Elite

**Fast-paced multiplayer trivia for Discord Activities — and the browser.**

One global arena. Every player who opens the game sees the **same question at
the same time** — 20 seconds each, rotating continuously. Answer fast: the
first correct answer scores the most (100 pts, minus 5 per second, min 10).

**Live:** https://trivia-rumble-elite.walusimbileon1.workers.dev
**Repo:** https://github.com/Walusimbi-Leon1/trivia-rumble-4

## 🎮 How to Play

1. **Open the game** — in a Discord voice channel via the Activities menu, or
   in any browser. There is **no room setup**: everyone plays together in the
   one global arena. A single player can start immediately.
2. **Questions rotate automatically** — same question for everyone, 20 seconds
   on the clock. Pick the right answer before time runs out.
3. **Speed scoring** — the first player to answer correctly gets the most
   points. Wrong or missed answers score nothing.
4. **Leaderboard** — top 20 players by score, live. Your name, avatar and
   score persist in Firebase: leave and come back later, your score is still
   there.

## 🛠️ Architecture

Built on the proven Discord Activity pattern (Dice Arena / Arrow Blast):

- **Single global room** — all game state lives under `trivia/global` in
  Firebase Realtime Database:
  - `game` — `{ questionStart, slotDuration, bankLen }`
  - `bank/<i>` — question bank (question + options + correct answer)
  - `players/<uid>` — **persistent** player records (score survives leaving)
  - `answers/<slot>/<uid>` — per-question answers
- **Deterministic question timing** — every client computes the current
  question from shared state: `slot = floor((now - questionStart) / 20s)`,
  `question = bank[slot % bank.length]`. All players see the same question at
  the same time, with clock sync via `/api/time`.
- **Question generation (GitHub Actions)** — the game clock drains ~180
  questions/hour (20s each, runs 24/7). A scheduled workflow
  (`.github/workflows/generate-questions.yml`) generates fresh questions in
  batches with **opencode.ai (big-pickle model)** every 30 minutes and writes
  them straight into the Firebase bank, keeping ~2 hours of runway. It runs
  from GitHub runners because **opencode.ai blocks Cloudflare Workers egress**
  (error 1042) — the worker itself can never reach it. The worker keeps a
  built-in bank as emergency fallback, and resets the question clock when the
  game is badly behind (instant recovery from "Preparing new questions…").
  Manual refill: `Actions → Generate Trivia Questions → Run workflow`.
  Repo secret: `OPENCODE_API_KEY`.
- **Discord integration** — vendored same-origin `@discord/embedded-app-sdk`,
  `authorize()` handles both OAuth shapes (PKCE access_token directly, or
  confidential code → `/api/exchange`), timeouts, and graceful guest fallback.
- **Data layer** — Firebase accessed only through the worker's same-origin
  proxy (`/firebase/*` REST + `/firebase/stream/*` SSE), because the Discord
  sandbox blocks direct `firebaseio.com` calls.

## 🚀 Deploy

```bash
node build.js        # inlines src/* into dist/worker.js
wrangler deploy      # requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

Environment variables (wrangler.toml / [vars]):

| Var | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | Discord application client ID |
| `DISCORD_CLIENT_SECRET` | Discord application client secret |
| `REDIRECT_URI` | OAuth redirect — the worker's own URL, must match the Discord portal registration exactly |
| `OPENCODE_API_KEY` | opencode.ai API key (question generation) |
| `MODEL` | Model name, e.g. `big-pickle` |
| `FB_HOST` | Firebase RTDB host (defaults to `pop-party-1-default-rtdb.firebaseio.com`) |

## 📋 Discord Developer Portal setup

1. Application named **Trivia Rumble Elite** (created — client ID
   `1535428947624460328`).
2. **OAuth2 → Redirects**: add `https://trivia-rumble-elite.walusimbileon1.workers.dev`
3. **General Information → Activity**: set the Activity URL to
   `https://trivia-rumble-elite.walusimbileon1.workers.dev/`
4. Invite the app to a server and launch the Activity from a voice channel.

## 📄 Files

- `src/` — client source (HTML, CSS, JS, vendored Discord SDK)
- `worker.js` — Cloudflare Worker source (routing, OAuth exchange, question
  generation, Firebase proxies)
- `build.js` — inlines `src/*` into `dist/worker.js`
- `deploy.sh` / `wrangler.toml` — deployment

---
*Trivia Rumble Elite — formerly trivia-rumble-4. Not affiliated with Discord Inc.*
