#!/bin/sh
# drill-install.sh — S5.8 operator drill #1 (docs/development-tasks.md §"S5.8 交付与演示闭环",
# deliverable 1): "在一台只有 Docker 的干净主机上按 runbook 顺序走到三份验收通过；脚本只做编排与
# 计时，每一步失败即停并指出对应 runbook 小节；记录总耗时（含源码构建）。"
#
# Runs ON THE OPERATOR MACHINE (not on the target host) from this checkout's root — same
# convention scripts/drill-restore.sh documents for its own remote-vs-local split — and
# orchestrates the target host entirely over SSH, exactly the way docs/runbooks/host-*.md already
# document doing it by hand (`ssh <TARGET_HOST> 'NEXTTIME_DATA=... sh -s' < scripts/host-*.sh`).
# It never touches this machine's own filesystem beyond reading the scripts it pipes over SSH.
#
# Usage:
#   TARGET_HOST=<ssh-destination> CODE_DIR=<path-on-target> NEXTTIME_DATA=<path-on-target> \
#   KERNEL_BIND_ADDR=<target-host-address> \
#   NEXTTIME_SUBNET_CONTROL=<cidr> NEXTTIME_SUBNET_WORKERS=<cidr> \
#     sh scripts/drill-install.sh
#
# Required env:
#   TARGET_HOST               ssh destination (host, or an alias already in ~/.ssh/config).
#   CODE_DIR                  checkout directory to create on the target (docs/runbooks/
#                              host-checkout.md E3.1).
#   NEXTTIME_DATA              data root to create on the target (docs/runbooks/host-bootstrap.md).
#   KERNEL_BIND_ADDR           the address caddy's HTTPS entrypoint binds to (docs/runbooks/
#                              host-checkout.md E3.2, `.env`'s `KERNEL_BIND_ADDR`). This drill does
#                              NOT guess a routable address for an unknown host — see "manual gaps"
#                              below. Required.
#   NEXTTIME_SUBNET_CONTROL,
#   NEXTTIME_SUBNET_WORKERS    non-overlapping Docker network CIDRs for the control/worker planes
#                              (`.env`'s own two subnet vars). Also not guessed — pick values that
#                              don't collide with the `docker-network-subnets` row the preflight
#                              step below prints. Required.
#
# Optional env:
#   REF                        tag or branch to check out (docs/runbooks/host-checkout.md
#                              `BRANCH`). Default: main.
#   SSH                        ssh command override (e.g. `SSH="ssh -i /path/key -p 2222"`).
#                              Default: ssh.
#   REPO_URL                   overrides host-checkout.sh's own default repo URL.
#   KERNEL_PUBLIC_URL          default: https://${KERNEL_BIND_ADDR}:8443.
#   WORKER_RUNTIME              default: whatever the preflight step's own `WORKER_RUNTIME=`
#                              line reports (runsc if E1 passed, else runc).
#   TZ, BACKUP_TIME,
#   BACKUP_RETENTION          `.env`'s own backup-schedule vars. Defaults: UTC / 03:30 / 7.
#
# What "走到三份验收通过" means here: complete the host-init runbooks the stack needs (directory
# tree, secrets, `.env`, image builds, migrations, bringing the stack up), then run
# scripts/accept_s1.sh / accept_s2.sh / accept_s3.sh on the target over SSH in their default
# fake-provider mode (they switch providers themselves — see each script's own header comment).
# This drill does not reinvent the manual verification steps host-worker-runtime.md/
# host-agent-host.md walk a first-time operator through by hand (spawning demo containers, curling
# individual endpoints, …) — the three accept scripts already assert every one of those properties
# end to end; re-doing them here would just be a slower, less-covered copy.
#
# Dependency-order discrepancy (recorded per this drill's own dispatch brief): the S5.8 task text's
# stated order — host-preflight.md → host-bootstrap.md → host-checkout.md — contradicts
# docs/runbooks/README.md §①'s real order (preflight → checkout → bootstrap → caddy → explorer →
# worker-runtime → agent-host → gatekeepers → collector). This drill follows the README order for
# top-level runbooks, but README itself is not internally consistent either: host-checkout.md's
# own §E3.3 (secrets/config placeholders + Handle keys) is written as a *sub-step of the checkout
# runbook* yet textually depends on host-bootstrap.md's §E2 (`secrets/pg_password`) having already
# run — so "finish the host-checkout.md runbook top to bottom, then do host-bootstrap.md" (a literal
# reading of README's own table) does not work either. This drill resolves it the only way that is
# actually dependency-correct: clone the code (E3.1) → run host-bootstrap.sh (E2) → run
# host-env-init.sh + gen-handle-keys.sh (the rest of E3.3) → write `.env` (E3.2) → `docker compose
# config` (E3.4) → bring up postgres (E4). This interleaving is itself a delivery gap — see the
# runbook's 常见问题.
#
# Manual gaps this drill does NOT silently skip (see docs/runbooks/host-drills.md 常见问题 for the
# full list; every one of these is a genuine "found a delivery gap" per this task's own point):
#   - `.env` values that need real network knowledge (KERNEL_BIND_ADDR, the two subnets) — taken as
#     required env inputs above; the script stops with a runbook pointer if they're missing, it
#     never invents a placeholder that could silently collide with something already on the host.
#   - Trusting caddy's internal CA (docs/runbooks/host-caddy.md §E8.2) is inherently client-side
#     (each operator's own browser/OS trust store) — there is no host-side action for this script
#     to take. Not required for the three accept scripts (they use `curl -sk`/skip TLS verification
#     internally), only for a human opening the console in a browser afterward.
#   - The Explorer static bundle (docs/runbooks/host-explorer.md, `EXPLORER_BUILD=1`) is left at
#     its default placeholder — optional, and not exercised by accept_s1/s2/s3 (the three
#     `explorer-*` assertions in accept_s3.sh hit the kernel's own Graph/Decision API routes, not
#     the Explorer static frontend).
#   - A real LLM provider key (docs/runbooks/host-agent-host.md) is never requested — all three
#     accept scripts run against the fake provider they configure themselves; production
#     `${NEXTTIME_DATA}/config/llm-providers.yaml` is left as host-env-init.sh's empty placeholder.
#
# GUARD: refuses to run if the target already has $CODE_DIR/.env or a non-empty
# $NEXTTIME_DATA/pgdata — this must never be pointed at a host that already has real data on it.
# There is deliberately no override flag for this guard.

set -u

TARGET_HOST="${TARGET_HOST:-}"
CODE_DIR="${CODE_DIR:-}"
NEXTTIME_DATA="${NEXTTIME_DATA:-}"
REF="${REF:-main}"
SSH="${SSH:-ssh}"
REPO_URL="${REPO_URL:-}"
KERNEL_BIND_ADDR="${KERNEL_BIND_ADDR:-}"
KERNEL_PUBLIC_URL="${KERNEL_PUBLIC_URL:-}"
NEXTTIME_SUBNET_CONTROL="${NEXTTIME_SUBNET_CONTROL:-}"
NEXTTIME_SUBNET_WORKERS="${NEXTTIME_SUBNET_WORKERS:-}"
WORKER_RUNTIME="${WORKER_RUNTIME:-}"
TZ_VALUE="${TZ:-UTC}"
BACKUP_TIME="${BACKUP_TIME:-03:30}"
BACKUP_RETENTION="${BACKUP_RETENTION:-7}"

for var_name in TARGET_HOST CODE_DIR NEXTTIME_DATA; do
  eval "var_val=\${$var_name}"
  if [ -z "$var_val" ]; then
    echo "drill-install: $var_name is required (see this script's own header comment)" >&2
    exit 1
  fi
done

if [ ! -f "./docker-compose.yml" ]; then
  echo "drill-install: run this from the checkout root (where docker-compose.yml/scripts/ live) — it pipes scripts/host-*.sh to the target over SSH" >&2
  exit 1
fi

TOTAL_T0=$(date +%s)
SOURCE_BUILD_SECONDS=0
WORKER_RUNTIME_DETECTED=""

# --------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------

# remote "<command run under cd \$CODE_DIR on the target>"
remote() {
  $SSH "$TARGET_HOST" "cd \"$CODE_DIR\" && $1" </dev/null
}

step_start() {
  STEP_NAME="$1"
  STEP_T0=$(date +%s)
  printf 'STEP %s ...\n' "$STEP_NAME"
}

step_ok() {
  now=$(date +%s)
  printf 'STEP %s ... ok (%ds)\n' "$STEP_NAME" "$((now - STEP_T0))"
}

step_fail() {
  printf 'FAIL %s — see %s\n' "$STEP_NAME" "$1" >&2
  exit 1
}

# wait_healthy <service> <max-attempts (2s each)>
wait_healthy() {
  svc="$1"
  max="$2"
  n=0
  while [ "$n" -lt "$max" ]; do
    out=$(remote "docker compose ps $svc --format json" 2>/dev/null)
    case "$out" in
      *'"Health":"healthy"'*) return 0 ;;
    esac
    n=$((n + 1))
    sleep 2
  done
  return 1
}

# --------------------------------------------------------------------------------------------
# ssh-connectivity
# --------------------------------------------------------------------------------------------

step_start "ssh-connectivity"
PING_OUT=$($SSH "$TARGET_HOST" "echo ok" </dev/null 2>&1)
if [ "$PING_OUT" != "ok" ]; then
  echo "$PING_OUT" >&2
  step_fail "cannot reach TARGET_HOST=$TARGET_HOST over SSH (SSH=\"$SSH\") — fix connectivity/credentials first"
fi
step_ok

# --------------------------------------------------------------------------------------------
# guard-target — refuse to run against a host that already looks deployed
# --------------------------------------------------------------------------------------------

step_start "guard-target"
ENV_EXISTS=$($SSH "$TARGET_HOST" "[ -f \"$CODE_DIR/.env\" ] && echo yes || echo no" </dev/null 2>/dev/null)
PGDATA_NONEMPTY=$($SSH "$TARGET_HOST" "[ -d \"$NEXTTIME_DATA/pgdata\" ] && [ -n \"\$(ls -A \"$NEXTTIME_DATA/pgdata\" 2>/dev/null)\" ] && echo yes || echo no" </dev/null 2>/dev/null)
if [ "$ENV_EXISTS" = "yes" ] || [ "$PGDATA_NONEMPTY" = "yes" ]; then
  echo "drill-install: $CODE_DIR/.env exists=$ENV_EXISTS, $NEXTTIME_DATA/pgdata non-empty=$PGDATA_NONEMPTY — this host already looks deployed" >&2
  step_fail "this drill refuses to run against a host that already has \$CODE_DIR/.env or a non-empty \$NEXTTIME_DATA/pgdata (no override — never point this at a host with real data)"
fi
step_ok

# --------------------------------------------------------------------------------------------
# preflight (docs/runbooks/host-preflight.md)
# --------------------------------------------------------------------------------------------

step_start "preflight"
PREFLIGHT_OUT=$($SSH "$TARGET_HOST" "NEXTTIME_DATA='$NEXTTIME_DATA' sh -s" < scripts/host-preflight.sh 2>&1)
PREFLIGHT_RC=$?
printf '%s\n' "$PREFLIGHT_OUT"
if [ "$PREFLIGHT_RC" -ne 0 ]; then
  step_fail "docs/runbooks/host-preflight.md — resolve every FAIL row printed above before re-running"
fi
WORKER_RUNTIME_DETECTED=$(printf '%s\n' "$PREFLIGHT_OUT" | sed -n 's/^WORKER_RUNTIME=//p' | tail -1)
step_ok

# --------------------------------------------------------------------------------------------
# checkout — clone only (docs/runbooks/host-checkout.md §E3.1); §E3.2/§E3.3/§E3.4 come later,
# after bootstrap, per the dependency-order note in this script's header comment.
# --------------------------------------------------------------------------------------------

step_start "checkout"
# host-checkout.sh only knows branches (fetch + reset to origin/$BRANCH). A release tag as REF
# is the customer-facing case (docs/runbooks/release.md §3): clone main first, then pin the tag
# the way that runbook documents.
REF_IS_TAG=0
if git ls-remote --tags origin "refs/tags/$REF" 2>/dev/null | grep -q "refs/tags/$REF\$"; then
  REF_IS_TAG=1
fi
CHECKOUT_BRANCH="$REF"
if [ "$REF_IS_TAG" -eq 1 ]; then
  CHECKOUT_BRANCH="main"
fi
CHECKOUT_CMD="CODE_DIR='$CODE_DIR' BRANCH='$CHECKOUT_BRANCH'"
if [ -n "$REPO_URL" ]; then
  CHECKOUT_CMD="$CHECKOUT_CMD REPO_URL='$REPO_URL'"
fi
if ! $SSH "$TARGET_HOST" "$CHECKOUT_CMD sh -s" < scripts/host-checkout.sh; then
  step_fail "docs/runbooks/host-checkout.md §E3.1"
fi
if [ "$REF_IS_TAG" -eq 1 ]; then
  if ! remote "git fetch origin --tags && git checkout \"$REF\" && git rev-parse HEAD"; then
    step_fail "docs/runbooks/release.md §3 (pinning the checkout to tag $REF)"
  fi
fi
step_ok

# --------------------------------------------------------------------------------------------
# bootstrap (docs/runbooks/host-bootstrap.md, task E2)
# --------------------------------------------------------------------------------------------

step_start "bootstrap"
if ! $SSH "$TARGET_HOST" "NEXTTIME_DATA='$NEXTTIME_DATA' sh -s" < scripts/host-bootstrap.sh; then
  step_fail "docs/runbooks/host-bootstrap.md"
fi
step_ok

# --------------------------------------------------------------------------------------------
# env-init + handle-keys (docs/runbooks/host-checkout.md §E3.3 — needs bootstrap's
# secrets/pg_password to already exist, see the dependency-order note above)
# --------------------------------------------------------------------------------------------

step_start "env-init"
if ! $SSH "$TARGET_HOST" "NEXTTIME_DATA='$NEXTTIME_DATA' sh -s" < scripts/host-env-init.sh; then
  step_fail "docs/runbooks/host-checkout.md §E3.3"
fi
step_ok

step_start "handle-keys"
if ! $SSH "$TARGET_HOST" "NEXTTIME_DATA='$NEXTTIME_DATA' sh -s" < scripts/gen-handle-keys.sh; then
  step_fail "docs/runbooks/host-checkout.md §E3.3"
fi
step_ok

# --------------------------------------------------------------------------------------------
# write-env (docs/runbooks/host-checkout.md §E3.2) — the genuinely-manual step: this drill will
# not guess a routable bind address or non-overlapping subnets for an unknown host.
# --------------------------------------------------------------------------------------------

step_start "write-env"
if [ -z "$KERNEL_BIND_ADDR" ] || [ -z "$NEXTTIME_SUBNET_CONTROL" ] || [ -z "$NEXTTIME_SUBNET_WORKERS" ]; then
  echo "drill-install: write-env needs KERNEL_BIND_ADDR, NEXTTIME_SUBNET_CONTROL, NEXTTIME_SUBNET_WORKERS —" >&2
  echo "  pick real, non-overlapping values (see the preflight step's docker-network-subnets row" >&2
  echo "  above for what's already in use on this host) and re-run with them set. This drill does" >&2
  echo "  not guess network values for an unknown host — that is a genuine manual step, not a gap" >&2
  echo "  this script papers over." >&2
  step_fail "docs/runbooks/host-checkout.md §E3.2 (manual step)"
fi
KERNEL_PUBLIC_URL="${KERNEL_PUBLIC_URL:-https://${KERNEL_BIND_ADDR}:8443}"
EFFECTIVE_WORKER_RUNTIME="${WORKER_RUNTIME:-${WORKER_RUNTIME_DETECTED:-runc}}"
ENV_FILE_CONTENT=$(cat <<EOF
NEXTTIME_DATA=$NEXTTIME_DATA
KERNEL_BIND_ADDR=$KERNEL_BIND_ADDR
KERNEL_PUBLIC_URL=$KERNEL_PUBLIC_URL
NEXTTIME_SUBNET_CONTROL=$NEXTTIME_SUBNET_CONTROL
NEXTTIME_SUBNET_WORKERS=$NEXTTIME_SUBNET_WORKERS
WORKER_RUNTIME=$EFFECTIVE_WORKER_RUNTIME
DOCKER_GID=999
TZ=$TZ_VALUE
BACKUP_TIME=$BACKUP_TIME
BACKUP_RETENTION=$BACKUP_RETENTION
EOF
)
if ! printf '%s\n' "$ENV_FILE_CONTENT" | $SSH "$TARGET_HOST" "cat > \"$CODE_DIR/.env\""; then
  step_fail "docs/runbooks/host-checkout.md §E3.2"
fi
IGNORED=$(remote "git check-ignore .env")
if [ -z "$IGNORED" ]; then
  step_fail "docs/runbooks/host-checkout.md §E3.2 — .env is not git-ignored in this checkout, refusing to continue"
fi
step_ok

# --------------------------------------------------------------------------------------------
# compose-config (docs/runbooks/host-checkout.md §E3.4)
# --------------------------------------------------------------------------------------------

step_start "compose-config"
if ! remote "docker compose config >/dev/null"; then
  step_fail "docs/runbooks/host-checkout.md §E3.4"
fi
step_ok

# --------------------------------------------------------------------------------------------
# build — timed separately from the total (docs/runbooks/host-caddy.md, host-worker-runtime.md
# §2, host-gatekeepers.md, host-collector.md — every image these runbooks build). `--profile
# test` covers every default-profile service plus fake-llm; worker-runtime (profiles: [build-
# only]) needs its own explicit `docker compose build worker-runtime` (docs/runbooks/
# host-worker-runtime.md §2's own convention — build honors an explicitly-named service
# regardless of its profile).
# --------------------------------------------------------------------------------------------

step_start "build"
BUILD_T0=$(date +%s)
remote "export KERNEL_VERSION=\"\$(git describe --tags --abbrev=0) (\$(git rev-parse --short HEAD))\" && docker compose --profile test build"
BUILD_RC1=$?
remote "docker compose build worker-runtime"
BUILD_RC2=$?
BUILD_T1=$(date +%s)
SOURCE_BUILD_SECONDS=$((BUILD_T1 - BUILD_T0))
if [ "$BUILD_RC1" -ne 0 ] || [ "$BUILD_RC2" -ne 0 ]; then
  step_fail "docs/runbooks/host-caddy.md / host-worker-runtime.md §2 (image build failed — see output above)"
fi
step_ok

# --------------------------------------------------------------------------------------------
# postgres-up (docs/runbooks/host-checkout.md §E4)
# --------------------------------------------------------------------------------------------

step_start "postgres-up"
if ! remote "docker compose up -d postgres"; then
  step_fail "docs/runbooks/host-checkout.md §E4"
fi
wait_healthy postgres 45 || step_fail "docs/runbooks/host-checkout.md §E4 — postgres did not become healthy within ~90s"
if ! remote "docker compose exec -T postgres psql -U nexttime -d nexttime -c \"create extension if not exists vector;\""; then
  step_fail "docs/runbooks/host-checkout.md §E4"
fi
step_ok

# --------------------------------------------------------------------------------------------
# migrate (docs/runbooks/operations.md §4.1 — containerized path, no node/corepack on the host)
# --------------------------------------------------------------------------------------------

step_start "migrate"
remote "docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js --dry-run"
if ! remote "docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js"; then
  step_fail "docs/runbooks/operations.md §4.1"
fi
step_ok

# --------------------------------------------------------------------------------------------
# stack-up — the rest of the services (docs/runbooks/README.md §①: caddy, explorer's backend
# routes, worker-runtime's supervisor, agent-host, gatekeepers, collector all come up together;
# `--profile test` also brings up fake-llm). compose's own `depends_on`/healthcheck graph orders
# docker-socket-proxy(-gate/-collector) and kernel ahead of their consumers.
# --------------------------------------------------------------------------------------------

step_start "stack-up"
if ! remote "docker compose --profile test up -d"; then
  step_fail "docs/runbooks/README.md ①"
fi
wait_healthy kernel 45 || step_fail "docs/runbooks/operations.md §4.1 — kernel did not become healthy within ~90s"
step_ok

# --------------------------------------------------------------------------------------------
# caddy-health (docs/runbooks/host-caddy.md §E8.3, lite form — the three accept scripts below
# are the real verification; this is just "is TLS even serving")
# --------------------------------------------------------------------------------------------

step_start "caddy-health"
HEALTH_CODE=$(remote "curl -sk -o /dev/null -w '%{http_code}' \"https://${KERNEL_BIND_ADDR}:8443/api/health\"")
if [ "$HEALTH_CODE" != "200" ]; then
  step_fail "docs/runbooks/host-caddy.md §E8.3 (health=$HEALTH_CODE, expected 200)"
fi
step_ok

# --------------------------------------------------------------------------------------------
# accept_s1 / accept_s2 / accept_s3 (their default fake-provider mode; each script switches
# providers itself and restores production wiring on exit — see each script's own header).
# --------------------------------------------------------------------------------------------

run_accept() {
  name="$1"
  script="$2"
  ok_line="$3"
  runbook="$4"
  step_start "$name"
  out=$($SSH "$TARGET_HOST" "cd \"$CODE_DIR\" && sh $script" </dev/null 2>&1)
  rc=$?
  printf '%s\n' "$out" | tail -10
  if [ "$rc" -ne 0 ] || ! printf '%s\n' "$out" | grep -qx "$ok_line"; then
    step_fail "$runbook"
  fi
  step_ok
}

run_accept "accept-s1" "scripts/accept_s1.sh" "S1 OK" "docs/runbooks/accept-s1.md"
run_accept "accept-s2" "scripts/accept_s2.sh" "S2 OK" "docs/runbooks/host-accept-s2.md"
run_accept "accept-s3" "scripts/accept_s3.sh" "S3 OK" "docs/runbooks/host-accept-s3.md"

# --------------------------------------------------------------------------------------------
# done
# --------------------------------------------------------------------------------------------

TOTAL_T1=$(date +%s)
echo ""
echo "DRILL-INSTALL OK"
echo "total elapsed: $((TOTAL_T1 - TOTAL_T0))s (source build: ${SOURCE_BUILD_SECONDS}s of that total)"
echo ""
echo "drill-install: known manual/out-of-scope items NOT covered by this drill (docs/runbooks/host-drills.md 常见问题):"
echo "  - browser trust of caddy's internal CA (host-caddy.md §E8.2) — client-side, per operator machine, not needed for S1/S2/S3"
echo "  - Explorer static bundle build (host-explorer.md, EXPLORER_BUILD=1) — optional, left at the placeholder page"
echo "  - a real LLM provider key (host-agent-host.md) — accept_s1/s2/s3 ran entirely on the fake provider; config/llm-providers.yaml is still host-env-init.sh's empty placeholder"
echo "  - models/models.json is still host-env-init.sh's '{}' placeholder — fine for accept_s1/s2/s3 (they generate their own fake accept/models.json); a real deployment needs 'make gen-models' once a provider is configured"
