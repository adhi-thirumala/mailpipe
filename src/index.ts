/**
 * Main Worker entry: email() + fetch() handlers.
 */

import { DiscordHono } from "discord-hono";
import PostalMime, { type Address } from "postal-mime";
import { sendToDiscord, type EmailPayload, type EmailAttachment } from "./discord.js";
import type { Env, ForwardingEntry } from "./types.js";
import { log } from "./logger.js";
import * as EmailValidator from "email-validator";

/** Formats an array of postal-mime Address objects into a comma-separated string. */
export function formatAddresses(addresses: Address[] | undefined): string | null {
  if (!addresses || addresses.length === 0) return null;
  return (
    addresses
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
      .join(", ") || null
  );
}

const app = new DiscordHono<{ Bindings: Env }>({
  discordEnv: (env) => ({
    APPLICATION_ID: env.DISCORD_APP_ID,
    PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
    TOKEN: env.DISCORD_BOT_TOKEN,
  }),
})
  .command("setup", async (c) => {
    const { guild_id, channel_id } = c.interaction;
    await c.env.EMAIL_KV.put(`guild:${guild_id}`, JSON.stringify({ channel_id, guild_id }));
    return c.flags("EPHEMERAL").res(`Done — emails will be posted to <#${channel_id}>.`);
  })
  .command("remove", async (c) => {
    const { guild_id } = c.interaction;
    await c.env.EMAIL_KV.delete(`guild:${guild_id}`);
    return c
      .flags("EPHEMERAL")
      .res("Removed — this server will no longer receive email notifications.");
  })
  .command("forward", async (c) => {
    const email = (c.var as Record<string, unknown>).email as string;
    const userId = c.interaction.user?.id;

    if (!EmailValidator.validate(email)) {
      return c.flags("EPHEMERAL").res(`Invalid email address: \`${email}\``);
    }

    if (!userId) {
      return c.flags("EPHEMERAL").res("Error: Could not identify user.");
    }

    const raw = await c.env.EMAIL_KV.get("forwarding_list");
    const entries: ForwardingEntry[] = raw ? JSON.parse(raw) : [];

    if (entries.some((entry) => entry.email === email)) {
      return c.flags("EPHEMERAL").res(`\`${email}\` is already in the forwarding list.`);
    }

    entries.push({
      email,
      userId,
      addedAt: new Date().toISOString(),
    });
    await c.env.EMAIL_KV.put("forwarding_list", JSON.stringify(entries));

    return c.flags("EPHEMERAL").res(`Done — emails will be forwarded to \`${email}\`.`);
  })
  .autocomplete(
    "unforward",
    // Autocomplete handler - shows emails added by this user
    async (c) => {
      const userId = c.interaction.user?.id;
      const focused = c.focused?.value?.toLowerCase() || "";

      if (!userId) {
        return c.resAutocomplete({ choices: [] });
      }

      const raw = await c.env.EMAIL_KV.get("forwarding_list");
      const entries: ForwardingEntry[] = raw ? JSON.parse(raw) : [];

      // Filter to only show emails added by this user, matching the search
      const userEmails = entries
        .filter((entry) => entry.userId === userId)
        .filter((entry) => entry.email.toLowerCase().includes(focused));

      const choices = userEmails.map((entry) => ({
        name: entry.email,
        value: entry.email,
      }));

      return c.resAutocomplete({ choices });
    },
    // Command handler - removes the email
    async (c) => {
      const email = (c.var as Record<string, unknown>).email as string;
      const userId = c.interaction.user?.id;

      if (!userId) {
        return c.flags("EPHEMERAL").res("Error: Could not identify user.");
      }

      const raw = await c.env.EMAIL_KV.get("forwarding_list");
      const entries: ForwardingEntry[] = raw ? JSON.parse(raw) : [];

      const entryIndex = entries.findIndex(
        (entry) => entry.email === email && entry.userId === userId
      );

      if (entryIndex === -1) {
        return c
          .flags("EPHEMERAL")
          .res(`\`${email}\` not found in your forwarding list or was added by another user.`);
      }

      entries.splice(entryIndex, 1);
      await c.env.EMAIL_KV.put("forwarding_list", JSON.stringify(entries));

      return c.flags("EPHEMERAL").res(`Removed \`${email}\` from the forwarding list.`);
    }
  );

export default {
  fetch: app.fetch,

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
      const entries: ForwardingEntry[] = JSON.parse(forwardingRaw);
      const addresses = entries.map((entry) => entry.email);
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
      content:
        typeof att.content === "string"
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
};
