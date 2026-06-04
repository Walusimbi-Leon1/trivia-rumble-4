"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Player } from "@/lib/firebase";
import { Crown, Users, Zap, Copy, Check } from "lucide-react";

interface LobbyProps {
  roomId: string;
  players: Record<string, Player>;
  currentUserId: string;
  isHost: boolean;
  category: string;
  onCategoryChange: (category: string) => void;
  onStartGame: () => void;
  isLoading: boolean;
}

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

export function Lobby({
  roomId,
  players,
  currentUserId,
  isHost,
  category,
  onCategoryChange,
  onStartGame,
  isLoading,
}: LobbyProps) {
  const [copied, setCopied] = useState(false);
  const playerList = Object.values(players);
  const canStart = playerList.length >= 1;

  const copyRoomId = async () => {
    await navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-6 w-full max-w-lg mx-auto p-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold gradient-text font-[family-name:var(--font-display)] tracking-tight">
          Trivia Rumble
        </h1>
        <p className="text-muted-foreground mt-2">
          Waiting for players to join...
        </p>
      </div>

      <Card className="card-glow border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="w-5 h-5 text-primary" />
            Room Code
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              value={roomId}
              readOnly
              className="font-mono text-center text-lg tracking-widest bg-muted/50"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={copyRoomId}
              className="shrink-0"
            >
              {copied ? (
                <Check className="w-4 h-4 text-success" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              <span className="sr-only">Copy room code</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="w-5 h-5 text-primary" />
            Players ({playerList.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {playerList.map((player) => (
              <div
                key={player.id}
                className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                  player.id === currentUserId
                    ? "bg-primary/10 border border-primary/30"
                    : "bg-muted/30"
                }`}
              >
                <img
                  src={player.avatarUrl}
                  alt={`${player.username}'s avatar`}
                  className="w-10 h-10 rounded-full ring-2 ring-border"
                />
                <span className="font-medium flex-1 truncate">
                  {player.username}
                  {player.id === currentUserId && (
                    <span className="text-muted-foreground ml-2 text-sm">
                      (You)
                    </span>
                  )}
                </span>
                {player.isHost && (
                  <Crown className="w-5 h-5 text-warning" />
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {isHost && (
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Zap className="w-5 h-5 text-primary" />
              Category
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.map((cat) => (
                <Button
                  key={cat.value}
                  variant={category === cat.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => onCategoryChange(cat.value)}
                  className={`justify-start ${
                    category === cat.value
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted/50"
                  }`}
                >
                  {cat.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {!isHost && (
        <Card className="border-border/50">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">
              Selected category: <span className="text-foreground font-medium">
                {CATEGORIES.find((c) => c.value === category)?.label || "General Knowledge"}
              </span>
            </p>
            <p className="text-center text-muted-foreground text-sm mt-2">
              Waiting for the host to start the game...
            </p>
          </CardContent>
        </Card>
      )}

      {isHost && (
        <Button
          size="lg"
          onClick={onStartGame}
          disabled={!canStart || isLoading}
          className="w-full text-lg font-semibold h-14 bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <span className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              Generating Questions...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Start Game
            </span>
          )}
        </Button>
      )}
    </div>
  );
}
