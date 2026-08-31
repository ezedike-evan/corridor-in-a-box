#!/usr/bin/env bash
# Stand up the SDF Anchor Platform SEP-31 reference server locally, so corridor
# #0 has a conformant counterparty to run against. No agreements, no
# credentials, no real money — this is the lane anyone can run today.
#
#   scripts/reference-anchor.sh up             start the stack, wait for SEP-1 to serve
#   scripts/reference-anchor.sh down           tear it down
#   scripts/reference-anchor.sh logs           tail the platform logs
#   scripts/reference-anchor.sh status         show what is running
#   scripts/reference-anchor.sh logs-dump DIR  write every container's logs to DIR
#
# `logs-dump` is the non-interactive counterpart of `logs`: it never follows, so
# it terminates, which is what makes it usable from CI (see
# .github/workflows/reference-corridor.yml). An anchor-side stall is
# undebuggable from a bare exit code, and `logs -f` in a job would simply hang.
#
# Uses podman (rootless, no daemon).
#
# The arrangement is not obvious, so: the platform's own `--test-profile-runner`
# does NOT start the SEP server, despite the name. It starts the observer, event
# processor and wallet server, and expects everything else to already exist —
# two Postgres instances and Kafka as infrastructure, and the SEP/platform
# servers and Kotlin reference server as separate containers, wired together by
# the hostnames its bundled compose file hardcodes (`db`, `reference-db`,
# `kafka`, `platform`, `reference-server`). So this script runs:
#
#   db, reference-db, kafka   infrastructure
#   ap-sep                    --sep-server --platform-server   (serves :8080)
#   ap-ref                    --kotlin-reference-server        (business logic)
#   ap-obs                    --stellar-observer --event-processor
#
# Config is extracted from the image itself rather than vendored, so it stays in
# step with whatever AP_IMAGE points at. Credentials come from the platform's own
# bundled docker-compose (POSTGRES_PASSWORD=password) — nothing invented here,
# nothing secret, testnet only.

set -euo pipefail

AP_IMAGE="${AP_IMAGE:-docker.io/stellar/anchor-platform:2.10.1}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:16}"
KAFKA_IMAGE="${KAFKA_IMAGE:-docker.io/confluentinc/cp-kafka:7.4.3}"
NET="${NET:-apnet}"
SEP_URL="http://localhost:8080"
READY_TIMEOUT_SECS="${READY_TIMEOUT_SECS:-300}"
CONFIG_DIR="${CONFIG_DIR:-${TMPDIR:-/tmp}/corridor-anchor-config}"

log() { printf '• %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

require_podman() {
  command -v podman >/dev/null 2>&1 || die "podman is not installed"
}

up() {
  require_podman
  podman network exists "$NET" 2>/dev/null || podman network create "$NET" >/dev/null
  log "network $NET ready"

  # Platform metadata DB. Hostname `db` is hardcoded in the test profile.
  if ! podman container exists db 2>/dev/null; then
    podman run -d --name db --network "$NET" --network-alias db \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password \
      "$PG_IMAGE" >/dev/null
  fi

  # The Kotlin reference server's own DB, on 5433 per the bundled compose.
  if ! podman container exists reference-db 2>/dev/null; then
    podman run -d --name reference-db --network "$NET" --network-alias reference-db \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password -e PGPORT=5433 \
      "$PG_IMAGE" >/dev/null
  fi

  # Event bus. KRaft mode (no ZooKeeper); values mirror the bundled compose.
  if ! podman container exists kafka 2>/dev/null; then
    podman run -d --name kafka --network "$NET" --network-alias kafka \
      -e KAFKA_NODE_ID=1 \
      -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
      -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP='CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT' \
      -e KAFKA_LISTENERS='INTERNAL://kafka:29092,CONTROLLER://kafka:29093' \
      -e KAFKA_ADVERTISED_LISTENERS='INTERNAL://kafka:29092' \
      -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL \
      -e KAFKA_CONTROLLER_QUORUM_VOTERS='1@kafka:29093' \
      -e KAFKA_PROCESS_ROLES='broker,controller' \
      -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
      -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
      -e CLUSTER_ID='ciWo7IWazngRchmPES6q5A==' \
      -e KAFKA_LOG_DIRS='/tmp/kraft-combined-logs' \
      "$KAFKA_IMAGE" >/dev/null
  fi

  log "waiting for infrastructure…"
  wait_for 'podman exec db pg_isready -U postgres' "platform db"
  wait_for 'podman exec reference-db pg_isready -U postgres -p 5433' "reference db"

  # Pull the platform's own config out of the image rather than vendoring a copy
  # that would drift. `--test-profile-runner` extracts it to a temp dir on boot.
  if [ ! -f "$CONFIG_DIR/config.env" ]; then
    log "extracting config from $AP_IMAGE…"
    mkdir -p "$CONFIG_DIR"
    podman rm -f ap-extract >/dev/null 2>&1 || true
    podman run -d --name ap-extract --network "$NET" "$AP_IMAGE" --test-profile-runner >/dev/null
    local res=""
    for _ in $(seq 1 30); do
      res="$(podman exec ap-extract sh -c 'ls -d /tmp/resource-temp-dir* 2>/dev/null' | tr -d '\r' | head -1)"
      [ -n "$res" ] && break
      sleep 2
    done
    [ -n "$res" ] || die "could not extract config from the image"
    podman cp "ap-extract:$res/config/." "$CONFIG_DIR/"
    podman cp "ap-extract:$res/profiles/default/config.env" "$CONFIG_DIR/config.env"
    podman rm -f ap-extract >/dev/null 2>&1 || true
    log "config extracted to $CONFIG_DIR"
  fi

  # SEP + platform servers. This is what actually serves :8080.
  if ! podman container exists ap-sep 2>/dev/null; then
    podman run -d --name ap-sep --network "$NET" --network-alias platform \
      -p 8080:8080 -p 8085:8085 \
      -v "$CONFIG_DIR:/config:ro,z" --env-file "$CONFIG_DIR/config.env" \
      "$AP_IMAGE" --sep-server --platform-server >/dev/null
  fi

  # Anchor business logic. The SEP server proxies SEP-12/SEP-31 callbacks here;
  # without it every customer call comes back 502 "service not available".
  if ! podman container exists ap-ref 2>/dev/null; then
    podman run -d --name ap-ref --network "$NET" --network-alias reference-server \
      -p 8091:8091 -v "$CONFIG_DIR:/config:ro,z" \
      -e KT_REFERENCE_SERVER_CONFIG=/config/reference-config.yaml \
      "$AP_IMAGE" --kotlin-reference-server >/dev/null
  fi

  # Watches Stellar for the incoming settlement and drives the transaction to
  # completed. Without it a payment settles on-chain but never reconciles.
  if ! podman container exists ap-obs 2>/dev/null; then
    podman run -d --name ap-obs --network "$NET" \
      -v "$CONFIG_DIR:/config:ro,z" --env-file "$CONFIG_DIR/config.env" \
      "$AP_IMAGE" --stellar-observer --event-processor >/dev/null
  fi

  log "waiting for the SEP server (this takes a minute on first boot)…"
  local waited=0
  until curl -fsS --max-time 3 "$SEP_URL/.well-known/stellar.toml" >/dev/null 2>&1; do
    waited=$((waited + 5))
    if [ "$waited" -ge "$READY_TIMEOUT_SECS" ]; then
      printf '\n'
      # The platform runs as ap-sep/ap-ref/ap-obs; there has never been a
      # container called `ap`, so this printed nothing at exactly the moment it
      # was needed.
      for c in ap-sep ap-ref ap-obs; do
        podman container exists "$c" 2>/dev/null || continue
        printf -- '--- %s (last 40 lines) ---\n' "$c" >&2
        podman logs --tail 40 "$c" >&2 2>&1 || true
      done
      die "SEP server did not come up within ${READY_TIMEOUT_SECS}s"
    fi
    sleep 5
  done

  printf '\n✓ reference anchor is serving\n\n'
  printf '  SEP-1  %s/.well-known/stellar.toml\n' "$SEP_URL"
  printf '  SEP-10 %s/auth\n' "$SEP_URL"
  printf '  SEP-12 %s/sep12\n' "$SEP_URL"
  printf '  SEP-31 %s/sep31\n' "$SEP_URL"
  printf '  SEP-38 %s/sep38\n' "$SEP_URL"
  printf '\nNext: pnpm testnet   (see docs/operations.md §1)\n'
}

wait_for() {
  local cmd="$1" name="$2" waited=0
  until eval "$cmd" >/dev/null 2>&1; do
    waited=$((waited + 3))
    [ "$waited" -ge 120 ] && die "$name did not become ready"
    sleep 3
  done
  log "$name ready"
}

# Write each container's logs to DIR, one file apiece. Non-following and
# non-interactive: it always terminates, and it never fails the caller — this
# runs on the failure path, where the logs are the only evidence left.
logs_dump() {
  require_podman
  local dir="${1:-anchor-logs}"
  mkdir -p "$dir"
  for c in ap-sep ap-ref ap-obs kafka db reference-db; do
    if podman container exists "$c" 2>/dev/null; then
      podman logs "$c" >"$dir/$c.log" 2>&1 || true
      log "wrote $dir/$c.log"
    else
      printf 'container %s was never created\n' "$c" >"$dir/$c.log"
    fi
  done
  podman ps -a --filter network="$NET" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' >"$dir/containers.txt" 2>&1 || true
}

down() {
  require_podman
  podman rm -f ap ap-sep ap-ref ap-obs ap-extract kafka db reference-db >/dev/null 2>&1 || true
  podman network rm -f "$NET" >/dev/null 2>&1 || true
  log "torn down"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  logs) podman logs -f "${2:-ap-sep}" ;;
  logs-dump) logs_dump "${2:-anchor-logs}" ;;
  status) podman ps --filter network="$NET" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' ;;
  *) die "usage: $0 <up|down|logs|logs-dump [dir]|status>" ;;
esac
