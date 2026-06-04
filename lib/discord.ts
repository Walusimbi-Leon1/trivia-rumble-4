"use client";

import { DiscordSDK, DiscordSDKMock } from "@discord/embedded-app-sdk";

let discordSdk: DiscordSDK | DiscordSDKMock | null = null;
let auth: {
  accessToken: string;
  user: {
    id: string;
    username: string;
    avatar: string | null;
    discriminator: string;
    global_name: string | null;
  };
} | null = null;

export function getDiscordSdk() {
  return discordSdk;
}

export function getAuth() {
  return auth;
}

export async function initializeDiscordSdk(): Promise<{
  sdk: DiscordSDK | DiscordSDKMock;
  auth: NonNullable<typeof auth>;
}> {
  if (discordSdk && auth) {
    return { sdk: discordSdk, auth };
  }

  const clientId = process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID;
  
  if (!clientId) {
    throw new Error("Discord Client ID is not configured");
  }

  // Check if we're in an iframe (Discord Activity)
  const isEmbedded = typeof window !== "undefined" && window.self !== window.top;

  if (!isEmbedded) {
    // Use mock SDK for development outside Discord
    const mockSdk = new DiscordSDKMock(clientId, null, null);
    discordSdk = mockSdk;
    auth = {
      accessToken: "mock_token",
      user: {
        id: "mock_user_" + Math.random().toString(36).substring(7),
        username: "TestPlayer",
        avatar: null,
        discriminator: "0000",
        global_name: "Test Player",
      },
    };
    return { sdk: mockSdk, auth };
  }

  // Initialize real Discord SDK
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  // Authorize with Discord
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds"],
  });

  // Exchange code for access token
  const response = await fetch("/api/discord/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error("Failed to exchange Discord code for token");
  }

  const { access_token } = await response.json();

  // Authenticate with Discord SDK
  const authResult = await sdk.commands.authenticate({ access_token });

  if (!authResult) {
    throw new Error("Discord authentication failed");
  }

  discordSdk = sdk;
  auth = {
    accessToken: access_token,
    user: authResult.user,
  };

  return { sdk, auth };
}

export function getAvatarUrl(userId: string, avatarHash: string | null): string {
  if (!avatarHash) {
    // Default Discord avatar - handle mock user IDs that can't be converted to BigInt
    let defaultIndex = 0;
    try {
      defaultIndex = Number(BigInt(userId) % BigInt(5));
    } catch {
      // For mock users, use a hash of the string
      defaultIndex = userId.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) % 5;
    }
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`;
}

export function getChannelId(): string | null {
  if (!discordSdk || discordSdk instanceof DiscordSDKMock) {
    return "mock_channel_" + Math.random().toString(36).substring(7);
  }
  return discordSdk.channelId;
}

export function getGuildId(): string | null {
  if (!discordSdk || discordSdk instanceof DiscordSDKMock) {
    return "mock_guild";
  }
  return discordSdk.guildId;
}
