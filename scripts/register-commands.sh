#!/usr/bin/env bash
# Register /setup and /remove slash commands with Discord.
# Usage: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... ./scripts/register-commands.sh

set -euo pipefail

: "${DISCORD_APP_ID:?Set DISCORD_APP_ID}"
: "${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN}"

curl -sf -X PUT \
  "https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '[
    {"name":"setup","description":"Set this channel to receive email notifications","type":1},
    {"name":"remove","description":"Stop receiving email notifications in this server","type":1}
  ]'

echo ""
echo "Done."
