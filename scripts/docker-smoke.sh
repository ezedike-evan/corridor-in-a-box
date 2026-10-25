#!/usr/bin/env bash
# Smoke-tests a built corridor-service image: runs as non-root, has no .env in it,
# and answers /healthz. Used by CI for PRs and by the release publish.
#
#   scripts/docker-smoke.sh corridor-service:ci
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image>}"
name="corridor-smoke-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

uid="$(docker run --rm --entrypoint id "$image" -u)"
if [ "$uid" = "0" ]; then
  echo "::error::image runs as root" >&2
  exit 1
fi

stray="$(docker run --rm --entrypoint sh "$image" -c 'find / -xdev \( -name ".env" -o -name ".env.*" \) -not -path "*/node_modules/*" 2>/dev/null || true')"
if [ -n "$stray" ]; then
  echo "::error::image contains env files:" >&2
  echo "$stray" >&2
  exit 1
fi

# A throwaway testnet key, generated inside the image so nothing real is ever used.
secret="$(docker run --rm --entrypoint node "$image" -e 'process.stdout.write(require("@stellar/stellar-sdk").Keypair.random().secret())')"
docker run -d --name "$name" -p 18080:8080 -e CORRIDOR_SIGNER_SECRET="$secret" "$image" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18080/healthz >/dev/null 2>&1; then
    echo "healthz: ok"
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    docker logs "$name" >&2
    echo "::error::container exited before answering /healthz" >&2
    exit 1
  fi
  sleep 2
done
docker logs "$name" >&2
echo "::error::/healthz did not answer within 120s" >&2
exit 1
