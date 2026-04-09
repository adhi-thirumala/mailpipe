/**
 * Register Discord slash commands.
 * Usage: bun run src/register.ts
 * Requires DISCORD_APP_ID and DISCORD_BOT_TOKEN in .env
 */

// @ts-nocheck — standalone CLI script, not part of the Worker build.

import { Command, Option, register } from "discord-hono";

const commands = [
  new Command("setup", "Set this channel to receive email notifications")
    .contexts(0) // Guild only
    .default_member_permissions("32"), // MANAGE_GUILD
  new Command("remove", "Stop receiving email notifications in this server")
    .contexts(0)
    .default_member_permissions("32"),
  new Command("forward", "Forward emails from the mailpipe email to this email")
    .contexts(0)
    .default_member_permissions("32")
    .options(new Option("email", "Email address to forward to", "String").required(true)),
  new Command("unforward", "Remove an email from the forwarding list")
    .contexts(0)
    .default_member_permissions("32")
    .options(
      new Option("email", "Email address to remove", "String").required(true).autocomplete()
    ),
];

declare const process: { env: Record<string, string | undefined> };

const result = await register(commands, process.env.DISCORD_APP_ID, process.env.DISCORD_BOT_TOKEN);

console.log("Registered commands:", result);
