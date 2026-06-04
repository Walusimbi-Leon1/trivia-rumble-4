"use client";

import { useEffect, useState, useCallback } from "react";
import { Lobby } from "@/components/game/lobby";
import { Question } from "@/components/game/question";
import { Results } from "@/components/game/results";
import { LoadingScreen, ErrorScreen } from "@/components/game/loading";
import {
  initializeDiscordSdk,
  getAvatarUrl,
  getChannelId,
  getAuth,
} from "@/lib/discord";
import {
  createRoom,
  joinRoom,
  subscribeToRoom,
  updateCategory,
  updateRoomStatus,
  setQuestions,
  startQuestion,
  submitAnswer,
  updatePlayerScore,
  resetGame,
  type GameRoom,
} from "@/lib/firebase";

type GameState = "initializing" | "lobby" | "playing" | "results" | "error";

const QUESTION_DURATION = 15000; // 15 seconds
const RESULT_DISPLAY_TIME = 3000; // 3 seconds to show result before next question

export default function GamePage() {
  const [gameState, setGameState] = useState<GameState>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<GameRoom | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [isLoadingQuestions, setIsLoadingQuestions] = useState(false);
  const [hasAnswered, setHasAnswered] = useState(false);

  // Initialize Discord SDK and create/join room
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    const initialize = async () => {
      try {
        const { auth } = await initializeDiscordSdk();
        setUserId(auth.user.id);

        const channelId = getChannelId();
        if (!channelId) {
          throw new Error("Could not get channel ID");
        }

        // Use channel ID as room ID so everyone in the activity joins the same room
        const roomId = channelId;
        const avatarUrl = getAvatarUrl(auth.user.id, auth.user.avatar);
        const username = auth.user.global_name || auth.user.username;

        // Try to join existing room first
        const joined = await joinRoom(roomId, auth.user.id, username, avatarUrl);

        if (!joined) {
          // Room doesn't exist or game in progress - create new room
          await createRoom(roomId, auth.user.id, username, avatarUrl);
        }

        // Subscribe to room updates
        unsubscribe = subscribeToRoom(roomId, (roomData) => {
          if (roomData) {
            setRoom(roomData);
            setGameState(roomData.status);
          } else {
            setError("Room not found");
            setGameState("error");
          }
        });
      } catch (err) {
        console.error("Initialization error:", err);
        setError(err instanceof Error ? err.message : "Failed to initialize");
        setGameState("error");
      }
    };

    initialize();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  // Handle category change
  const handleCategoryChange = useCallback(
    async (category: string) => {
      if (!room) return;
      await updateCategory(room.id, category);
    },
    [room]
  );

  // Handle start game
  const handleStartGame = useCallback(async () => {
    if (!room || !userId) return;

    setIsLoadingQuestions(true);
    try {
      // Generate trivia questions
      const response = await fetch("/api/trivia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: room.category,
          count: 10,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate questions");
      }

      const { questions } = await response.json();

      // Save questions and start game
      await setQuestions(room.id, questions);
      await updateRoomStatus(room.id, "playing");
      await startQuestion(room.id, 0);
    } catch (err) {
      console.error("Failed to start game:", err);
      setError("Failed to generate trivia questions. Please try again.");
    } finally {
      setIsLoadingQuestions(false);
    }
  }, [room, userId]);

  // Handle answer submission
  const handleAnswer = useCallback(
    async (answerIndex: number, timeElapsed: number) => {
      if (!room || !userId || hasAnswered) return;

      setHasAnswered(true);
      await submitAnswer(room.id, userId, String(answerIndex), timeElapsed);

      // Calculate score if correct
      const currentQuestion = room.questions?.[room.currentQuestionIndex];
      if (currentQuestion && answerIndex === currentQuestion.correctAnswer) {
        // Score based on speed: faster = more points
        // Max 100 points, minimum 10 points
        const speedBonus = Math.max(
          10,
          Math.floor(100 * (1 - timeElapsed / QUESTION_DURATION))
        );
        await updatePlayerScore(room.id, userId, speedBonus);
      }
    },
    [room, userId, hasAnswered]
  );

  // Auto-advance to next question
  useEffect(() => {
    if (!room || room.status !== "playing" || !room.questionStartTime) return;

    const checkAllAnswered = () => {
      const players = Object.values(room.players);
      return players.every((p) => p.currentAnswer !== null);
    };

    const advanceQuestion = async () => {
      // Only host advances questions
      const auth = getAuth();
      if (!auth || room.hostId !== auth.user.id) return;

      const nextIndex = room.currentQuestionIndex + 1;
      if (nextIndex >= room.questions.length) {
        // Game over
        await updateRoomStatus(room.id, "results");
      } else {
        // Next question
        await startQuestion(room.id, nextIndex);
      }
    };

    // Check if all players answered or time is up
    const timeoutId = setTimeout(() => {
      advanceQuestion();
    }, QUESTION_DURATION + RESULT_DISPLAY_TIME);

    // Also advance early if all players answered
    if (checkAllAnswered()) {
      setTimeout(() => {
        advanceQuestion();
      }, RESULT_DISPLAY_TIME);
    }

    return () => clearTimeout(timeoutId);
  }, [room]);

  // Reset hasAnswered when question changes
  useEffect(() => {
    setHasAnswered(false);
  }, [room?.currentQuestionIndex]);

  // Handle play again
  const handlePlayAgain = useCallback(async () => {
    if (!room) return;
    await resetGame(room.id);
  }, [room]);

  // Render based on game state
  if (gameState === "initializing") {
    return <LoadingScreen message="Connecting to Discord..." />;
  }

  if (gameState === "error" || error) {
    return (
      <ErrorScreen
        message={error || "An unexpected error occurred"}
        onRetry={() => window.location.reload()}
      />
    );
  }

  if (!room || !userId) {
    return <LoadingScreen message="Setting up game room..." />;
  }

  const isHost = room.hostId === userId;
  const currentQuestion = room.questions?.[room.currentQuestionIndex] ?? null;

  switch (gameState) {
    case "lobby":
      return (
        <Lobby
          roomId={room.id}
          players={room.players}
          currentUserId={userId}
          isHost={isHost}
          category={room.category}
          onCategoryChange={handleCategoryChange}
          onStartGame={handleStartGame}
          isLoading={isLoadingQuestions}
        />
      );

    case "playing":
      if (!currentQuestion || !room.questionStartTime) {
        return <LoadingScreen message="Loading question..." />;
      }
      return (
        <Question
          question={currentQuestion}
          questionNumber={room.currentQuestionIndex + 1}
          totalQuestions={room.questions.length}
          players={room.players}
          currentUserId={userId}
          questionStartTime={room.questionStartTime}
          onAnswer={handleAnswer}
          hasAnswered={hasAnswered}
        />
      );

    case "results":
      return (
        <Results
          players={room.players}
          currentUserId={userId}
          isHost={isHost}
          onPlayAgain={handlePlayAgain}
        />
      );

    default:
      return <LoadingScreen />;
  }
}
