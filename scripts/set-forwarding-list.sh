#!/usr/bin/env bash
# Update the forwarding_list KV key from CLI args.
# Usage:
#   ./scripts/set-forwarding-list.sh a@b.com b@c.com
#   ./scripts/set-forwarding-list.sh a@b.com,b@c.com

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 email1 [email2 ...]" >&2
  echo "   or: $0 email1,email2" >&2
  exit 1
fi

if [ $# -eq 1 ] && [[ "$1" == *","* ]]; then
  IFS="," read -r -a emails <<< "$1"
else
  emails=("$@")
fi

json="["
for email in "${emails[@]}"; do
  # trim whitespace
  email="${email#"${email%%[![:space:]]*}"}"
  email="${email%"${email##*[![:space:]]}"}"
  [ -z "$email" ] && continue

  # minimal JSON escaping
  email=${email//\\/\\\\}
  email=${email//"/\\"}

  if [ "$json" != "[" ]; then
    json+="," 
  fi
  json+="\"$email\""
done
json+="]"

if [ "$json" = "[]" ]; then
  echo "No valid emails provided." >&2
  exit 1
fi

bunx wrangler kv key put --remote --binding EMAIL_KV "forwarding_list" "$json"
echo "Updated forwarding_list: $json"
