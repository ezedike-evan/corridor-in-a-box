#!/usr/bin/env bash
# Stand up the SDF Anchor Platform SEP-31 reference server locally, so corridor
# #0 has a conformant counterparty to run against. No agreements, no
# credentials, no real money — this is the lane anyone can run today.
#
#   scripts/reference-anchor.sh up      start the stack, wait for SEP-1 to serve
#   scripts/reference-anchor.sh down    tear it down
#   scripts/reference-anchor.sh logs    tail the platform logs
#   scripts/reference-anchor.sh status  show what is running
#   scripts/reference-anchor.sh doctor  check the stack is fit to run a corridor
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
# The Stellar observer's starting cursor is NOT a config value. Anchor Platform
# 2.x keeps it in the platform DB (table `stellar_payment_observer_page_token`,
# a single row keyed `SINGLETON_ID`) and only falls back to Horizon's latest
# cursor when that row is absent. A row left behind by an earlier run is
# therefore how a stale cursor leaks into a fresh `up`: the observer resumes
# from a ledger the settle leg has already passed, never matches the incoming
# payment, and the transaction sits at `pending_sender` until the engine gives
# up. So `up` clears that row and reseeds it from Horizon's current ledger,
# minus a small safety margin, on every start.
#
#   START_LEDGER=<n>            start the observer at exactly ledger <n>
#   CURSOR_MARGIN_LEDGERS=<n>   ledgers of slack below Horizon's tip (default 10)
#   HORIZON_URL=<url>           Horizon to read the current ledger from
#
# `doctor` is the counterpart to that seeding: it reports how far the observer's
# cursor has drifted behind Horizon *before* a run, rather than letting the run
# discover it by polling for the full recovery timeout and failing with
# SETTLEMENT_TIMEOUT. It exits non-zero on any failed check, so it can gate CI or
# a verify:corridor run.
#
#   CURSOR_LAG_FAIL_LEDGERS=<n>  lag at which the cursor check fails (default 180)
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
HORIZON_URL="${HORIZON_URL:-https://horizon-testnet.stellar.org}"
CURSOR_MARGIN_LEDGERS="${CURSOR_MARGIN_LEDGERS:-10}"
START_LEDGER="${START_LEDGER:-}"
# ~180 ledgers is the default recovery.timeout_seconds (900s) at testnet's ~5s
# close time: beyond that an observer starting this far back cannot catch up to
# a fresh payment before the engine gives up on it.
CURSOR_LAG_FAIL_LEDGERS="${CURSOR_LAG_FAIL_LEDGERS:-180}"

log() { printf '• %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

require_podman() {
  command -v podman >/dev/null 2>&1 || die "podman is not installed"
}

psql_platform() { podman exec db psql -qtAX -U postgres -d postgres "$@"; }

# Horizon's paging token for a ledger is a TOID: the ledger sequence in the high
# 32 bits, transaction and operation order zero. Starting the observer at the
# first operation of ledger N is therefore N * 2^32.
ledger_to_cursor() { printf '%s' "$(( $1 * 4294967296 ))"; }

horizon_latest_ledger() {
  curl -fsS --max-time 10 "$HORIZON_URL/ledgers?order=desc&limit=1" 2>/dev/null \
    | tr ',' '\n' \
    | sed -n 's/.*"sequence":[[:space:]]*\([0-9]\{1,\}\).*/\1/p' \
    | head -1
}

# Clear any cursor left over from a previous run and pin a fresh one, so the
# observer cannot resume from a ledger the settle leg has already passed. See
# the header for why this is a DB row and not a config value.
seed_observer_cursor() {
  local cursor tip
  if [ -n "$START_LEDGER" ]; then
    SEEDED_LEDGER="$START_LEDGER"
    log "START_LEDGER=$SEEDED_LEDGER (override)"
  else
    tip="$(horizon_latest_ledger)"
    [ -n "$tip" ] || die "could not read the current ledger from $HORIZON_URL (set START_LEDGER to bypass)"
    SEEDED_LEDGER=$(( tip > CURSOR_MARGIN_LEDGERS ? tip - CURSOR_MARGIN_LEDGERS : 1 ))
    log "Horizon is at ledger $tip; starting the observer at $SEEDED_LEDGER (margin ${CURSOR_MARGIN_LEDGERS})"
  fi
  cursor="$(ledger_to_cursor "$SEEDED_LEDGER")"
  psql_platform -c "DELETE FROM stellar_payment_observer_page_token;" >/dev/null
  psql_platform -c "INSERT INTO stellar_payment_observer_page_token (id, cursor) VALUES ('SINGLETON_ID', '$cursor');" >/dev/null
  log "observer cursor seeded at ledger $SEEDED_LEDGER (cursor $cursor)"
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
      # `set -e` + `pipefail`: this exec fails for the first second or two while
      # the container boots, and an unguarded assignment would abort `up` there.
      res="$(podman exec ap-extract sh -c 'ls -d /tmp/resource-temp-dir* 2>/dev/null' 2>/dev/null | tr -d '\r' | head -1)" || true
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

  log "waiting for the SEP server (this takes a minute on first boot)…"
  local waited=0
  until curl -fsS --max-time 3 "$SEP_URL/.well-known/stellar.toml" >/dev/null 2>&1; do
    waited=$((waited + 5))
    if [ "$waited" -ge "$READY_TIMEOUT_SECS" ]; then
      printf '\n'
      podman logs --tail 40 ap-sep 2>&1 || true
      die "SEP server did not come up within ${READY_TIMEOUT_SECS}s"
    fi
    sleep 5
  done

  # The observer's tables are created by the platform server's Flyway migration,
  # so the cursor can only be seeded once that server has booted — which serving
  # SEP-1 above establishes.
  wait_for 'psql_platform -c "SELECT 1 FROM stellar_payment_observer_page_token LIMIT 1"' \
    "observer cursor table"

  # Stop the observer BEFORE seeding. A running observer writes its own paging
  # token back to this row as it streams, so seeding underneath a live one is
  # overwritten within milliseconds and the new cursor never takes effect.
  podman rm -f ap-obs >/dev/null 2>&1 || true
  seed_observer_cursor

  # Watches Stellar for the incoming settlement and drives the transaction to
  # completed. Without it a payment settles on-chain but never reconciles.
  # Recreated on every `up` so it reads the cursor just seeded rather than
  # resuming from wherever the previous run left off.
  podman run -d --name ap-obs --network "$NET" \
    -v "$CONFIG_DIR:/config:ro,z" --env-file "$CONFIG_DIR/config.env" \
    "$AP_IMAGE" --stellar-observer --event-processor >/dev/null
  log "observer started"

  printf '\n✓ reference anchor is serving\n\n'
  printf '  SEP-1  %s/.well-known/stellar.toml\n' "$SEP_URL"
  printf '  SEP-10 %s/auth\n' "$SEP_URL"
  printf '  SEP-12 %s/sep12\n' "$SEP_URL"
  printf '  SEP-31 %s/sep31\n' "$SEP_URL"
  printf '  SEP-38 %s/sep38\n' "$SEP_URL"
  printf '\n  observer starting at ledger %s\n' "$SEEDED_LEDGER"
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

DOCTOR_FAILURES=0
pass_() { printf '  ✓ %-16s %s\n' "$1" "$2"; }
fail_() { printf '  ✗ %-16s %s\n' "$1" "$2"; DOCTOR_FAILURES=$((DOCTOR_FAILURES + 1)); }

container_running() {
  [ "$(podman inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

# Asset codes one level inside SEP-31 /info's `receive` object. A depth-aware
# scan rather than a regex: the nested sep12 blocks put quoted braces and commas
# in the way of anything simpler.
sep31_receive_codes() {
  awk '
    { s = s $0 }
    END {
      i = index(s, "\"receive\"")
      if (i == 0) exit
      s = substr(s, i)
      i = index(s, "{")
      if (i == 0) exit
      depth = 0; inq = 0; esc = 0; key = ""; capturing = 0; expect = 0
      for (n = i; n <= length(s); n++) {
        c = substr(s, n, 1)
        if (inq) {
          if (esc) { esc = 0; if (capturing) key = key c; continue }
          if (c == "\\") { esc = 1; continue }
          if (c == "\"") { inq = 0; if (capturing) { print key; capturing = 0; key = "" }; continue }
          if (capturing) key = key c
          continue
        }
        if (c == "\"") { inq = 1; if (depth == 1 && expect) { capturing = 1; key = ""; expect = 0 }; continue }
        if (c == "{") { depth++; if (depth == 1) expect = 1; continue }
        if (c == "}") { depth--; if (depth == 0) break; continue }
        if (c == ",") { if (depth == 1) expect = 1; continue }
      }
    }'
}

doctor() {
  require_podman
  printf 'reference anchor doctor\n\n'

  local missing="" c
  for c in db reference-db kafka ap-sep ap-ref ap-obs; do
    container_running "$c" || missing="$missing $c"
  done
  if [ -n "$missing" ]; then
    fail_ containers "not running:$missing"
  else
    pass_ containers "db reference-db kafka ap-sep ap-ref ap-obs"
  fi

  if curl -fsS --max-time 5 "$SEP_URL/.well-known/stellar.toml" >/dev/null 2>&1; then
    pass_ sep1 "$SEP_URL/.well-known/stellar.toml"
  else
    fail_ sep1 "$SEP_URL/.well-known/stellar.toml does not serve"
  fi

  local info codes count
  info="$(curl -fsS --max-time 5 "$SEP_URL/sep31/info" 2>/dev/null)" || info=""
  if [ -z "$info" ]; then
    fail_ sep31-info "$SEP_URL/sep31/info did not respond"
  else
    codes="$(printf '%s' "$info" | sep31_receive_codes | tr '\n' ' ' | sed 's/ *$//')"
    count="$(printf '%s' "$info" | sep31_receive_codes | grep -c . || true)"
    if [ "$count" -gt 0 ]; then
      pass_ sep31-info "receive: $codes"
    else
      fail_ sep31-info "receive list is empty - no asset can be received today"
    fi
  fi

  # The check this command exists for. Report the gap as ledgers, so a
  # borderline stack is legible rather than a bare pass/fail.
  local cursor tip lag
  cursor="$(psql_platform -c 'SELECT cursor FROM stellar_payment_observer_page_token;' 2>/dev/null | head -1 | tr -d '[:space:]')" || cursor=""
  tip="$(horizon_latest_ledger)"
  case "$cursor" in
    ''|*[!0-9]*) cursor="" ;;
  esac
  if [ -z "$cursor" ]; then
    fail_ cursor-lag "no observer cursor stored - run \`up\` to seed one"
  elif [ -z "$tip" ]; then
    fail_ cursor-lag "could not read the current ledger from $HORIZON_URL"
  else
    lag=$(( tip - cursor / 4294967296 ))
    if [ "$lag" -gt "$CURSOR_LAG_FAIL_LEDGERS" ]; then
      fail_ cursor-lag "$lag ledgers behind Horizon (limit $CURSOR_LAG_FAIL_LEDGERS) - a fresh payment will not be seen in time"
    else
      pass_ cursor-lag "$lag ledgers behind Horizon (limit $CURSOR_LAG_FAIL_LEDGERS)"
    fi
  fi

  printf '\n'
  if [ "$DOCTOR_FAILURES" -eq 0 ]; then
    printf '✓ stack is fit to run a corridor\n'
    return 0
  fi
  printf '✗ %s check(s) failed\n' "$DOCTOR_FAILURES"
  return 1
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
  status) podman ps --filter network="$NET" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' ;;
  doctor) doctor ;;
  *) die "usage: $0 <up|down|logs|status|doctor>" ;;
esac
