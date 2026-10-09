#!/bin/sh
# staging-rehearsal.sh — rehearse one release apply end to end on a disposable Docker host: put the
# previous release on it the way the production host runs it (published images, the host-init
# scripts, the operator's one-time seeding), then apply the target through release.md §3's only
# entry — the target's own scripts/apply-release.sh, taken with `git show`; S3 → S1 → S2 → S4
# included — and optionally the real-model regression (docs/runbooks/host-accept-real-model.md). It is the cloud stand-in for "apply on the
# host and accept there" ahead of the host apply; it never replaces the host apply itself
# (docs/runbooks/staging-rehearsal.md says what stays host-only).
#
# Runs as root, from the root of a full clone of this repository (history + tags), on a host that
# is thrown away afterwards. .github/workflows/staging.yml is the caller of record (a GitHub-hosted
# runner: real Docker, IPv6, open egress); it installs gVisor first so host-preflight.sh passes.
#
# Usage:
#   sh scripts/staging-rehearsal.sh --disposable-host --from vA.B.C --to <tag|commit-ish> --work <dir>
#        [--worker-runtime runc|runsc] [--no-seed] [--no-verify] [--allow-baseline-failures]
#        [--real <provider/model> --real-providers <llm-providers.yaml> --real-env <file> [--runs N]
#         [--real-token-budget TOKENS]]
#
#   --disposable-host   required acknowledgement: this script bootstraps a fresh NEXTTIME_DATA,
#                       starts the whole `nexttime-ai` compose project and leaves it running. It
#                       refuses a host where that project already has containers, and a --work
#                       directory that is not empty — never point it at a host with real data.
#   --from vA.B.C       the release the staging host starts on (what production runs today).
#   --to <ref>          what to apply. A vX.Y.Z tag is applied as itself with `--pull` (published
#                       images; apply-release.sh falls back to a source build on its own). Anything
#                       else is resolved to a commit and given a local, never-pushed staging tag
#                       vA.(B+1).0-staging.<sha> — apply-release.sh only takes tags — then built from
#                       source; the tag is deleted again on exit.
#   --work <dir>        empty or missing directory for the checkout (<dir>/NextTime-AI — the compose
#                       project name is the directory name, so it matches the production host), the
#                       data root (<dir>/data) and every log (<dir>/logs).
#   --worker-runtime    WORKER_RUNTIME for the entry/worker containers. Default: what
#                       host-preflight.sh reports (runsc when its run test passes).
#   --no-seed           skip running the --from release's own S3/S1/S2/S4 before the apply. Seeding
#                       is what gives the migrations under test non-empty tables to run against, and
#                       proves the staging host itself is healthy (a --from baseline failure stops
#                       the rehearsal unless --allow-baseline-failures).
#   --no-verify         pass --no-verify to the --from release's pull-images.sh (skip the cosign
#                       check — only where the sigstore endpoints are unreachable; say so).
#   --real ...          after a clean apply, install a real provider (an llm-providers.yaml and its
#                       keys from --real-env, format below), regenerate models.json, and
#                       run accept_s2.sh/accept_s3.sh --real <provider/model> --runs N (default 3).
#                       Costs real tokens; the kernel's own per-workspace daily cap
#                       LLM_DAILY_TOKEN_BUDGET is set to --real-token-budget (default 3000000) first,
#                       so a runaway scenario is refused by the platform, not by luck. The model id and provider names are never printed by
#                       this script; the accept scripts do print the model id — callers scrub logs
#                       before publishing them (staging.yml does).
#
# Output follows apply-release.sh: one "STEP <name> …" line per step, "FAIL <name>" on a stop, and
# a last line "RESULT ok" or "RESULT failed-at=<step>" / "RESULT acceptance-failures=<n>" /
# "RESULT real-model-failures=<n>". Exit status 0 only for "RESULT ok".
#
# What it does NOT reproduce (and why, see the runbook): the production database's own data, the
# RagFlow upstream (gatekeeper-ragflow is moved to an unused compose profile by the staging overlay,
# so S4 covers the docker gate only), the LAN/RouterOS side, and a long-running host (restarts,
# the nightly backup schedule, other services sharing the host).
set -u

die() { echo "staging-rehearsal: $*" >&2; exit 2; }

disposable=0 FROM= TO= WORK= RUNTIME= seed=1 verify_flag= allow_baseline=0
REAL_MODEL= REAL_PROVIDERS= REAL_ENV= RUNS=3 BUDGET=3000000
while [ "$#" -gt 0 ]; do
  case "$1" in
    --disposable-host) disposable=1 ;;
    --from) FROM=${2:-}; shift ;;
    --to) TO=${2:-}; shift ;;
    --work) WORK=${2:-}; shift ;;
    --worker-runtime) RUNTIME=${2:-}; shift ;;
    --no-seed) seed=0 ;;
    --no-verify) verify_flag=--no-verify ;;
    --allow-baseline-failures) allow_baseline=1 ;;
    --real) REAL_MODEL=${2:-}; shift ;;
    --real-providers) REAL_PROVIDERS=${2:-}; shift ;;
    --real-env) REAL_ENV=${2:-}; shift ;;
    --runs) RUNS=${2:-}; shift ;;
    --real-token-budget) BUDGET=${2:-}; shift ;;
    *) die "unknown argument '$1' (see this script's header comment)" ;;
  esac
  shift
done

[ "$disposable" -eq 1 ] || die "refusing to run without --disposable-host (this script takes over the host's Docker; see the header comment)"
[ -n "$FROM" ] && [ -n "$TO" ] && [ -n "$WORK" ] || die "--from, --to and --work are required"
[ "$(id -u)" -eq 0 ] || die "run as root (the host-init scripts chown the data root to the container uid)"
[ -f docker-compose.yml ] && [ -f scripts/apply-release.sh ] || die "run from the repository root"
case "$FROM" in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "--from must be a release tag vX.Y.Z, got '$FROM'" ;; esac
case "$RUNTIME" in ''|runc|runsc) ;; *) die "--worker-runtime must be runc or runsc" ;; esac
case "$RUNS" in ''|*[!0-9]*) die "--runs must be a positive integer" ;; esac
case "$BUDGET" in ''|*[!0-9]*) die "--real-token-budget must be a positive integer" ;; esac
if [ -n "$REAL_MODEL$REAL_PROVIDERS$REAL_ENV" ]; then
  [ -n "$REAL_MODEL" ] && [ -f "$REAL_PROVIDERS" ] && [ -f "$REAL_ENV" ] ||
    die "--real needs all of --real <provider/model>, --real-providers <file> and --real-env <file>"
fi
REPO=$(pwd -P)
git rev-parse -q --verify "refs/tags/$FROM" >/dev/null || die "tag $FROM not found in this clone (fetch tags first)"
if [ -d "$WORK" ] && [ -n "$(ls -A "$WORK" 2>/dev/null)" ]; then
  die "--work $WORK is not empty"
fi
if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=nexttime-ai 2>/dev/null)" ]; then
  die "this host already has nexttime-ai containers — not a disposable host"
fi

CODE="$WORK/NextTime-AI"
D="$WORK/data"
LOGS="$WORK/logs"
mkdir -p "$LOGS" || die "cannot create $LOGS"

# --real: one file per provider key, named by its api_key_env (R-24: secrets/llm-provider-keys/<NAME>,
# the production host's layout — a key never sits in container env). Checked here, before anything
# is installed, so a malformed --real-env fails in seconds rather than after the apply. The env file
# holds NAME=value lines (`export ` and quotes allowed), or — when the yaml names exactly one
# api_key_env — just the key itself. Only counts are ever printed, never names or values.
REAL_KEYS="$WORK/real-keys"
if [ -n "$REAL_MODEL" ]; then
  mkdir -m 700 "$REAL_KEYS" || die "cannot create $REAL_KEYS"
  key_names=$(sed -n "s/^[[:space:]]*api_key_env:[[:space:]]*[\"']\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\).*/\1/p" "$REAL_PROVIDERS" | sort -u | tr '\n' ' ')
  env_shape=$(umask 077; awk -v dir="$REAL_KEYS" -v names="$key_names" -v q="'" -v qq='"' '
    function unquote(v) {
      if (length(v) >= 2 && (substr(v, 1, 1) == q || substr(v, 1, 1) == qq) && substr(v, length(v), 1) == substr(v, 1, 1))
        v = substr(v, 2, length(v) - 2)
      return v
    }
    function put(name, v,  f) { v = unquote(v); if (v == "") return; f = dir "/" name; printf "%s", v > f; close(f) }
    BEGIN { n = split(names, list, " ") }
    { sub(/\r$/, ""); sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") }
    $0 == "" || $0 ~ /^#/ { next }
    { lines++; last = $0 }
    match($0, /^(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=/) {
      kv++; name = substr($0, 1, RLENGTH - 1); sub(/^export[ \t]+/, "", name)
      put(name, substr($0, RLENGTH + 1))
    }
    END { if (kv == 0 && lines == 1 && n == 1 && last !~ /[ \t]/) put(list[1], last); printf "lines=%d name=value=%d", lines, kv }
  ' "$REAL_ENV") || die "--real-env: cannot read it"
  n_names=0 missing=0
  for k in $key_names; do
    n_names=$((n_names + 1))
    [ -s "$REAL_KEYS/$k" ] || missing=$((missing + 1))
  done
  [ "$n_names" -gt 0 ] || die "--real-providers names no api_key_env"
  [ "$missing" -eq 0 ] ||
    die "--real-env ($env_shape) lacks $missing of the $n_names api_key_env name(s) in --real-providers — give NAME=value per name (or just the key when there is exactly one)"
fi

STEP_T0=$(date +%s)
step() { echo "STEP $* ($(( $(date +%s) - STEP_T0 ))s)"; }
fail() { echo "FAIL $1${2:+ — $2}"; echo "RESULT failed-at=$1"; exit 1; }

# A staging tag this run created in $REPO is removed again however the run ends.
CREATED_TAG=
cleanup() { [ -n "$CREATED_TAG" ] && git -C "$REPO" tag -d "$CREATED_TAG" >/dev/null 2>&1; }
trap cleanup EXIT

# The staging checkout's origin must be this repository on GitHub, exactly like the production
# checkout: pull-images.sh derives the registry AND the cosign signer identity from it.
ORIGIN_URL=$(git config --get remote.origin.url 2>/dev/null)
case "$ORIGIN_URL" in *github.com[:/]*) ;; *) die "this clone's origin ('$ORIGIN_URL') is not a GitHub URL — pull-images.sh needs it to verify signatures" ;; esac

# --to: a release tag is applied as itself (published images); anything else gets a staging tag.
pull_flag=
if printf '%s\n' "$TO" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$' && git rev-parse -q --verify "refs/tags/$TO" >/dev/null; then
  TO_TAG=$TO
  pull_flag=--pull
else
  to_sha=$(git rev-parse -q --verify "$TO^{commit}") || die "--to '$TO' does not resolve to a commit"
  minor=$(printf '%s' "$FROM" | cut -d. -f2)
  TO_TAG="$(printf '%s' "$FROM" | cut -d. -f1).$((minor + 1)).0-staging.$(git rev-parse --short "$to_sha")"
  git rev-parse -q --verify "refs/tags/$TO_TAG" >/dev/null && die "tag $TO_TAG already exists"
  git tag "$TO_TAG" "$to_sha" || die "could not create the local staging tag $TO_TAG"
  CREATED_TAG=$TO_TAG
fi
echo "STEP start from=$FROM to=$TO_TAG ($(git rev-parse --short "$TO_TAG^{commit}")) images-to=${pull_flag:-build} seed=$seed work=$WORK"

# 1. preflight — this (target) version's host-preflight.sh; plus IPv6, which the docker socket
#    proxies need (they bind [::]:2375) and host-preflight.sh does not check.
[ -d /proc/sys/net/ipv6 ] || fail preflight "the host kernel has IPv6 disabled; docker-socket-proxy binds [::]:2375 and cannot start"
NEXTTIME_DATA="$D" sh scripts/host-preflight.sh >"$LOGS/preflight.log" 2>&1 </dev/null
pf_rc=$?
sed 's/^/STEP preflight /' "$LOGS/preflight.log" | grep -E 'FAIL|WARN|WORKER_RUNTIME|SUMMARY'
[ "$pf_rc" -eq 0 ] || fail preflight "see $LOGS/preflight.log"
[ -n "$RUNTIME" ] || RUNTIME=$(sed -n 's/^WORKER_RUNTIME=//p' "$LOGS/preflight.log" | tail -n 1)
[ -n "$RUNTIME" ] || RUNTIME=runc
step "preflight ok worker-runtime=$RUNTIME"

# 2. checkout — cloned from this clone (so a local staging tag comes along), then origin pointed at
#    GitHub like the production checkout. apply-release.sh's `git fetch origin --tags` never deletes
#    a local tag, so the staging tag survives it.
git clone -q "$REPO" "$CODE" && git -C "$CODE" remote set-url origin "$ORIGIN_URL" &&
  git -C "$CODE" checkout -q "$FROM" || fail checkout
cd "$CODE" || fail checkout
step "checkout $(git describe --tags --always HEAD)"

# 3. host init with the --from release's own scripts (docs/runbooks/README.md ① order, the same
#    calls scripts/drill-install.sh makes over SSH).
export NEXTTIME_DATA="$D"
for s in host-bootstrap host-env-init host-llm-proxy-init gen-handle-keys derive-internal-tokens; do
  [ -f "scripts/$s.sh" ] || continue
  sh "scripts/$s.sh" >>"$LOGS/host-init.log" 2>&1 </dev/null || fail "host-init" "scripts/$s.sh — see $LOGS/host-init.log"
done
step "host-init ok"

# 4. .env + staging overlay. The overlay lives in the data root (not the checkout), so it applies
#    to every release this checkout moves between, and only does what the header comment says.
mkdir -p "$D/staging"
cat >"$D/staging/docker-compose.staging.yml" <<'EOF'
# Written by scripts/staging-rehearsal.sh — the staging host has no RagFlow upstream, so the RagFlow
# gate stays out of `docker compose up` / `build` (it would restart-loop on RAGFLOW_BASE_URL).
services:
  gatekeeper-ragflow:
    profiles: ["staging-needs-ragflow"]
EOF
cat >.env <<EOF
NEXTTIME_DATA=$D
KERNEL_BIND_ADDR=127.0.0.1
KERNEL_PUBLIC_URL=https://127.0.0.1:8443
NEXTTIME_SUBNET_CONTROL=203.0.113.0/24
NEXTTIME_SUBNET_WORKERS=203.0.114.0/24
WORKER_RUNTIME=$RUNTIME
TZ=UTC
BACKUP_TIME=03:30
BACKUP_RETENTION=7
COMPOSE_FILE=docker-compose.yml:$D/staging/docker-compose.staging.yml
EOF
git check-ignore -q .env || fail env ".env is not git-ignored in $FROM"
docker compose config -q </dev/null || fail env "docker compose config"
step "env ok"

# 5. images: the --from release's published images (what production runs), plus the acceptance
#    fixtures, which are never published and are built on the host there too.
sh scripts/pull-images.sh $verify_flag "$FROM" >"$LOGS/pull-$FROM.log" 2>&1 </dev/null || fail images "pull-images.sh $FROM — see $LOGS/pull-$FROM.log"
step "images pulled $FROM"

# 6. database
docker compose up -d --wait postgres </dev/null >>"$LOGS/stack.log" 2>&1 || fail postgres
docker compose exec -T postgres sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "create extension if not exists vector"' </dev/null || fail postgres "create extension vector"
docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js </dev/null >"$LOGS/migrate-$FROM.log" 2>&1 || fail migrate "see $LOGS/migrate-$FROM.log"
step "migrate ok ($(grep -c '\.sql' "$LOGS/migrate-$FROM.log") files)"

# 7. the operator's one-time state on a production host: a working workspace with the ops-assets
#    domain pack (docs/runbooks/host-collector.md §1) and the collector's service Handle (§2) —
#    without that Handle file the collector service cannot even be created.
out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace --name staging --owner owner </dev/null 2>&1)
WS=$(printf '%s\n' "$out" | sed -n 's/^workspace created: //p')
OWNER=$(printf '%s\n' "$out" | sed -n 's/^owner principal: *//p')
[ -n "$WS" ] && [ -n "$OWNER" ] || fail seed-workspace "$(printf '%s' "$out" | tail -n 5)"
# The operator drops the pack into config/ontology/ first (docs/runbooks/add-domain-pack.md) —
# seed-domain-pack and accept_s3.sh's own seed step both read it from there, not from the image.
for f in ops-assets-v1.yaml ops-assets-v2.yaml; do
  [ -f "ontology/$f" ] || continue
  install -m 644 "ontology/$f" "$D/config/ontology/$f" || fail seed-domain-pack "copy $f into config/ontology"
  docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js seed-domain-pack \
    --workspace "$WS" --principal "$OWNER" --pack-name ops-assets --file-name "$f" </dev/null >>"$LOGS/seed.log" 2>&1 ||
    fail seed-domain-pack "$f — see $LOGS/seed.log"
done
tok="$D/secrets/collector-host-inventory.token"
docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js issue-service-handle --workspace "$WS" \
  --name host-inventory --scope register_source,submit_observations,observe_operation </dev/null 2>>"$LOGS/seed.log" |
  tail -n 1 >"$tok"
[ -s "$tok" ] || fail seed-collector-handle "see $LOGS/seed.log"
chgrp 10001 "$tok" && chmod 640 "$tok" || fail seed-collector-handle "permissions on $tok"
# worker-supervisor (uid 10001) registers each entry container's IP here; host-env-init.sh creates it
# root-owned, so without this every worker egress is denied as unknown-source
# (docs/runbooks/host-worker-runtime.md §4).
chown 10001:10001 "$D/config/egress-sources.json" || fail seed-egress-map "chown config/egress-sources.json"
step "seed-operator-state ok workspace=$WS"

# 8. up, then the administrator's catalog decision production has made: the docker gate instance
#    enabled (the same discovered → enabled SQL accept_s2.sh uses for its own admin step).
docker compose up -d --no-build </dev/null >>"$LOGS/stack.log" 2>&1 || fail up "see $LOGS/stack.log"
code=
for _ in $(seq 1 45); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/api/health || true)
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { docker compose ps -a >>"$LOGS/stack.log" 2>&1; fail up "caddy /api/health=$code"; }
psql_q() { docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\"" </dev/null; }
gate=
for _ in $(seq 1 30); do
  gate=$(psql_q "select status from gate_instances where gate_id='gatekeeper-docker'" 2>/dev/null)
  [ -n "$gate" ] && break
  sleep 2
done
[ -n "$gate" ] || fail up "gatekeeper-docker never announced itself (no gate_instances row)"
psql_q "update gate_instances set status='enabled', updated_at=now() where gate_id='gatekeeper-docker' and status='discovered'" >/dev/null
step "up ok services=$(docker compose ps --services --status running </dev/null | wc -l) docker-gate=$(psql_q "select status from gate_instances where gate_id='gatekeeper-docker'")"

# Run one acceptance suite of the checked-out release; prints its summary line, returns non-zero on
# any failure (exit status or a FAIL line) — the same rule apply-release.sh step 7 counts.
accept() {
  log="$LOGS/$1.log"; shift
  sh "$@" >"$log" 2>&1 </dev/null
  rc=$?
  nfail=$(grep -c '^FAIL' "$log")
  step "$(basename "$log" .log) exit=$rc pass=$(grep -c '^PASS' "$log") fail=$nfail"
  grep -E '^FAIL|^REAL |^S[1-4] (OK|NOTE)' "$log" | sort -u | head -n 12 | sed 's/^/STEP   /'
  [ "$rc" -eq 0 ] && [ "$nfail" -eq 0 ]
}

# 9. baseline: the --from release's own acceptance, in apply-release.sh's order. Fills the tables
#    the migrations under test then run over, and proves this host can pass what production passed.
if [ "$seed" -eq 1 ]; then
  for i in 1 2 3; do docker pull -q docker/dockerfile:1.7 >/dev/null 2>&1 && break; sleep 10; done
  base_fail=0
  for s in 3 1 2 4; do
    [ -f "scripts/accept_s$s.sh" ] || continue
    # One retry, reported: a released version's own races cannot be fixed in that version, and the
    # baseline only has to prove the host is equivalent (e.g. accept_s1 chat-bob reading history
    # before the agent-host runtime's assistant-message insert commits). The apply phase's suites
    # (apply-release.sh) are never retried.
    accept "baseline-$FROM-s$s" "scripts/accept_s$s.sh" ||
      { step "baseline-$FROM-s$s RETRY once — first attempt kept as baseline-$FROM-s$s-try1.log"
        mv "$LOGS/baseline-$FROM-s$s.log" "$LOGS/baseline-$FROM-s$s-try1.log"
        accept "baseline-$FROM-s$s" "scripts/accept_s$s.sh"; } ||
      base_fail=$((base_fail + 1))
  done
  docker compose --profile test stop fake-llm </dev/null >/dev/null 2>&1
  if [ "$base_fail" -gt 0 ] && [ "$allow_baseline" -eq 0 ]; then
    fail baseline "$base_fail suite(s) of $FROM failed on this host before any upgrade — the staging host is not equivalent; see $LOGS/baseline-*.log"
  fi
  step "baseline done failures=$base_fail"
fi

# 10. the apply itself, through docs/runbooks/release.md §3's only entry: the TARGET's own
#     apply-release.sh, copied out with `git show` (the checkout still sits on --from, whose copy
#     would run the old flow and skip every step the target added), run from the checkout root.
apply_script="$WORK/apply-release-$TO_TAG.sh"
git show "$TO_TAG:scripts/apply-release.sh" >"$apply_script" || fail apply "git show $TO_TAG:scripts/apply-release.sh"
step "apply via $TO_TAG:scripts/apply-release.sh (release.md §3)"
# A target whose apply owns config/egress-sources.json's ownership (#491) gets the file back as a
# fresh host-env-init.sh leaves it (root 0644), so that its own step — not the operator chown above,
# which the --from baseline needed — is what the target's S1/S2 egress probes then prove.
if grep -q 'STEP egress-sources' "$apply_script"; then
  chown 0:0 "$D/config/egress-sources.json" && chmod 644 "$D/config/egress-sources.json" ||
    fail apply "reset config/egress-sources.json to root before the apply"
  step "egress-sources reset to root 0644 — the target's apply-release.sh must hand it to uid 10001"
fi
APPLY_LOG_DIR="$LOGS" sh "$apply_script" $pull_flag "$TO_TAG" </dev/null >/dev/null 2>&1
apply_log=$(ls -t "$LOGS"/apply-"$TO_TAG"-*Z.log 2>/dev/null | head -n 1)
[ -n "$apply_log" ] || fail apply "apply-release.sh wrote no log"
grep -E '^(STEP|FAIL|RESULT)' "$apply_log" | grep -vE '^STEP (pull|backup-freshness) ' | sed 's/^/STEP apply | /'
apply_result=$(sed -n 's/^RESULT //p' "$apply_log" | tail -n 1)
case "$apply_result" in
  ok) step "apply ok $(git describe --tags --always HEAD)" ;;
  acceptance-failures=*) echo "RESULT $apply_result"; exit 1 ;;
  *) fail apply "${apply_result:-no RESULT line} — see $apply_log" ;;
esac

# 11. optional real-model regression on the applied release (docs/runbooks/host-accept-real-model.md).
if [ -n "$REAL_MODEL" ]; then
  printf "\nLLM_DAILY_TOKEN_BUDGET=%s\n" "$BUDGET" >>"$D/secrets/kernel.env" || fail real-setup "token budget"
  docker compose up -d --no-build --force-recreate --wait kernel </dev/null >>"$LOGS/stack.log" 2>&1 || fail real-setup "kernel recreate"
  install -m 644 "$REAL_PROVIDERS" "$D/config/llm-providers.yaml" || fail real-setup "providers file"
  # host-env-init.sh's convention for this directory: root-owned, group 10001, 0750; files 0640.
  install -d -m 750 -g 10001 "$D/secrets/llm-provider-keys" || fail real-setup "provider keys directory"
  for k in "$REAL_KEYS"/*; do
    install -m 640 -g 10001 "$k" "$D/secrets/llm-provider-keys/" || fail real-setup "provider key files"
  done
  rm -rf "$REAL_KEYS"
  docker compose up -d --no-build --force-recreate llm-proxy </dev/null >>"$LOGS/stack.log" 2>&1 || fail real-setup "llm-proxy recreate"
  docker compose run --rm --no-deps -T llm-proxy node dist/cli/gen-models.js </dev/null >"$D/models/models.json.tmp" 2>>"$LOGS/stack.log" &&
    mv "$D/models/models.json.tmp" "$D/models/models.json" || { rm -f "$D/models/models.json.tmp"; fail real-setup "gen-models"; }
  step "real-setup ok token-budget-per-workspace=$BUDGET"
  real_fail=0
  real_since=$(psql_q "select now()")
  accept "real-s2" scripts/accept_s2.sh --real "$REAL_MODEL" --runs "$RUNS" || real_fail=$((real_fail + 1))
  accept "real-s3" scripts/accept_s3.sh --real "$REAL_MODEL" --runs "$RUNS" || real_fail=$((real_fail + 1))
  # What the real-model phase spent, from the kernel's own llm_usage ledger (one row per proxied
  # call; the runner and its database are gone after the job), real provider only — the scripts'
  # provider-independent steps that follow on the fake provider are left out. Counts only.
  usage=$(psql_q "select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
    coalesce(sum(cache_read_tokens),0), coalesce(sum(cache_write_tokens),0), coalesce(sum(cost_usd),0)
    from llm_usage where started_at >= '$real_since' and provider <> 'fake'")
  printf '%s\n' "$usage" | awk -F'|' '{ printf "STEP real-usage calls=%s input_tokens=%s output_tokens=%s cache_read_tokens=%s cache_write_tokens=%s cost_usd=%s\n", $1, $2, $3, $4, $5, $6 }'
  if [ "$real_fail" -gt 0 ]; then echo "RESULT real-model-failures=$real_fail"; exit 1; fi
fi

step done
echo "RESULT ok"
