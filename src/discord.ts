/**
 * Sends messages to Discord channels via the Bot REST API.
 */

const DISCORD_API = "https://discord.com/api/v10";
const EMBED_DESC_LIMIT = 4096;
const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

// Patterns marking the start of a quoted/forwarded section
const QUOTE_MARKERS = [
  /^On .+ wrote:\s*$/m,                     // Gmail, Apple Mail
  /^-{3,}\s*Original Message\s*-{3,}/m,     // Outlook
  /^From:\s.+\nSent:\s.+\nTo:\s/m,         // Outlook header block
];

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string | null;
  attachments: EmailAttachment[];
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
      quoted: lines.slice(qi).map((l) => l.replace(/^>\s?/, "")).join("\n").trim() || null,
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

/** Constructs the Discord embed object with email metadata and skipped-file notes. */
function buildEmbed(payload: EmailPayload, skippedFiles: string[]): object {
  const footer: string[] = [];
  if (payload.attachments.length > 0) {
    footer.push(`${payload.attachments.length} attachment(s)`);
  }
  if (skippedFiles.length > 0) {
    footer.push(skippedFiles.join(", "));
  }

  return {
    title: payload.subject || "(no subject)",
    description: buildDescription(payload.text),
    color: 0x0099ff,
    fields: [
      { name: "From", value: payload.from, inline: true },
      { name: "To", value: payload.to, inline: true },
    ],
    ...(footer.length > 0 && { footer: { text: footer.join(" | ") } }),
  };
}

/** Posts an email as an embed (with file attachments) to a Discord channel. */
export async function sendToDiscord(
  channelId: string,
  botToken: string,
  payload: EmailPayload,
): Promise<void> {
  const url = `${DISCORD_API}/channels/${channelId}/messages`;
  const headers = { Authorization: `Bot ${botToken}` };

  // Separate uploadable files from skipped ones
  const uploadable: EmailAttachment[] = [];
  const skipped: string[] = [];

  for (const att of payload.attachments) {
    if (att.content.byteLength > MAX_FILE_SIZE) {
      skipped.push(`[too large: ${att.filename} (${(att.content.byteLength / 1024 / 1024).toFixed(1)}MB)]`);
    } else if (uploadable.length >= MAX_FILES) {
      skipped.push(`[skipped: ${att.filename}]`);
    } else {
      uploadable.push(att);
    }
  }

  const embed = buildEmbed(payload, skipped);

  if (uploadable.length === 0) {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    await handleResponse(res);
    return;
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify({ embeds: [embed] }));

  for (let i = 0; i < uploadable.length; i++) {
    const att = uploadable[i];
    form.append(`files[${i}]`, new Blob([att.content], { type: att.mimeType }), att.filename);
  }

  const res = await fetch(url, { method: "POST", headers, body: form });
  await handleResponse(res);
}

/** Throws on non-2xx responses. Waits and throws on 429 so allSettled captures it. */
async function handleResponse(res: Response): Promise<void> {
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") || "1");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    throw new Error(`Discord rate limited, retry after ${retryAfter}s`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
}
