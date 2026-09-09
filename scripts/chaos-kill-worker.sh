#!/bin/sh
# chaos-kill-worker.sh — S3.8 operator chaos script (docs/development-tasks.md S3.8; design doc
# graph-ai-middle-platform-design.md §13 "Worker 崩溃 | Task 回 queued，attempt+1；已 executed 的
# ActionRequest 不重复"). POSIX sh, run ON THE HOST from the checkout root (docker compose reads
# ./docker-compose.yml and ./.env from cwd — same convention as scripts/restore.sh/accept_s1.sh).
#
# Usage:
#   sh scripts/chaos-kill-worker.sh <taskId> <apiKey> [pollTimeoutSeconds]
#
#   <taskId>   — an existing Task's id, currently running a Worker (e.g. from `get_task`/
#                `list_tasks`, the web console's Task view, or an accept_s2.sh run).
#   <apiKey>   — a human-channel API key for the same workspace as <taskId>, holding at least
#                `member` role (`get_task`'s own minRole) — `list_tasks`/`get_task` are both
#                dispatchable on the human channel: `application/gateway/authorize.ts`'s own doc
#                comment — "channel:'handle' capabilities are available to *both* channels" — a
#                `channel:'human'` guard only ever blocks the opposite direction. This is the same
#                "curl + API key from args" transport docs/runbooks/troubleshoot-task.md's own
#                `get_task` example already uses.
#   [pollTimeoutSeconds] — how long to wait for the reaper to notice and requeue/fail the Task
#                after the kill. Default 90 (application/task's own reaper runs on a 30s tick by
#                default, TASK_REAPER_INTERVAL_MS — 90s gives it up to 3 ticks).
#
# What this does:
#   1. `get_task` (human channel, through caddy) to find the Task's currently `running` WorkerRun
#      and record a baseline `status`/`attempt`.
#   2. `docker kill` the Worker container directly — not `docker compose kill`, since a Worker
#      container is not a compose service: it is spawned dynamically by worker-supervisor
#      (`packages/worker-supervisor/src/task-spawn-spec.ts`'s `taskContainerName`, literally
#      `nexttime-task-<workerRunId>` — the same convention this script recomputes from the
#      WorkerRun id `get_task` just returned, rather than trusting the wire's own `containerId`
#      field, which can be `null` before a container is fully provisioned).
#   3. Poll `get_task` again until the Task's own `status` leaves `running` — expected outcome
#      (§13): `queued` (the task reaper requeued it, `attempt` incremented — application/task's own
#      duration-limit/crash-recovery reconciliation) or `failed` (retries exhausted). Either is a
#      PASS; still `running`/`waiting_approval` after the timeout is a FAIL (the reaper never
#      caught the crash).
#
# Every docker compose run below carries </dev/null (same reasoning as accept_s1.sh's own header
# comment: non-interactive over ssh, no stdin to hang on).
#
# Confidentiality (repo is public): the API key lives only in a shell variable and one curl
# argument for this process's lifetime, never written to a file, and only ever printed via
# redact() (first 6 characters) — same convention as accept_s1.sh.

set -u

if [ "$#" -lt 2 ]; then
  echo "usage: sh scripts/chaos-kill-worker.sh <taskId> <apiKey> [pollTimeoutSeconds]" >&2
  exit 1
fi

TASK_ID="$1"
API_KEY="$2"
POLL_TIMEOUT_SECONDS="${3:-90}"
POLL_INTERVAL_SECONDS=5

if [ ! -f "./docker-compose.yml" ]; then
  echo "chaos-kill-worker: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "chaos-kill-worker: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi
if ! docker compose config >/dev/null 2>&1; then
  echo "chaos-kill-worker: 'docker compose config' failed — run this from the compose project" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${KERNEL_BIND_ADDR:-}" ]; then
  echo "chaos-kill-worker: .env must set KERNEL_BIND_ADDR" >&2
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

# One `get_task` call — human channel, through caddy (same transport docs/runbooks/
# troubleshoot-task.md's own §3.4 example uses). Prints the raw JSON response on stdout; caller
# extracts what it needs with sed/grep (no jq/node JSON parser assumed on the host — same
# constraint scripts/accept_s1.sh's own header comment documents).
get_task() {
  curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/get_task" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'content-type: application/json' \
    -d "{\"taskId\":\"$TASK_ID\"}"
}

# Extracts the currently `running` WorkerRun's id — relies on `toWireWorkerRun`
# (packages/kernel/src/application/gateway/handlers.ts) always serializing `id` immediately
# before `status` for each element of `workerRuns[]` (verified against that function's own field
# order); the first match is used, matching the state machine's own expectation of at most one
# `running` WorkerRun per Task at a time (design doc §5.5 WorkerRun: `provisioning → running →
# suspended → terminated`).
extract_running_worker_run_id() {
  printf '%s' "$1" | grep -o '"id":"[^"]*","status":"running"' | head -1 |
    sed -n 's/"id":"\([^"]*\)".*/\1/p'
}

extract_task_status() {
  printf '%s' "$1" | sed -n "s/.*\"id\":\"$TASK_ID\",\"status\":\"\([a-z_]*\)\".*/\1/p"
}

echo "chaos-kill-worker: taskId=$TASK_ID apiKey=$(redact "$API_KEY") pollTimeoutSeconds=$POLL_TIMEOUT_SECONDS"

baseline_resp=$(get_task)
case "$baseline_resp" in
  *'"ok":true'*) : ;;
  *) fail "get-task-baseline" "get_task failed for taskId=$TASK_ID: $baseline_resp" ;;
esac

baseline_status=$(extract_task_status "$baseline_resp")
[ -n "$baseline_status" ] || fail "get-task-baseline" "could not parse Task status: $baseline_resp"
worker_run_id=$(extract_running_worker_run_id "$baseline_resp")
if [ -z "$worker_run_id" ]; then
  fail "get-task-baseline" "no running WorkerRun found on Task $TASK_ID (status=$baseline_status) — nothing to kill"
fi
pass "get-task-baseline" "task status=$baseline_status running workerRunId=$worker_run_id"

container="nexttime-task-$worker_run_id"
if ! docker kill "$container" >/dev/null 2>&1; then
  fail "kill-worker-container" "docker kill $container failed (was it running?)"
fi
pass "kill-worker-container" "killed $container"

echo "chaos-kill-worker: polling get_task for up to ${POLL_TIMEOUT_SECONDS}s for §13's expected outcome (queued, attempt incremented, or failed) ..."
elapsed=0
final_status=""
while [ "$elapsed" -lt "$POLL_TIMEOUT_SECONDS" ]; do
  sleep "$POLL_INTERVAL_SECONDS"
  elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
  resp=$(get_task)
  case "$resp" in
    *'"ok":true'*) : ;;
    *) continue ;;
  esac
  status=$(extract_task_status "$resp")
  case "$status" in
    queued | failed)
      final_status="$status"
      final_resp="$resp"
      break
      ;;
    *) : ;;
  esac
done

if [ -z "$final_status" ]; then
  fail "task-recovered" "Task $TASK_ID did not reach queued/failed within ${POLL_TIMEOUT_SECONDS}s of killing $container (design doc §13 expects the task reaper to requeue or fail it)"
fi

pass "task-recovered" "task $TASK_ID status=$final_status (design doc §13: Worker 崩溃 -> Task 回 queued attempt+1, 或 failed)"

if [ "$final_status" = "queued" ]; then
  new_running_id=$(extract_running_worker_run_id "$final_resp")
  if [ -n "$new_running_id" ] && [ "$new_running_id" != "$worker_run_id" ]; then
    pass "worker-run-retried" "a new WorkerRun ($new_running_id) is already running, distinct from the killed one ($worker_run_id)"
  else
    pass "worker-run-retried" "queued — the retry has not started a new WorkerRun yet (a later poll would catch it; not re-polled here)"
  fi
fi

echo "chaos-kill-worker: done."
