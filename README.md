# 🎮 Trivia Rumble Elite

**Fast-paced multiplayer trivia for Discord Activities — and the browser.**

Up to 10 players compete in the same room answering trivia questions with
speed bonuses. Fastest correct answer = most points. Host picks the category
(General, Science, History, Geography, Entertainment, Sports, Technology,
Art, Literature, Music), starts the game, and the app auto-advances through
10 questions with 15 seconds each.

**Live:** https://trivia-rumble-elite.walusimbileon1.workers.dev
**Repo:** https://github.com/Walusimbi-Leon1/trivia-rumble-4

## 🎮 How to Play

1. **Create or join a room** — inside a Discord voice channel, everyone in the
   channel shares the same room automatically. In a browser, copy the invite
   link from the lobby and share it.
2. **Host picks a category** and hits **Start Game**.
3. **10 questions, 15 seconds each.** Answer fast — the quicker you answer
   correctly, the more points you get (max 100, min 10).
4. **Top score wins!** The host can hit **Play Again** for a rematch.

## 🛠️ Architecture

Built on the **proven Discord Activity pattern** from Dice Arena / Arrow Blast:

- **Vanilla HTML/CSS/JS** — no build step, no framework. Everything is served
  by a single Cloudflare Worker.
- **Discord integration** (`src/discord.js`) — vendored same-origin
  `@discord/embedded-app-sdk` (Discord's Activity sandbox blocks external
  hosts), `authorize()` handles both result shapes (public client PKCE →
  `access_token` directly; confidential client → code exchanged via
  `/api/exchange`), with graceful guest fallback when not in Discord.
- **Data layer** (`src/firebase.js`) — Firebase Realtime Database accessed
  ONLY through the worker's same-origin proxy (`/firebase/*` REST +
  `/firebase/stream/*` SSE), because the Discord sandbox blocks direct
  `firebaseio.com` calls. Works identically in Discord and browsers.
- **Questions** (`/api/trivia`) — built-in question bank (10 categories × 16
  questions), with optional Groq AI generation when `GROQ_API_KEY` is set
  (falls back to the bank automatically).

## 🚀 Deploy

```bash
node build.js        # inlines src/* into dist/worker.js
wrangler deploy      # requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

Environment variables (wrangler.toml / [vars]):

| Var | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | Discord application client ID (from the Developer Portal) |
| `DISCORD_CLIENT_SECRET` | Discord application client secret |
| `REDIRECT_URI` | OAuth redirect URI — the worker's own URL (e.g. `https://trivia-rumble-elite.walusimbileon1.workers.dev/`) |
| `GROQ_API_KEY` | *Optional* — enables AI-generated questions |
| `FB_HOST` | Firebase RTDB host (defaults to `pop-party-1-default-rtdb.firebaseio.com`) |

## 📋 Discord Developer Portal setup

1. Create an application named **Trivia Rumble Elite**.
2. Under **OAuth2**, add the redirect URL: `https://trivia-rumble-elite.walusimbileon1.workers.dev/`
3. In the app's **General Information** → **Activity**, add the worker URL as
   the Activity URL (e.g. `https://trivia-rumble-elite.walusimbileon1.workers.dev/`).
4. Send the client ID and client secret to LA5 to configure the worker vars.

## 📄 Files

- `src/` — client source (HTML, CSS, JS, vendored Discord SDK)
- `worker.js` — Cloudflare Worker source (routes, OAuth exchange, trivia API, Firebase proxies)
- `build.js` — inlines `src/*` into `dist/worker.js`
- `deploy.sh` / `wrangler.toml` — deployment

---
*Trivia Rumble Elite — formerly trivia-rumble-4. Not affiliated with Discord Inc.*
