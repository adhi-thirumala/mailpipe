/**
 * Main Worker entry: email() + fetch() handlers.
 */

import PostalMime from "postal-mime";
import { sendToDiscord, type EmailPayload, type EmailAttachment } from "./discord.js";
import { handleInteraction } from "./interactions.js";
import type { Env } from "./types.js";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const rawBytes = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(rawBytes);

    // Forward to all addresses in KV
    const forwardingRaw = await env.EMAIL_KV.get("forwarding_list");
    if (forwardingRaw) {
      const addresses: string[] = JSON.parse(forwardingRaw);
      await Promise.allSettled(addresses.map((addr) => message.forward(addr)));
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
      to: message.to,
      subject: parsed.subject ?? "(no subject)",
      text: parsed.text ?? null,
      attachments,
    };

    // Send to all registered Discord channels
    const list = await env.EMAIL_KV.list({ prefix: "guild:" });
    if (list.keys.length === 0) return;

    const sends = list.keys.map(async (key) => {
      const raw = await env.EMAIL_KV.get(key.name);
      if (!raw) return;
      const { channel_id } = JSON.parse(raw) as { channel_id: string };
      return sendToDiscord(channel_id, env.DISCORD_BOT_TOKEN, payload);
    });

    ctx.waitUntil(Promise.allSettled(sends));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "POST") {
      return handleInteraction(request, env);
    }
    return new Response("mailpipe is running", { status: 200 });
  },
};
