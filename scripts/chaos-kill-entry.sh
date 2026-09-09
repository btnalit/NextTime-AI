#!/bin/sh
# chaos-kill-entry.sh — S3.8 operator chaos script (docs/development-tasks.md S3.8; design doc
# graph-ai-middle-platform-design.md §13 "用户的入口容器崩溃 | supervisor 以同一工作目录重拉，pi 从
# JSONL 恢复"). POSIX sh, run ON THE HOST from the checkout root (docker compose reads
# ./docker-compose.yml and ./.env from cwd — same convention as scripts/restore.sh/accept_s1.sh).
# This is the same "kill alice's entry container mid-conversation, then continue" sequence
# scripts/accept_s1.sh's own `kill_and_continue_step` already drives against its own alice/bob
# fixtures — pulled out here as a standalone operator tool against an arbitrary already-running
# deployment (any workspace/principal/chat), not tied to accept_s1's own bootstrap.
#
# Usage:
#   sh scripts/chaos-kill-entry.sh <principalId> <apiKey> [chatId] [pollTimeoutSeconds]
#
#   <principalId>        — the human Principal whose resident entry container to kill
#                           (`nexttime-entry-<principalId>`, packages/worker-supervisor/src/
#                           spawn-spec.ts's `entryContainerName`).
#   <apiKey>              — that same principal's own API key (member role or above — send_chat_
#                           message's own minRole).
#   [chatId]              — an existing Chat owned by that principal to continue on. Omitted ->
#                           this script creates a fresh one via `new_chat`.
#   [pollTimeoutSeconds]  — how long to wait for the respawned container to show up with an
#                           incremented restarts count. Default 60.
#
# What this does:
#   1. GET /resident/<principalId> (worker-supervisor's internal-plane status endpoint — no host
#      port, control-network-only; reached the same way accept_s1.sh's own `resident_status()`
#      helper does: `docker compose run` a throwaway kernel-image container, presenting the
#      kernel's own internal-plane token) to record the baseline `restarts` count.
#   2. `docker kill nexttime-entry-<principalId>` directly — not `docker compose kill`, since an
#      entry container is not a compose service (worker-supervisor spawns it dynamically).
#   3. `send_chat_message` (human channel, through caddy) on <chatId> (creating one via `new_chat`
#      first if omitted) — this is the "next turn" that, per design doc §13, makes agent-host /
#      worker-supervisor notice the container is gone and respawn it
#      (`application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle` -> worker-supervisor's
#      `resident-service.ts` `spawn()`).
#   4. Poll GET /resident/<principalId> until `restarts` is strictly greater than the baseline and
#      `running` is true — the §13 expected outcome ("下一轮注入「上轮中断」"; restarts incremented).
#      Also confirms the triggering `send_chat_message` itself returned `ok:true` and that
#      `get_chat_history` shows the message count grew — proof the conversation mechanism itself
#      did not error out, not a full turn-completion check (see this script's own report for why:
#      a chaos operator tool should not assume a particular LLM backend's response shape).
#
# Every docker compose run below carries </dev/null (same reasoning as accept_s1.sh's own header
# comment). Confidentiality (repo is public): the API key lives only in a shell variable and curl
# arguments for this process's lifetime, never written to a file, only ever printed via redact()
# (first 6 characters) — same convention as accept_s1.sh.

set -u

if [ "$#" -lt 2 ]; then
  echo "usage: sh scripts/chaos-kill-entry.sh <principalId> <apiKey> [chatId] [pollTimeoutSeconds]" >&2
  exit 1
fi

PRINCIPAL_ID="$1"
API_KEY="$2"
CHAT_ID="${3:-}"
POLL_TIMEOUT_SECONDS="${4:-60}"
POLL_INTERVAL_SECONDS=5

if [ ! -f "./docker-compose.yml" ]; then
  echo "chaos-kill-entry: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "chaos-kill-entry: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi
if ! docker compose config >/dev/null 2>&1; then
  echo "chaos-kill-entry: 'docker compose config' failed — run this from the compose project" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${KERNEL_BIND_ADDR:-}" ]; then
  echo "chaos-kill-entry: .env must set KERNEL_BIND_ADDR" >&2
  exit 1
fi

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL %s %s\n' "$1" "$2" >&2
  exit 1
}

redact() {
  prefix=$(printf '%s' "$1" | cut -c1-6)
  printf '%s...(redacted)' "$prefix"
}

parse_kv() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1
}

# GET /resident/<principalId> via the kernel image's own fetch() against worker-supervisor
# (control-network-only — no host port), presenting the kernel's own internal-plane token — the
# exact pattern scripts/accept_s1.sh's own `resident_status()` helper already established.
resident_status() {
  docker compose run --rm --no-deps -T kernel node -e "
const token = require('fs').readFileSync('/run/secrets/internal_token', 'utf8').trim();
fetch('http://worker-supervisor:8081/resident/$1', { headers: { authorization: 'Bearer ' + token } }).then(async (r) => {
  if (r.status === 404) { console.log('FOUND=0'); return; }
  if (!r.ok) { console.log('FOUND=error status=' + r.status); return; }
  const j = await r.json();
  console.log('FOUND=1');
  console.log('RESTARTS=' + j.restarts);
  console.log('RUNNING=' + j.running);
});
" </dev/null 2>&1
}

echo "chaos-kill-entry: principalId=$PRINCIPAL_ID apiKey=$(redact "$API_KEY") pollTimeoutSeconds=$POLL_TIMEOUT_SECONDS"

baseline_raw=$(resident_status "$PRINCIPAL_ID")
baseline_found=$(parse_kv "$baseline_raw" FOUND)
if [ "$baseline_found" != "1" ]; then
  fail "resident-baseline" "GET /resident/$PRINCIPAL_ID did not report FOUND=1 (is the entry container running?): $baseline_raw"
fi
baseline_restarts=$(parse_kv "$baseline_raw" RESTARTS)
case "$baseline_restarts" in
  '' | *[!0-9]*) fail "resident-baseline" "could not parse RESTARTS from resident status: $baseline_raw" ;;
esac
pass "resident-baseline" "restarts=$baseline_restarts"

container="nexttime-entry-$PRINCIPAL_ID"
if ! docker kill "$container" >/dev/null 2>&1; then
  fail "kill-entry-container" "docker kill $container failed (was it running?)"
fi
pass "kill-entry-container" "killed $container"

if [ -z "$CHAT_ID" ]; then
  new_chat_resp=$(curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/new_chat" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'content-type: application/json' \
    -d '{}')
  case "$new_chat_resp" in
    *'"ok":true'*) : ;;
    *) fail "new-chat" "new_chat failed: $new_chat_resp" ;;
  esac
  CHAT_ID=$(printf '%s' "$new_chat_resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  [ -n "$CHAT_ID" ] || fail "new-chat" "could not parse chat id from response: $new_chat_resp"
  pass "new-chat" "created chat $CHAT_ID"
else
  pass "new-chat" "reusing given chatId=$CHAT_ID"
fi

send_resp=$(curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/send_chat_message" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"chatId\":\"$CHAT_ID\",\"text\":\"chaos-kill-entry probe (post-kill turn)\"}")
case "$send_resp" in
  *'"ok":true'*) : ;;
  *) fail "send-chat-message" "send_chat_message on chat $CHAT_ID failed: $send_resp" ;;
esac
turn_id=$(printf '%s' "$send_resp" | sed -n 's/.*"turnId":"\([^"]*\)".*/\1/p')
pass "send-chat-message" "sent — turnId=${turn_id:-unknown} (this is the §13 'next turn' that should trigger a respawn)"

echo "chaos-kill-entry: polling GET /resident/$PRINCIPAL_ID for up to ${POLL_TIMEOUT_SECONDS}s for restarts > $baseline_restarts ..."
elapsed=0
recovered=0
while [ "$elapsed" -lt "$POLL_TIMEOUT_SECONDS" ]; do
  sleep "$POLL_INTERVAL_SECONDS"
  elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
  raw=$(resident_status "$PRINCIPAL_ID")
  found=$(parse_kv "$raw" FOUND)
  [ "$found" = "1" ] || continue
  restarts=$(parse_kv "$raw" RESTARTS)
  running=$(parse_kv "$raw" RUNNING)
  case "$restarts" in
    '' | *[!0-9]*) continue ;;
  esac
  if [ "$restarts" -gt "$baseline_restarts" ] && [ "$running" = "true" ]; then
    recovered=1
    final_restarts="$restarts"
    break
  fi
done

if [ "$recovered" -ne 1 ]; then
  fail "entry-recovered" "GET /resident/$PRINCIPAL_ID did not show restarts > $baseline_restarts and running=true within ${POLL_TIMEOUT_SECONDS}s of killing $container"
fi
pass "entry-recovered" "restarts=$final_restarts (was $baseline_restarts), running=true — design doc §13: 入口容器崩溃 -> supervisor 以同一工作目录重拉"

history_resp=$(curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/get_chat_history" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"chatId\":\"$CHAT_ID\"}")
case "$history_resp" in
  *'"ok":true'*) pass "chat-continues" "get_chat_history on $CHAT_ID still answers after the kill (对话可续)" ;;
  *) fail "chat-continues" "get_chat_history on $CHAT_ID failed after the kill: $history_resp" ;;
esac

echo "chaos-kill-entry: done."
