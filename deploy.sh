#!/bin/bash
# Deploy Trivia Rumble Elite to Cloudflare Workers
set -euo pipefail

T=CF_CLOUDFLARE_TOKEN_REMOVED
ACC=d21711ae11a362bc4d57d4fd48deae61
NAME=trivia-rumble-elite

cd /tmp/tre
node build.js

BOUNDARY="----tre-deploy-$(date +%s)"
METADATA=$(cat <<JSON
{"main_module":"worker.js","bindings":[{"type":"plain_text","name":"REDIRECT_URI","text":"https://${NAME}.walusimbileon1.workers.dev/"},{"type":"plain_text","name":"FB_HOST","text":"pop-party-1-default-rtdb.firebaseio.com"}]}
JSON
)

{
  printf -- "--%s\r\n" "$BOUNDARY"
  printf 'Content-Disposition: form-data; name="worker.js"\r\n'
  printf 'Content-Type: application/javascript\r\n\r\n'
  cat dist/worker.js
  printf "\r\n--%s\r\n" "$BOUNDARY"
  printf 'Content-Disposition: form-data; name="metadata"\r\n'
  printf 'Content-Type: application/json\r\n\r\n'
  printf '%s' "$METADATA"
  printf "\r\n--%s--\r\n" "$BOUNDARY"
} > /tmp/tre/upload.bin

echo "Uploading $(wc -c < /tmp/tre/upload.bin) bytes..."
RESP=$(curl -s -X PUT \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: multipart/form-data; boundary=$BOUNDARY" \
  --data-binary @/tmp/tre/upload.bin \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$NAME")
echo "$RESP" | jq -c '{success, errors: [.errors[].message], id: .result.id, modified: .result.modified_on}'
