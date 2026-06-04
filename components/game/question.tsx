"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Question as TriviaQuestion, Player } from "@/lib/firebase";
import { Clock, Users, CheckCircle2, XCircle } from "lucide-react";

interface QuestionProps {
  question: TriviaQuestion;
  questionNumber: number;
  totalQuestions: number;
  players: Record<string, Player>;
  currentUserId: string;
  questionStartTime: number;
  onAnswer: (answerIndex: number, timeElapsed: number) => void;
  hasAnswered: boolean;
}

const QUESTION_TIME_LIMIT = 15000; // 15 seconds

export function Question({
  question,
  questionNumber,
  totalQuestions,
  players,
  currentUserId,
  questionStartTime,
  onAnswer,
  hasAnswered,
}: QuestionProps) {
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(QUESTION_TIME_LIMIT);
  const [showResult, setShowResult] = useState(false);

  const handleAnswer = useCallback(
    (index: number) => {
      if (hasAnswered || showResult) return;
      
      const timeElapsed = Date.now() - questionStartTime;
      setSelectedAnswer(index);
      onAnswer(index, timeElapsed);
      
      // Show result after a brief delay
      setTimeout(() => setShowResult(true), 300);
    },
    [hasAnswered, showResult, questionStartTime, onAnswer]
  );

  useEffect(() => {
    setSelectedAnswer(null);
    setShowResult(false);
    setTimeLeft(QUESTION_TIME_LIMIT);
  }, [question, questionStartTime]);

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - questionStartTime;
      const remaining = Math.max(0, QUESTION_TIME_LIMIT - elapsed);
      setTimeLeft(remaining);

      if (remaining === 0 && !hasAnswered) {
        // Time's up - auto-submit wrong answer
        handleAnswer(-1);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [questionStartTime, hasAnswered, handleAnswer]);

  const answeredCount = Object.values(players).filter(
    (p) => p.currentAnswer !== null
  ).length;
  const totalPlayers = Object.values(players).length;
  const progressPercent = (timeLeft / QUESTION_TIME_LIMIT) * 100;

  const getButtonStyle = (index: number) => {
    if (!showResult) {
      if (selectedAnswer === index) {
        return "border-primary bg-primary/20 ring-2 ring-primary";
      }
      return "hover:border-primary/50 hover:bg-primary/5";
    }

    // Show results
    if (index === question.correctAnswer) {
      return "border-success bg-success/20 ring-2 ring-success";
    }
    if (selectedAnswer === index && index !== question.correctAnswer) {
      return "border-destructive bg-destructive/20 ring-2 ring-destructive";
    }
    return "opacity-50";
  };

  return (
    <div className="flex flex-col gap-4 w-full max-w-lg mx-auto p-4">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span className="font-medium">
          Question {questionNumber} / {totalQuestions}
        </span>
        <span className="flex items-center gap-1">
          <Users className="w-4 h-4" />
          {answeredCount}/{totalPlayers} answered
        </span>
      </div>

      <div className="relative">
        <Progress
          value={progressPercent}
          className={`h-2 transition-all ${
            timeLeft < 5000 ? "[&>div]:bg-destructive" : "[&>div]:bg-primary"
          }`}
        />
        <div className="flex items-center justify-end mt-1 text-sm">
          <Clock
            className={`w-4 h-4 mr-1 ${
              timeLeft < 5000 ? "text-destructive animate-pulse" : "text-muted-foreground"
            }`}
          />
          <span
            className={`font-mono ${
              timeLeft < 5000 ? "text-destructive font-bold" : "text-muted-foreground"
            }`}
          >
            {Math.ceil(timeLeft / 1000)}s
          </span>
        </div>
      </div>

      <Card className="card-glow border-border/50">
        <CardContent className="pt-6">
          <h2 className="text-xl font-semibold text-center leading-relaxed text-balance">
            {question.question}
          </h2>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3">
        {question.options.map((option, index) => (
          <Button
            key={index}
            variant="outline"
            className={`h-auto min-h-[3.5rem] px-4 py-3 text-left justify-start whitespace-normal transition-all ${getButtonStyle(
              index
            )} ${hasAnswered && !showResult ? "pointer-events-none" : ""}`}
            onClick={() => handleAnswer(index)}
            disabled={hasAnswered && showResult}
          >
            <span className="flex items-center gap-3 w-full">
              <span className="shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center font-semibold text-sm">
                {String.fromCharCode(65 + index)}
              </span>
              <span className="flex-1">{option}</span>
              {showResult && index === question.correctAnswer && (
                <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
              )}
              {showResult &&
                selectedAnswer === index &&
                index !== question.correctAnswer && (
                  <XCircle className="w-5 h-5 text-destructive shrink-0" />
                )}
            </span>
          </Button>
        ))}
      </div>

      {showResult && (
        <Card
          className={`${
            selectedAnswer === question.correctAnswer
              ? "card-glow-success border-success/50"
              : "card-glow-destructive border-destructive/50"
          }`}
        >
          <CardContent className="pt-4 pb-4">
            <p className="text-center font-medium">
              {selectedAnswer === question.correctAnswer ? (
                <span className="text-success flex items-center justify-center gap-2">
                  <CheckCircle2 className="w-5 h-5" />
                  Correct!
                </span>
              ) : (
                <span className="text-destructive flex items-center justify-center gap-2">
                  <XCircle className="w-5 h-5" />
                  {selectedAnswer === -1
                    ? "Time's up!"
                    : `Wrong! The answer was: ${question.options[question.correctAnswer]}`}
                </span>
              )}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
