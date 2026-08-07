/**
 * Trivia Rumble Elite 🎮 — main game logic
 *
 * Ported from the trivia-rumble-4 React app to the proven vanilla
 * architecture used by Dice Arena / Arrow Blast (single worker, static
 * client, Firebase via same-origin proxy). Host-driven game flow:
 *   lobby → playing (15s/question, speed bonus) → results → play again
 */

import { initDiscord, isDiscord, channelId as discordChannelId } from "./discord.js";
import { dbRead, dbWrite, dbUpdate, dbDelete, dbWatch } from "./firebase.js";

// ── Constants ────────────────────────────────────────────────────────────────
const QUESTION_DURATION = 15000; // 15 seconds per question
const RESULT_DISPLAY_TIME = 3000; // 3s to show result before next question
const QUESTION_COUNT = 10;

const CATEGORIES = [
  { value: "general", label: "General Knowledge" },
  { value: "science", label: "Science" },
  { value: "history", label: "History" },
  { value: "geography", label: "Geography" },
  { value: "entertainment", label: "Entertainment" },
  { value: "sports", label: "Sports" },
  { value: "technology", label: "Technology" },
  { value: "art", label: "Art" },
  { value: "literature", label: "Literature" },
  { value: "music", label: "Music" },
];

// ── State ────────────────────────────────────────────────────────────────────
let me = { id: null, username: "Guest", avatarUrl: "" };
let room = null;          // cached room object (from SSE patches)
let roomId = null;
let es = null;            // EventSource
let timerInterval = null;
let advanceTimeout = null;
let advanceQ = null;      // key of question the advance timer is scheduled for

// per-question local state
let myAnswer = null;      // this client's answer index for current question
let hasAnswered = false;
let revealed = false;
let lastQStart = null;

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}
function avatarHtml(player, size = 40) {
  const name = escapeHtml(initials(player?.username));
  if (player?.avatarUrl) {
    return `<img class="avatar" style="width:${size}px;height:${size}px" src="${escapeHtml(player.avatarUrl)}" alt="" onerror="this.outerHTML='<span class=&quot;avatar avatar-fallback&quot; style=&quot;width:${size}px;height:${size}px&quot;>${name}</span>'">`;
  }
  return `<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px">${name}</span>`;
}

function showScreen(name) {
  ["loading", "error", "lobby", "question", "results"].forEach((s) => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle("hidden", s !== name);
  });
}

// ── Firebase helpers ─────────────────────────────────────────────────────────
function playerPath(uid) {
  return `trivia/rooms/${roomId}/players/${uid}`;
}

// ── SSE patching ─────────────────────────────────────────────────────────────
function setPath(obj, path, value) {
  const parts = path.split("/").filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = value;
}

function onRoomPatch(relPath, data) {
  if (!room) return;
  if (relPath === "/" || relPath === "") {
    room = data && typeof data === "object" ? data : null;
  } else {
    setPath(room, relPath, data);
  }
  if (!room) {
    createRoom().catch(console.error); // room was deleted — recreate as host
    return;
  }
  promoteHostIfNeeded();
  render();
  scheduleAdvance();
}

function promoteHostIfNeeded() {
  if (!room) return;
  const players = Object.values(room.players || {});
  if (!players.length) return;
  const hostAlive = room.hostId && room.players[room.hostId];
  if (!hostAlive) {
    const next = players[0];
    dbUpdate(`trivia/rooms/${roomId}`, { hostId: next.id }).catch(() => {});
    dbUpdate(playerPath(next.id), { isHost: true }).catch(() => {});
  }
}

// ── Room lifecycle ───────────────────────────────────────────────────────────
async function joinOrCreateRoom() {
  const existing = await dbRead(`trivia/rooms/${roomId}`);
  if (existing && existing.id) {
    room = existing;
    if (!room.players || !room.players[me.id]) {
      await dbUpdate(playerPath(me.id), {
        id: me.id,
        username: me.username,
        avatarUrl: me.avatarUrl,
        score: 0,
        currentAnswer: null,
        answerTime: null,
        isHost: false,
        online: true,
      });
    } else {
      await dbUpdate(playerPath(me.id), { online: true, username: me.username, avatarUrl: me.avatarUrl });
    }
  } else {
    await createRoom();
  }
  subscribeRoom();
}

async function createRoom() {
  room = {
    id: roomId,
    hostId: me.id,
    status: "lobby",
    players: {
      [me.id]: {
        id: me.id,
        username: me.username,
        avatarUrl: me.avatarUrl,
        score: 0,
        currentAnswer: null,
        answerTime: null,
        isHost: true,
        online: true,
      },
    },
    questions: [],
    currentQuestionIndex: 0,
    questionStartTime: null,
    category: "general",
    createdAt: Date.now(),
  };
  await dbWrite(`trivia/rooms/${roomId}`, room);
}

function subscribeRoom() {
  es = dbWatch(`trivia/rooms/${roomId}`, onRoomPatch);
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
}

async function leaveRoom() {
  try {
    if (me.id && roomId) {
      await dbDelete(playerPath(me.id));
      const current = await dbRead(`trivia/rooms/${roomId}`);
      if (current && current.players && !Object.keys(current.players).length) {
        await dbDelete(`trivia/rooms/${roomId}`);
      }
    }
  } catch (e) {
    /* best effort */
  }
  if (es) es.close();
}

// ── Game actions ─────────────────────────────────────────────────────────────
async function startGame() {
  if (!room || me.id !== room.hostId) return;
  setLobbyLoading(true);
  try {
    const res = await fetch("/api/trivia", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: room.category, count: QUESTION_COUNT }),
    });
    if (!res.ok) throw new Error("Failed to generate questions");
    const { questions } = await res.json();
    if (!questions || !questions.length) throw new Error("No questions returned");

    await dbUpdate(`trivia/rooms/${roomId}`, { questions, status: "playing" });
    await startQuestion(0);
  } catch (err) {
    console.error("Failed to start game:", err);
    showError("Failed to generate trivia questions. Please try again.");
  } finally {
    setLobbyLoading(false);
  }
}

async function startQuestion(idx) {
  await dbUpdate(`trivia/rooms/${roomId}`, {
    currentQuestionIndex: idx,
    questionStartTime: Date.now(),
  });
  const players = Object.values(room?.players || {});
  for (const p of players) {
    await dbUpdate(playerPath(p.id), { currentAnswer: null, answerTime: null });
  }
}

async function submitAnswer(answerIndex, timeElapsed) {
  await dbUpdate(playerPath(me.id), {
    currentAnswer: String(answerIndex),
    answerTime: timeElapsed,
  });

  // Correct answers get a speed bonus (max 100, min 10)
  const q = room?.questions?.[room.currentQuestionIndex];
  if (q && answerIndex === q.correctAnswer) {
    const bonus = Math.max(10, Math.floor(100 * (1 - timeElapsed / QUESTION_DURATION)));
    const currentScore = room?.players?.[me.id]?.score || 0;
    await dbUpdate(playerPath(me.id), { score: currentScore + bonus });
  }
}

async function playAgain() {
  const players = Object.values(room?.players || {});
  for (const p of players) {
    await dbUpdate(playerPath(p.id), { score: 0, currentAnswer: null, answerTime: null });
  }
  await dbUpdate(`trivia/rooms/${roomId}`, {
    status: "lobby",
    currentQuestionIndex: 0,
    questionStartTime: null,
    questions: [],
  });
}

// ── Host auto-advance ────────────────────────────────────────────────────────
function scheduleAdvance() {
  if (!room || me.id !== room.hostId || room.status !== "playing") {
    clearTimeout(advanceTimeout);
    advanceTimeout = null;
    advanceQ = null;
    return;
  }
  const qKey = (room.currentQuestionIndex ?? 0) + ":" + (room.questionStartTime || 0);
  if (qKey !== advanceQ) {
    advanceQ = qKey;
    clearTimeout(advanceTimeout);
    advanceTimeout = null;
  }
  if (advanceTimeout) return; // already scheduled for this question

  const players = Object.values(room.players || {});
  const allAnswered = players.length > 0 && players.every((p) => p.currentAnswer !== null);
  const elapsed = room.questionStartTime ? Date.now() - room.questionStartTime : 0;

  if (elapsed >= QUESTION_DURATION + RESULT_DISPLAY_TIME) {
    advance();
    return;
  }
  if (allAnswered) {
    advanceTimeout = setTimeout(advance, RESULT_DISPLAY_TIME);
    return;
  }
  advanceTimeout = setTimeout(advance, QUESTION_DURATION + RESULT_DISPLAY_TIME - elapsed + 50);
}

async function advance() {
  clearTimeout(advanceTimeout);
  advanceTimeout = null;
  if (!room || me.id !== room.hostId || room.status !== "playing") return;
  const nextIndex = room.currentQuestionIndex + 1;
  if (nextIndex >= (room.questions || []).length) {
    await dbUpdate(`trivia/rooms/${roomId}`, { status: "results" });
  } else {
    await startQuestion(nextIndex);
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  if (!room) return;
  switch (room.status) {
    case "lobby":
      renderLobby();
      showScreen("lobby");
      break;
    case "playing":
      renderQuestion();
      showScreen("question");
      break;
    case "results":
      renderResults();
      showScreen("results");
      break;
    default:
      showScreen("loading");
  }
  updateHeader();
}

function updateHeader() {
  $("header-me").innerHTML =
    avatarHtml(me, 28) +
    `<span class="me-name">${escapeHtml(me.username)}</span>` +
    `<span class="tag ${isDiscord ? "tag-discord" : "tag-browser"}">${isDiscord ? "DISCORD" : "BROWSER"}</span>`;
}

function renderLobby() {
  const players = Object.values(room.players || {});
  const isHost = room.hostId === me.id;
  $("lobby-room-code").value = roomId;
  $("lobby-copy-link").textContent = isDiscord ? "Copy room ID" : "Copy invite link";
  $("lobby-player-count").textContent = `Players (${players.length})`;
  $("lobby-players").innerHTML = players.length
    ? players.map((p) => `
        <div class="player-row ${p.id === me.id ? "me" : ""}">
          ${avatarHtml(p)}
          <span class="player-name">${escapeHtml(p.username)}${p.id === me.id ? ' <em>(You)</em>' : ""}</span>
          ${p.isHost ? '<span class="crown" title="Host">👑</span>' : ""}
        </div>`).join("")
    : '<p class="muted center">No players yet…</p>';

  $("lobby-categories").innerHTML = CATEGORIES.map((c) => `
    <button class="cat-btn ${room.category === c.value ? "active" : ""}" data-cat="${c.value}">${escapeHtml(c.label)}</button>`).join("");

  $("lobby-host-controls").classList.toggle("hidden", !isHost);
  $("lobby-guest-controls").classList.toggle("hidden", isHost);
  $("btn-start").classList.toggle("hidden", !isHost);
  $("lobby-nonhost-category").textContent = CATEGORIES.find((c) => c.value === room.category)?.label || "General Knowledge";
}

function setLobbyLoading(loading) {
  const btn = $("btn-start");
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spinner"></span> Generating Questions…' : "⚡ Start Game";
}

function renderQuestion() {
  const q = room.questions?.[room.currentQuestionIndex];
  if (!q) return;

  // New question → reset local answer state
  if (lastQStart !== room.questionStartTime) {
    lastQStart = room.questionStartTime;
    myAnswer = null;
    hasAnswered = false;
    revealed = false;
    clearInterval(timerInterval);
  }

  const players = Object.values(room.players || {});
  const answeredCount = players.filter((p) => p.currentAnswer !== null).length;
  $("q-number").textContent = `Question ${room.currentQuestionIndex + 1} / ${room.questions.length}`;
  $("q-answered").textContent = `${answeredCount}/${players.length} answered`;
  $("q-text").textContent = q.question;

  const opts = q.options.map((opt, i) => {
    let cls = "opt-btn";
    if (revealed) {
      if (i === q.correctAnswer) cls += " correct";
      else if (i === myAnswer) cls += " wrong";
      else cls += " dimmed";
    }
    return `<button class="${cls}" data-idx="${i}" ${hasAnswered ? "disabled" : ""}>
      <span class="opt-letter">${String.fromCharCode(65 + i)}</span>
      <span class="opt-text">${escapeHtml(opt)}</span>
    </button>`;
  }).join("");
  $("q-options").innerHTML = opts;

  document.querySelectorAll(".opt-btn").forEach((btn) => {
    btn.onclick = () => handleAnswer(Number(btn.dataset.idx));
  });

  if (revealed) {
    const box = $("q-result");
    box.classList.remove("hidden");
    box.classList.toggle("good", myAnswer === q.correctAnswer);
    box.classList.toggle("bad", myAnswer !== q.correctAnswer);
    box.innerHTML = myAnswer === q.correctAnswer
      ? "✅ Correct!"
      : myAnswer === -1
        ? `⏰ Time's up! The answer was: ${escapeHtml(q.options[q.correctAnswer])}`
        : `❌ Wrong! The answer was: ${escapeHtml(q.options[q.correctAnswer])}`;
  } else {
    $("q-result").classList.add("hidden");
  }

  startTimer();
}

function startTimer() {
  clearInterval(timerInterval);
  if (!room.questionStartTime) return;
  const tick = () => {
    const remaining = Math.max(0, room.questionStartTime + QUESTION_DURATION - Date.now());
    const pct = (remaining / QUESTION_DURATION) * 100;
    $("q-progress").style.width = pct + "%";
    $("q-progress").classList.toggle("danger", remaining < 5000);
    $("q-time").textContent = Math.ceil(remaining / 1000) + "s";
    $("q-time").classList.toggle("danger", remaining < 5000);
    if (remaining <= 0 && !hasAnswered) {
      handleAnswer(-1); // time's up → auto-submit wrong
    }
  };
  tick();
  timerInterval = setInterval(tick, 100);
}

async function handleAnswer(idx) {
  if (hasAnswered) return;
  hasAnswered = true;
  myAnswer = idx;
  const timeElapsed = Date.now() - room.questionStartTime;
  await submitAnswer(idx, timeElapsed);
  setTimeout(() => {
    revealed = true;
    render();
  }, 300);
}

function renderResults() {
  const players = Object.values(room.players || {}).sort((a, b) => (b.score || 0) - (a.score || 0));
  const winner = players[0];
  const myRank = players.findIndex((p) => p.id === me.id) + 1;
  const isHost = room.hostId === me.id;

  $("results-winner").innerHTML = winner
    ? `
      <div class="winner-card">
        ${avatarHtml(winner, 72)}
        <p class="winner-label">🏆 Winner</p>
        <p class="winner-name">${escapeHtml(winner.username)}</p>
        <p class="winner-score">⭐ ${winner.score || 0} points</p>
      </div>`
    : "";

  $("results-mine").innerHTML =
    myRank > 1 && players[myRank - 1]
      ? `<div class="my-result">${avatarHtml(me, 40)}<div><p class="muted small">Your Result</p><p class="bold">#${myRank} — ${players[myRank - 1].score || 0} pts</p></div></div>`
      : "";

  $("results-list").innerHTML = players.length
    ? players.map((p, i) => {
        const rank = i + 1;
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `<span class="rank-num">${rank}</span>`;
        return `
        <div class="lb-row ${p.id === me.id ? "me" : ""} ${rank === 1 ? "first" : ""}">
          <span class="lb-rank">${medal}</span>
          ${avatarHtml(p, 36)}
          <span class="lb-name">${escapeHtml(p.username)}${p.id === me.id ? ' <em>(You)</em>' : ""}</span>
          <span class="lb-score">${p.score || 0} pts</span>
        </div>`;
      }).join("")
    : '<p class="muted center">No players</p>';

  $("results-host-controls").classList.toggle("hidden", !isHost);
  $("results-guest-controls").classList.toggle("hidden", isHost);
}

function showError(msg) {
  $("error-msg").textContent = msg;
  showScreen("error");
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  showScreen("loading");

  // Discord identity (graceful guest fallback everywhere)
  const discordInfo = await initDiscord();
  if (discordInfo.user) {
    me = {
      id: "u" + discordInfo.user.id,
      username: discordInfo.user.global_name || discordInfo.user.username || "Player",
      avatarUrl: `https://cdn.discordapp.com/avatars/${discordInfo.user.id}/${discordInfo.user.avatar || "0"}.png`,
    };
  } else {
    me = {
      id: "g" + Math.random().toString(36).slice(2, 10),
      username: "Guest " + Math.floor(Math.random() * 1000),
      avatarUrl: "",
    };
  }
  updateHeader();

  // Room ID: Discord channel in Discord; ?room= in browser; else random code
  const params = new URLSearchParams(window.location.search);
  roomId = discordInfo.isDiscord && discordInfo.channelId ? discordInfo.channelId : params.get("room");
  if (!roomId || roomId === "lobby") {
    roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  try {
    await joinOrCreateRoom();
    render();

    $("btn-copy").onclick = async () => {
      const link = isDiscord ? roomId : `${location.origin}/?room=${roomId}`;
      try {
        await navigator.clipboard.writeText(link);
        $("lobby-copy-link").textContent = "✅ Copied!";
        setTimeout(() => { $("lobby-copy-link").textContent = isDiscord ? "Copy room ID" : "Copy invite link"; }, 2000);
      } catch (e) {
        /* clipboard blocked in some sandboxes */
      }
    };

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".cat-btn");
      if (btn && me.id === room?.hostId) {
        dbUpdate(`trivia/rooms/${roomId}`, { category: btn.dataset.cat }).catch(() => {});
      }
    });

    $("btn-start").onclick = () => startGame();
    $("btn-play-again").onclick = () => playAgain();
    $("btn-retry").onclick = () => window.location.reload();

    window.addEventListener("beforeunload", () => {
      leaveRoom();
    });
  } catch (err) {
    console.error("Boot error:", err);
    showError("Failed to connect: " + (err.message || err));
  }
}

// Re-evaluate the host advance timer when nothing else triggers it
setInterval(() => scheduleAdvance(), 1000);

boot();
