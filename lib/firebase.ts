import { initializeApp, getApps } from "firebase/app";
import {
  getDatabase,
  ref,
  set,
  onValue,
  push,
  update,
  remove,
  get,
  type Database,
} from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const database = getDatabase(app);

export interface Player {
  id: string;
  username: string;
  avatarUrl: string;
  score: number;
  currentAnswer: string | null;
  answerTime: number | null;
  isHost: boolean;
}

export interface Question {
  question: string;
  options: string[];
  correctAnswer: number;
}

export interface GameRoom {
  id: string;
  hostId: string;
  status: "lobby" | "playing" | "results";
  players: Record<string, Player>;
  questions: Question[];
  currentQuestionIndex: number;
  questionStartTime: number | null;
  category: string;
  createdAt: number;
}

export function getRoomRef(roomId: string) {
  return ref(database, `rooms/${roomId}`);
}

export function getPlayersRef(roomId: string) {
  return ref(database, `rooms/${roomId}/players`);
}

export async function createRoom(
  roomId: string,
  hostId: string,
  hostUsername: string,
  hostAvatarUrl: string
): Promise<void> {
  const roomRef = getRoomRef(roomId);
  const room: GameRoom = {
    id: roomId,
    hostId,
    status: "lobby",
    players: {
      [hostId]: {
        id: hostId,
        username: hostUsername,
        avatarUrl: hostAvatarUrl,
        score: 0,
        currentAnswer: null,
        answerTime: null,
        isHost: true,
      },
    },
    questions: [],
    currentQuestionIndex: 0,
    questionStartTime: null,
    category: "general",
    createdAt: Date.now(),
  };
  await set(roomRef, room);
}

export async function joinRoom(
  roomId: string,
  playerId: string,
  username: string,
  avatarUrl: string
): Promise<boolean> {
  const roomRef = getRoomRef(roomId);
  const snapshot = await get(roomRef);
  
  if (!snapshot.exists()) {
    return false;
  }
  
  const room = snapshot.val() as GameRoom;
  if (room.status !== "lobby") {
    return false;
  }
  
  const playerRef = ref(database, `rooms/${roomId}/players/${playerId}`);
  await set(playerRef, {
    id: playerId,
    username,
    avatarUrl,
    score: 0,
    currentAnswer: null,
    answerTime: null,
    isHost: false,
  });
  
  return true;
}

export async function leaveRoom(roomId: string, playerId: string): Promise<void> {
  const playerRef = ref(database, `rooms/${roomId}/players/${playerId}`);
  await remove(playerRef);
}

export async function updateRoomStatus(
  roomId: string,
  status: GameRoom["status"]
): Promise<void> {
  const roomRef = getRoomRef(roomId);
  await update(roomRef, { status });
}

export async function setQuestions(
  roomId: string,
  questions: Question[]
): Promise<void> {
  const roomRef = getRoomRef(roomId);
  await update(roomRef, { questions });
}

export async function updateCategory(
  roomId: string,
  category: string
): Promise<void> {
  const roomRef = getRoomRef(roomId);
  await update(roomRef, { category });
}

export async function startQuestion(
  roomId: string,
  questionIndex: number
): Promise<void> {
  const roomRef = getRoomRef(roomId);
  await update(roomRef, {
    currentQuestionIndex: questionIndex,
    questionStartTime: Date.now(),
  });
  
  // Reset all player answers
  const snapshot = await get(getRoomRef(roomId));
  if (snapshot.exists()) {
    const room = snapshot.val() as GameRoom;
    const updates: Record<string, unknown> = {};
    Object.keys(room.players || {}).forEach((pid) => {
      updates[`rooms/${roomId}/players/${pid}/currentAnswer`] = null;
      updates[`rooms/${roomId}/players/${pid}/answerTime`] = null;
    });
    await update(ref(database), updates);
  }
}

export async function submitAnswer(
  roomId: string,
  playerId: string,
  answer: string,
  answerTime: number
): Promise<void> {
  const playerRef = ref(database, `rooms/${roomId}/players/${playerId}`);
  await update(playerRef, {
    currentAnswer: answer,
    answerTime,
  });
}

export async function updatePlayerScore(
  roomId: string,
  playerId: string,
  scoreToAdd: number
): Promise<void> {
  const playerRef = ref(database, `rooms/${roomId}/players/${playerId}`);
  const snapshot = await get(playerRef);
  if (snapshot.exists()) {
    const player = snapshot.val() as Player;
    await update(playerRef, { score: player.score + scoreToAdd });
  }
}

export async function resetGame(roomId: string): Promise<void> {
  const roomRef = getRoomRef(roomId);
  const snapshot = await get(roomRef);
  
  if (snapshot.exists()) {
    const room = snapshot.val() as GameRoom;
    const updates: Record<string, unknown> = {
      status: "lobby",
      currentQuestionIndex: 0,
      questionStartTime: null,
      questions: [],
    };
    
    Object.keys(room.players || {}).forEach((pid) => {
      updates[`players/${pid}/score`] = 0;
      updates[`players/${pid}/currentAnswer`] = null;
      updates[`players/${pid}/answerTime`] = null;
    });
    
    await update(roomRef, updates);
  }
}

export function subscribeToRoom(
  roomId: string,
  callback: (room: GameRoom | null) => void
): () => void {
  const roomRef = getRoomRef(roomId);
  const unsubscribe = onValue(roomRef, (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.val() as GameRoom);
    } else {
      callback(null);
    }
  });
  return unsubscribe;
}

export { database, ref, onValue, push, update, remove, get, set };
export type { Database };
