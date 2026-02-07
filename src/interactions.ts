/**
 * Discord slash command handler + signature verification.
 */

import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
} from "discord-interactions";

import type { Env } from "./types.js";

// Permission bit for MANAGE_GUILD
const MANAGE_GUILD = 1 << 5;

/** Shorthand for a JSON Response. */
function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Verifies the Discord signature, then routes to PONG or command handler. */
export async function handleInteraction(request: Request, env: Env): Promise<Response> {
  // Verify signature
  const signature = request.headers.get("X-Signature-Ed25519") ?? "";
  const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
  const rawBody = await request.text();

  const isValid = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!isValid) {
    return new Response("Invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // PING handshake
  if (interaction.type === InteractionType.PING) {
    return jsonResponse({ type: InteractionResponseType.PONG });
  }

  // Slash commands
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return handleCommand(interaction, env);
  }

  return jsonResponse({ error: "Unknown interaction type" }, 400);
}

/** Checks the MANAGE_GUILD bit in a Discord permissions bitfield string. */
function hasManageGuild(permissions: string | undefined): boolean {
  if (!permissions) return false;
  return (BigInt(permissions) & BigInt(MANAGE_GUILD)) !== 0n;
}

/** Returns an ephemeral (only-visible-to-caller) Discord interaction response. */
function ephemeral(content: string): Response {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: InteractionResponseFlags.EPHEMERAL },
  });
}

/** Dispatches /setup and /remove commands. Requires MANAGE_GUILD permission. */
async function handleCommand(interaction: any, env: Env): Promise<Response> {
  const name: string = interaction.data?.name;
  const guildId: string | undefined = interaction.guild_id;
  const channelId: string | undefined = interaction.channel_id;
  const memberPermissions: string | undefined = interaction.member?.permissions;

  if (!guildId || !channelId) {
    return ephemeral("This command can only be used in a server.");
  }

  if (!hasManageGuild(memberPermissions)) {
    return ephemeral("You need the Manage Server permission to use this.");
  }

  if (name === "setup") {
    await env.EMAIL_KV.put(
      `guild:${guildId}`,
      JSON.stringify({ channel_id: channelId, guild_id: guildId }),
    );
    return ephemeral(`Done — emails will be posted to <#${channelId}>.`);
  }

  if (name === "remove") {
    await env.EMAIL_KV.delete(`guild:${guildId}`);
    return ephemeral("Removed — this server will no longer receive email notifications.");
  }

  return ephemeral("Unknown command.");
}
