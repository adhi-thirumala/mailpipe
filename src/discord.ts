/**
 * Sends messages to Discord channels via the Bot REST API.
 * Uses discord-hono's Embed builder and typed REST client.
 */

import { Embed, createRest, $channels$_$messages, $channels$_$messages$_$threads } from "discord-hono";
import { log } from "./logger.js";

const EMBED_DESC_LIMIT = 4096;
const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const THREAD_NAME_LIMIT = 100;
const THREAD_ARCHIVE_MINUTES = 1440;
const FOLLOW_EMOJI = "📬";
const FOLLOW_EMOJI_ENCODED = encodeURIComponent(FOLLOW_EMOJI);

// Patterns marking the start of a quoted/forwarded section
const QUOTE_MARKERS = [
  /^On .+ wrote:\s*$/m, // Gmail, Apple Mail
  /^-{3,}\s*Original Message\s*-{3,}/m, // Outlook
  /^From:\s.+\nSent:\s.+\nTo:\s/m, // Outlook header block
];

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface EmailPayload {
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  text: string | null;
  attachments: EmailAttachment[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
}

/** Splits email text into latest reply and previous quoted content. */
function stripReply(text: string): { reply: string; quoted: string | null } {
  for (const pattern of QUOTE_MARKERS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        reply: text.slice(0, match.index).trim(),
        quoted: text.slice(match.index + match[0].length).trim() || null,
      };
    }
  }
  // Check for > quoted lines
  const lines = text.split("\n");
  const qi = lines.findIndex((l) => /^>/.test(l));
  if (qi > 0) {
    return {
      reply: lines.slice(0, qi).join("\n").trim(),
      quoted: lines
        .slice(qi)
        .map((l) => l.replace(/^>\s?/, ""))
        .join("\n")
        .trim() || null,
    };
  }
  return { reply: text.trim(), quoted: null };
}

/** Formats email body as embed description, stripping quoted content. */
function buildDescription(text: string | null): string {
  if (!text?.trim()) return "[no text content]";

  const { reply, quoted } = stripReply(text);
  let desc = reply || "[no text content]";
  if (quoted) {
    desc += "\n\n-- Replying to --\n\n" + quoted;
  }
  if (desc.length > EMBED_DESC_LIMIT) {
    desc = desc.slice(0, EMBED_DESC_LIMIT - 13) + "\n[truncated]";
  }
  return desc;
}

/** Constructs a Discord embed from email payload using the Embed builder. */
function buildEmbed(payload: EmailPayload, skippedFiles: string[]): Embed {
  const footer: string[] = [];
  if (payload.attachments.length > 0) {
    footer.push(`${payload.attachments.length} attachment(s)`);
  }
  if (skippedFiles.length > 0) {
    footer.push(skippedFiles.join(", "));
  }

  const embed = new Embed()
    .title(payload.subject || "(no subject)")
    .description(buildDescription(payload.text))
    .color(0x0099ff)
    .fields(
      { name: "From", value: payload.from, inline: true },
      { name: "To", value: payload.to, inline: true },
    );

  if (footer.length > 0) {
    embed.footer({ text: footer.join(" | ") });
  }

  return embed;
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

function extractMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/<[^>]+>/g);
  const tokens = matches ?? value.split(/\s+/);
  return tokens
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^<|>$/g, ""))
    .filter(Boolean);
}

function threadKey(channelId: string, messageId: string): string {
  return `thread:${channelId}:${messageId}`;
}

function followKey(threadId: string): string {
  return `follow:${threadId}`;
}

/** Adds the follow-reaction emoji to a message so users can subscribe. */
async function addReaction(
  channelId: string,
  messageId: string,
  headers: Record<string, string>,
): Promise<void> {
  const url = `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${FOLLOW_EMOJI_ENCODED}/@me`;
  const res = await fetch(url, { method: "PUT", headers });
  if (!res.ok && res.status !== 429) {
    log("warn", "discord add reaction failed", { channelId, messageId, status: res.status });
  }
}

/** Returns user IDs of non-bot users who reacted with the follow emoji. */
async function getFollowers(
  channelId: string,
  messageId: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const url = `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${FOLLOW_EMOJI_ENCODED}?limit=100`;
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    log("warn", "discord get reactions failed", { channelId, messageId, status: res.status });
    return [];
  }
  const users: { id: string; bot?: boolean }[] = await res.json();
  return users.filter((u) => !u.bot).map((u) => u.id);
}

async function resolveThreadId(
  kv: KVNamespace,
  channelId: string,
  payload: EmailPayload,
): Promise<string | null> {
  const candidates: string[] = [];
  candidates.push(...extractMessageIds(payload.inReplyTo));
  const refs = extractMessageIds(payload.references);
  candidates.push(...refs.reverse());

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeMessageId(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const threadId = await kv.get(threadKey(channelId, normalized));
    if (threadId) return threadId;
  }
  return null;
}

async function storeThreadMapping(
  kv: KVNamespace,
  channelId: string,
  messageId: string | null,
  threadId: string,
): Promise<void> {
  if (!messageId) return;
  const normalized = normalizeMessageId(messageId);
  if (!normalized) return;
  await kv.put(threadKey(channelId, normalized), threadId);
}

function buildThreadName(subject: string): string {
  const clean = (subject || "(no subject)").replace(/\s+/g, " ").trim() || "(no subject)";
  if (clean.length <= THREAD_NAME_LIMIT) return clean;
  return clean.slice(0, THREAD_NAME_LIMIT - 3).trimEnd() + "...";
}

/** Sends a message with embed + optional file attachments to a channel via the typed REST client. */
async function sendMessage(
  rest: ReturnType<typeof createRest>,
  channelId: string,
  payload: EmailPayload,
): Promise<string> {
  log("info", "discord send", {
    channelId,
    attachments: payload.attachments.length,
  });

  // Separate uploadable files from skipped ones
  const uploadable: EmailAttachment[] = [];
  const skipped: string[] = [];

  for (const att of payload.attachments) {
    if (att.content.byteLength > MAX_FILE_SIZE) {
      skipped.push(
        `[too large: ${att.filename} (${(att.content.byteLength / 1024 / 1024).toFixed(1)}MB)]`,
      );
    } else if (uploadable.length >= MAX_FILES) {
      skipped.push(`[skipped: ${att.filename}]`);
    } else {
      uploadable.push(att);
    }
  }

  const embed = buildEmbed(payload, skipped);
  const files = uploadable.map((att) => ({
    blob: new Blob([att.content], { type: att.mimeType }),
    name: att.filename,
  }));

  const res = await rest(
    "POST",
    $channels$_$messages,
    [channelId],
    { embeds: [embed] },
    files.length > 0 ? files : undefined,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  const data = await res.json();
  log("info", "discord send ok", { channelId, messageId: data.id });
  return data.id;
}

/** Creates a thread from a message via the typed REST client. */
async function createThread(
  rest: ReturnType<typeof createRest>,
  channelId: string,
  messageId: string,
  name: string,
): Promise<string> {
  const res = await rest("POST", $channels$_$messages$_$threads, [channelId, messageId], {
    name,
    auto_archive_duration: THREAD_ARCHIVE_MINUTES,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  const data = await res.json();
  log("info", "discord thread created", { channelId, threadId: data.id, messageId });
  return data.id;
}

/** Posts an email as an embed (with file attachments) to a Discord channel or thread. */
export async function sendToDiscord(
  channelId: string,
  botToken: string,
  payload: EmailPayload,
  kv: KVNamespace,
): Promise<void> {
  const rest = createRest(botToken);

  let threadId: string | null = null;
  try {
    threadId = await resolveThreadId(kv, channelId, payload);
  } catch (err) {
    log("warn", "discord thread lookup failed", { channelId, error: String(err) });
  }

  try {
    if (threadId) {
      log("info", "discord thread reply", { channelId, threadId });
      await sendMessage(rest, threadId, payload);
      await storeThreadMapping(kv, channelId, payload.messageId, threadId);
      return;
    }

    const messageId = await sendMessage(rest, channelId, payload);
    if (!payload.messageId) return;

    const threadName = buildThreadName(payload.subject);
    const newThreadId = await createThread(rest, channelId, messageId, threadName);
    await storeThreadMapping(kv, channelId, payload.messageId, newThreadId);
  } catch (err) {
    log("error", "discord send failed", { channelId, error: String(err) });
    throw err;
  }
}
