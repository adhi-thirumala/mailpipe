export interface Env {
  EMAIL_KV: KVNamespace;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  DISCORD_PUBLIC_KEY: string;
}

export interface ForwardingEntry {
  email: string;
  userId: string;
  addedAt: string;
}
