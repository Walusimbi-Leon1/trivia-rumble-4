"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Player } from "@/lib/firebase";
import { Trophy, Medal, RotateCcw, Crown, Star } from "lucide-react";

interface ResultsProps {
  players: Record<string, Player>;
  currentUserId: string;
  isHost: boolean;
  onPlayAgain: () => void;
}

export function Results({
  players,
  currentUserId,
  isHost,
  onPlayAgain,
}: ResultsProps) {
  const sortedPlayers = Object.values(players).sort((a, b) => b.score - a.score);
  const winner = sortedPlayers[0];
  const currentPlayer = sortedPlayers.find((p) => p.id === currentUserId);
  const currentRank = sortedPlayers.findIndex((p) => p.id === currentUserId) + 1;

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Trophy className="w-6 h-6 text-warning" />;
      case 2:
        return <Medal className="w-6 h-6 text-muted-foreground" />;
      case 3:
        return <Medal className="w-6 h-6 text-amber-700" />;
      default:
        return <span className="w-6 h-6 flex items-center justify-center font-bold text-muted-foreground">{rank}</span>;
    }
  };

  const getRankStyle = (rank: number, playerId: string) => {
    const isCurrentUser = playerId === currentUserId;
    let baseStyle = "flex items-center gap-4 p-4 rounded-xl transition-all";
    
    if (rank === 1) {
      baseStyle += " bg-warning/10 border-2 border-warning/30";
    } else if (isCurrentUser) {
      baseStyle += " bg-primary/10 border-2 border-primary/30";
    } else {
      baseStyle += " bg-muted/30 border border-border/50";
    }
    
    return baseStyle;
  };

  return (
    <div className="flex flex-col gap-6 w-full max-w-lg mx-auto p-4">
      <div className="text-center">
        <h1 className="text-3xl font-bold gradient-text font-[family-name:var(--font-display)] tracking-tight">
          Game Over!
        </h1>
      </div>

      {winner && (
        <Card className="card-glow border-warning/30 bg-warning/5">
          <CardContent className="pt-6 pb-6">
            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                <img
                  src={winner.avatarUrl}
                  alt={`${winner.username}'s avatar`}
                  className="w-20 h-20 rounded-full ring-4 ring-warning"
                />
                <div className="absolute -top-2 -right-2 w-10 h-10 bg-warning rounded-full flex items-center justify-center">
                  <Crown className="w-6 h-6 text-warning-foreground" />
                </div>
              </div>
              <div className="text-center">
                <p className="text-sm text-muted-foreground uppercase tracking-wider">
                  Winner
                </p>
                <p className="text-2xl font-bold text-warning">
                  {winner.username}
                </p>
                <p className="text-lg font-semibold flex items-center justify-center gap-1 mt-1">
                  <Star className="w-5 h-5 text-warning" />
                  {winner.score} points
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {currentPlayer && currentRank > 1 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img
                  src={currentPlayer.avatarUrl}
                  alt="Your avatar"
                  className="w-10 h-10 rounded-full ring-2 ring-primary"
                />
                <div>
                  <p className="text-sm text-muted-foreground">Your Result</p>
                  <p className="font-semibold">
                    #{currentRank} - {currentPlayer.score} pts
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Trophy className="w-5 h-5 text-primary" />
            Leaderboard
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {sortedPlayers.map((player, index) => (
              <div
                key={player.id}
                className={getRankStyle(index + 1, player.id)}
              >
                {getRankIcon(index + 1)}
                <img
                  src={player.avatarUrl}
                  alt={`${player.username}'s avatar`}
                  className="w-10 h-10 rounded-full ring-2 ring-border"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">
                    {player.username}
                    {player.id === currentUserId && (
                      <span className="text-muted-foreground ml-2 text-sm">
                        (You)
                      </span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-lg">{player.score}</p>
                  <p className="text-xs text-muted-foreground">points</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {isHost ? (
        <Button
          size="lg"
          onClick={onPlayAgain}
          className="w-full text-lg font-semibold h-14 bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <RotateCcw className="w-5 h-5 mr-2" />
          Play Again
        </Button>
      ) : (
        <Card className="border-border/50">
          <CardContent className="pt-6 pb-6">
            <p className="text-center text-muted-foreground">
              Waiting for the host to start a new game...
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
