#!/bin/sh
# chaos-kill-kernel-mid-invoke.sh — S5.6 operator chaos script (docs/development-tasks.md §5b
# "S5.6 稳定性缺陷" "`queued` 崩溃缺口"; I-S5-3, application/task/reaper.ts's
# `reapLostQueuedTasks`). POSIX sh, run ON THE HOST from the checkout root (docker compose reads
# ./docker-compose.yml and ./.env from cwd) — same structural conventions as
# scripts/chaos-kill-worker.sh / scripts/chaos-kill-entry.sh (this script's own template): every
# docker compose run/kill/up carries </dev/null where it talks to stdin, secrets live only in a
# shell variable and are only ever printed via redact() (first 6 characters).
#
# Usage:
#   sh scripts/chaos-kill-kernel-mid-invoke.sh <apiKey> [pollTimeoutSeconds]
#
#   <apiKey>              — a human-channel API key for the target workspace holding at least
#                            `builder` role (`propose_worker_definition`'s own minRole — this
#                            script also calls `publish_worker_definition`, channel:'human' with
#                            no additional minRole, and `invoke_worker`/`get_task`/`list_tasks`,
#                            all `member` at most, so `builder` already covers every call here).
#   [pollTimeoutSeconds]  — how long to wait for the Task to reach `completed`/`failed` after the
#                            kernel comes back, once it starts answering again. Default 150 — the
#                            crash-gap sweep's own 60s staleness threshold
#                            (`reaper.ts`'s `QUEUED_SPAWN_LOST_THRESHOLD_MS`) plus up to one full
#                            task-reaper tick (30s, `DEFAULT_TASK_REAPER_INTERVAL_MS`) plus margin.
#
# What this does, and why both outcomes below are a PASS (docs/development-tasks.md §5b "S5 新增
# 不变量" I-S5-3's own scope): `create_task` is retired — `invoke_worker` is the only path that
# ever inserts a Task at `queued`, and it always either spawns a WorkerRun and flips the row to
# `running`, or fails it synchronously in its own catch block on a caught spawn error
# (`application/task/invoke.ts`). If the kernel *process* dies in between, nothing is left to run
# either of those two outcomes — the Task sits orphaned at `queued` until `reapLostQueuedTasks`
# (60s staleness) notices and fails it `failure_reason='spawn_lost'`, never re-spawning it. This
# script tries to land `docker compose kill kernel` inside that exact window by firing the
# `invoke_worker` call in the background and killing the kernel immediately after, without waiting
# for a response — but the window is milliseconds wide and inherently a race from outside the
# process: a kill a beat late instead lands after the WorkerRun (and its container) already exist,
# in which case killing the *kernel* does not kill the already-spawned Worker container, and the
# Task reaches `completed` on its own once the kernel is back to receive its result. Both outcomes
# are accepted as PASS (this script prints which one it actually saw); anything else — the Task
# never found, still non-terminal after `pollTimeoutSeconds`, or `failed` with a failure_reason
# other than `spawn_lost` — is a FAIL.
#
#   1. Proposes + publishes a minimal, disposable worker-kind WorkerDefinition — `create_task`'s
#      retirement means there is no lighter-weight way to get a `queued` Task than a real
#      `invoke_worker` call (same reasoning chaos-kill-worker.sh's own header gives for operating
#      against a real Task rather than a synthetic fixture).
#   2. Fires `invoke_worker` (`wait:false`) in the background and, without waiting for it to
#      return, runs `docker compose kill kernel` (default signal: KILL — an abrupt crash, not a
#      graceful shutdown).
#   3. `docker compose up -d kernel` to bring it back.
#   4. Polls `list_tasks` until the kernel answers again, takes the newest Task (this script's own
#      workspace has no reason to have a newer one) as the Task the backgrounded `invoke_worker`
#      call created, then polls `get_task` on it until it reaches `completed` or `failed`.
#
# If the kernel died before the `invoke_worker` call's own Task INSERT even committed (a
# millisecond-scale sub-window of the already-narrow race), `list_tasks` finds no new Task at all
# after the restart — this script FAILs with a message to re-run rather than guessing; the race is
# probabilistic by nature, the same way any chaos experiment against a real timing window is.
#
# Confidentiality (repo is public): the API key lives only in a shell variable and curl arguments
# for this process's lifetime, never written to a file, only ever printed via redact() (first 6
# characters) — same convention as chaos-kill-worker.sh / chaos-kill-entry.sh.

set -u

if [ "$#" -lt 1 ]; then
  echo "usage: sh scripts/chaos-kill-kernel-mid-invoke.sh <apiKey> [pollTimeoutSeconds]" >&2
  exit 1
fi

API_KEY="$1"
POLL_TIMEOUT_SECONDS="${2:-150}"
POLL_INTERVAL_SECONDS=5
KERNEL_RESTART_TIMEOUT_SECONDS=60

if [ ! -f "./docker-compose.yml" ]; then
  echo "chaos-kill-kernel-mid-invoke: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "chaos-kill-kernel-mid-invoke: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi
if ! docker compose config >/dev/null 2>&1; then
  echo "chaos-kill-kernel-mid-invoke: 'docker compose config' failed — run this from the compose project" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${KERNEL_BIND_ADDR:-}" ]; then
  echo "chaos-kill-kernel-mid-invoke: .env must set KERNEL_BIND_ADDR" >&2
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

# One capability call — human channel, through caddy (same transport chaos-kill-worker.sh's own
# `get_task()` helper and docs/runbooks/troubleshoot-task.md's own examples use). Prints the raw
# JSON response on stdout.
cap() {
  curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/$1" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'content-type: application/json' \
    -d "$2"
}

list_tasks() {
  cap list_tasks '{}'
}

get_task() {
  cap get_task "{\"taskId\":\"$1\"}"
}

# Extracts the first `"id":"...","status":"..."` pair's id — relies on `TaskWireSchema`
# (packages/shared/src/wire/task.ts) always serializing `id` immediately before `status`, same
# convention chaos-kill-worker.sh's own `extract_running_worker_run_id` relies on.
# `list_tasks` returns newest-first (its own capability description) — the first match is this
# script's own just-created Task, provided nothing newer was created in this workspace meanwhile.
extract_first_task_id() {
  printf '%s' "$1" | grep -o '"id":"[^"]*","status":"[a-z_]*"' | head -1 |
    sed -n 's/"id":"\([^"]*\)".*/\1/p'
}

extract_status_for_id() {
  printf '%s' "$1" | sed -n "s/.*\"id\":\"$2\",\"status\":\"\([a-z_]*\)\".*/\1/p"
}

extract_failure_reason() {
  printf '%s' "$1" | sed -n 's/.*"failureReason":"\([^"]*\)".*/\1/p'
}

echo "chaos-kill-kernel-mid-invoke: apiKey=$(redact "$API_KEY") pollTimeoutSeconds=$POLL_TIMEOUT_SECONDS"

# --- 1. fixture: propose + publish a minimal worker-kind WorkerDefinition ---------------------

propose_resp=$(cap propose_worker_definition \
  '{"kind":"worker","definition":{"systemPrompt":"chaos-kill-kernel-mid-invoke fixture worker — reply with a short greeting and stop."}}')
case "$propose_resp" in
  *'"ok":true'*) : ;;
  *) fail "propose-worker-definition" "propose_worker_definition failed: $propose_resp" ;;
esac
definition_id=$(printf '%s' "$propose_resp" | sed -n 's/.*"id":"\([^"]*\)","version":[0-9]*.*/\1/p')
definition_version=$(printf '%s' "$propose_resp" | sed -n 's/.*"id":"[^"]*","version":\([0-9]*\).*/\1/p')
if [ -z "$definition_id" ] || [ -z "$definition_version" ]; then
  fail "propose-worker-definition" "could not parse id/version from response: $propose_resp"
fi
pass "propose-worker-definition" "definitionId=$definition_id version=$definition_version"

publish_resp=$(cap publish_worker_definition \
  "{\"definitionId\":\"$definition_id\",\"version\":$definition_version}")
case "$publish_resp" in
  *'"ok":true'*) : ;;
  *) fail "publish-worker-definition" "publish_worker_definition failed: $publish_resp" ;;
esac
pass "publish-worker-definition" "published $definition_id@$definition_version"

# --- 2. fire invoke_worker in the background, kill the kernel without waiting for a response ---

curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/invoke_worker" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  --max-time 20 \
  -d "{\"definitionId\":\"$definition_id\",\"version\":$definition_version,\"input\":{},\"wait\":false}" \
  >/dev/null 2>&1 &
invoke_pid=$!

if ! docker compose kill kernel >/dev/null 2>&1; then
  fail "kill-kernel" "docker compose kill kernel failed (was it running?)"
fi
pass "kill-kernel" "invoke_worker fired in the background (pid=$invoke_pid), kernel killed"

# --- 3. bring the kernel back -------------------------------------------------------------------

if ! docker compose up -d kernel >/dev/null 2>&1; then
  fail "restart-kernel" "docker compose up -d kernel failed"
fi
pass "restart-kernel" "kernel restarting"

echo "chaos-kill-kernel-mid-invoke: waiting up to ${KERNEL_RESTART_TIMEOUT_SECONDS}s for the kernel to answer again ..."
elapsed=0
list_resp=""
while [ "$elapsed" -lt "$KERNEL_RESTART_TIMEOUT_SECONDS" ]; do
  sleep 3
  elapsed=$((elapsed + 3))
  resp=$(list_tasks)
  case "$resp" in
    *'"ok":true'*)
      list_resp="$resp"
      break
      ;;
  esac
done
if [ -z "$list_resp" ]; then
  fail "kernel-recovered" "kernel did not answer list_tasks within ${KERNEL_RESTART_TIMEOUT_SECONDS}s of restart"
fi
pass "kernel-recovered" "kernel answering again after ${elapsed}s"

# --- 4. find the Task the backgrounded invoke_worker call created, poll it to a terminal status -

new_task_id=$(extract_first_task_id "$list_resp")
if [ -z "$new_task_id" ]; then
  fail "find-new-task" "list_tasks returned no Task after the kill+restart — the backgrounded invoke_worker call may not have reached its own INSERT before the kernel died (the crash window is a race); re-run this script"
fi
pass "find-new-task" "found taskId=$new_task_id"

echo "chaos-kill-kernel-mid-invoke: polling get_task for up to ${POLL_TIMEOUT_SECONDS}s for a terminal status (completed, or failed spawn_lost) ..."
elapsed=0
final_status=""
final_resp=""
while [ "$elapsed" -lt "$POLL_TIMEOUT_SECONDS" ]; do
  resp=$(get_task "$new_task_id")
  case "$resp" in
    *'"ok":true'*)
      status=$(extract_status_for_id "$resp" "$new_task_id")
      case "$status" in
        completed | failed)
          final_status="$status"
          final_resp="$resp"
          break
          ;;
      esac
      ;;
  esac
  sleep "$POLL_INTERVAL_SECONDS"
  elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
done

if [ -z "$final_status" ]; then
  fail "task-recovered" "Task $new_task_id did not reach completed/failed within ${POLL_TIMEOUT_SECONDS}s of the kernel coming back"
fi

if [ "$final_status" = "completed" ]; then
  pass "task-recovered" "task $new_task_id completed — the spawn had already finished before the kill landed this run (the crash window was missed); nothing for the reaper to recover"
else
  failure_reason=$(extract_failure_reason "$final_resp")
  if [ "$failure_reason" = "spawn_lost" ]; then
    pass "task-recovered" "task $new_task_id failed failure_reason=spawn_lost — the queued crash-gap sweep (reapLostQueuedTasks, I-S5-3) caught and failed it, without re-spawning"
  else
    fail "task-recovered" "task $new_task_id failed but failure_reason=${failure_reason:-<none>}, not spawn_lost — unexpected outcome"
  fi
fi

echo "chaos-kill-kernel-mid-invoke: done."
