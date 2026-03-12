/**
 * Main Worker entry: email() + fetch() handlers.
 */

import PostalMime, { type Address } from "postal-mime";
import { sendToDiscord, type EmailPayload, type EmailAttachment } from "./discord.js";
import { handleInteraction } from "./interactions.js";
import type { Env } from "./types.js";
import { log } from "./logger.js";

/** Formats an array of postal-mime Address objects into a comma-separated string. */
export function formatAddresses(addresses: Address[] | undefined): string | null {
  if (!addresses || addresses.length === 0) return null;
  return addresses
    .map((addr) => {
      if (addr.address) {
        return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
      }
      // Group address
      if (addr.group) {
        return addr.group
          .map((m) => (m.name ? `${m.name} <${m.address}>` : m.address))
          .join(", ");
      }
      return "";
    })
    .filter(Boolean)
    .join(", ") || null;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    log("info", "email received", {
      from: message.from,
      to: message.to,
      size: message.rawSize,
    });

    const rawBytes = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(rawBytes);

    // Forward to all addresses in KV
    const forwardingRaw = await env.EMAIL_KV.get("forwarding_list");
    if (forwardingRaw) {
      const addresses: string[] = JSON.parse(forwardingRaw);
      const results = await Promise.allSettled(addresses.map((addr) => message.forward(addr)));
      const failed = results.filter((r) => r.status === "rejected").length;
      log("info", "email forwarded", { targets: addresses.length, failed });
    } else {
      log("info", "email forwarding skipped", { reason: "no forwarding_list" });
    }

    // Build payload for Discord
    const attachments: EmailAttachment[] = (parsed.attachments ?? []).map((att) => ({
      filename: att.filename ?? "attachment",
      mimeType: att.mimeType ?? "application/octet-stream",
      content: typeof att.content === "string"
        ? new TextEncoder().encode(att.content)
        : new Uint8Array(att.content),
    }));

    const payload: EmailPayload = {
      from: parsed.from?.address ?? message.from,
      to: formatAddresses(parsed.to) ?? message.to,
      cc: formatAddresses(parsed.cc),
      subject: parsed.subject ?? "(no subject)",
      text: parsed.text ?? null,
      attachments,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
    };

    log("info", "email parsed", {
      subject: payload.subject,
      attachments: attachments.length,
    });

    // Send to all registered Discord channels
    const list = await env.EMAIL_KV.list({ prefix: "guild:" });
    if (list.keys.length === 0) {
      log("info", "discord notify skipped", { reason: "no guilds" });
      return;
    }

    log("info", "discord notify start", { guilds: list.keys.length });

    const sends = list.keys.map(async (key) => {
      const raw = await env.EMAIL_KV.get(key.name);
      if (!raw) return;
      const { channel_id } = JSON.parse(raw) as { channel_id: string };
      return sendToDiscord(channel_id, env.DISCORD_BOT_TOKEN, payload, env.EMAIL_KV);
    });

    ctx.waitUntil(
      Promise.allSettled(sends).then((results) => {
        const failed = results.filter((r) => r.status === "rejected").length;
        log("info", "discord notify complete", { total: results.length, failed });
      }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "POST") {
      return handleInteraction(request, env);
    }
    log("info", "health check", { method: request.method, url: request.url });
    return new Response("mailpipe is running", { status: 200 });
  },
};
