#!/bin/sh
# drill-upgrade.sh — S5.8 operator drill #2 (docs/development-tasks.md §"S5.8 交付与演示闭环",
# deliverable 2): upgrade from the currently-deployed version v(n-1) to a new tag v(n), run the
# three acceptance scripts, gather reversibility evidence (does v(n-1)'s own code still pass its
# own acceptance suite against v(n)'s schema?), then roll all the way back — code AND database —
# to v(n-1) and re-verify with S1. Same conventions scripts/drill-restore.sh already established:
# POSIX sh, `set -u`, PASS/FAIL lines (first FAIL aborts), an EXIT trap that always cleans up its
# own temp file, `</dev/null` on every `docker compose run`/`exec`.
#
# Runs ON THE HOST, from the checkout root (same as drill-restore.sh — NOT over SSH: this script
# itself does the `git checkout`s and `docker compose` calls directly, because the whole point is
# to flip the checkout between v(n-1) and v(n) in place, which only makes sense run locally on the
# host that owns that checkout).
#
# Usage:
#   sh scripts/drill-upgrade.sh --to vX.Y.Z --ack-live-restore
#
#   --to <vX.Y.Z>        (required) the tag to upgrade to. Must already exist on origin
#                         (`git fetch origin --tags` first if it was only just pushed).
#   --ack-live-restore    (required) this drill overwrites the LIVE `nexttime` database during its
#                         rollback phase (`scripts/restore.sh --target-db nexttime --i-know`) —
#                         refuses to run without this explicit acknowledgement. There is
#                         deliberately no default/override that skips it.
#   --keep-dump           accepted as a no-op — the pre-upgrade dump is NEVER deleted by this
#                         drill regardless of this flag (its path is always printed at the end);
#                         this flag exists only so a habitual `--keep-dump` doesn't error out.
#
# Preconditions: same as drill-restore.sh — `docker compose config` must succeed from this
# directory, the stack (at least postgres + kernel) must already be up, and `./.env` must exist.
# Additionally: the working tree must be clean (this script moves HEAD around with `git checkout`
# and refuses to risk losing uncommitted work) and the target tag must already exist on origin.
#
# Self-protection: this script does `git checkout` on the very checkout it is itself running from,
# three times (to v(n), back to v(n-1) for the PROBE, back to v(n-1) again for rollback). A POSIX
# `sh` reads a running script from disk in buffered chunks, so if a release ever changes this
# file's own bytes between v(n-1) and v(n) the shell could read mixed content. The first thing the
# script does is therefore copy itself to a temp file outside the checkout and `exec` that copy
# (DRILL_UPGRADE_SELF_COPY marks the copy so it does not recurse); the copy removes itself in the
# EXIT trap. The accept_*.sh scripts it calls are deliberately NOT copied — running each version's
# own acceptance scripts is the point.
#
# Branch handling: the host normally sits on a branch (docs/runbooks/host-checkout.md resets to
# origin/main) or on a pinned tag (docs/runbooks/release.md §3). The drill records both the exact
# commit and, when on a branch, the branch name, and rolls back to the branch (verified to still
# resolve to the recorded commit) so the checkout ends where it started — not detached at the same
# commit.
#
# What this drills (docs/development-tasks.md's own deliverable-2 text): "用上一发布版的数据目录 +
# backup.sh 产物 → 检出新版 → make migrate → 三份验收 → 用 restore.sh 回滚到备份并再跑 S1 验收".
# This script additionally captures the reversibility evidence release.md's "迁移可逆性" table asks
# for (docs/runbooks/release.md, new section) — see the PROBE step below — since that is the
# concrete mechanism the S5.8 task text names as the source of that evidence.
#
# Sequence (each phase's elapsed time is printed in the final summary):
#   1. preflight            — stack running, git tree clean, --to tag exists on origin, records
#                              v(n-1)'s commit.
#   2. pre-upgrade dump      — docker compose run --rm -e BACKUP_NOW=1 backup, resolve the dump it
#                              produced (same resolution logic scripts/drill-restore.sh uses).
#                              NEVER deleted by this script.
#   3. checkout v(n)         — git fetch origin --tags && git checkout <to>, then layout_step:
#                              reconcile ${NEXTTIME_DATA}/models/ vs config/models.json and
#                              ${NEXTTIME_DATA}/llm-proxy/ against whatever v(n)'s own
#                              docker-compose.yml mounts expect (docs/runbooks/release.md §3.2) —
#                              detected from the checked-out tree, not from TO_TAG/FROM_TAG.
#   4. build v(n)            — docker compose --profile test build (every default-profile service
#                              + fake-llm) + docker compose build worker-runtime (build-only
#                              profile, named explicitly — docs/runbooks/host-worker-runtime.md §2's
#                              own convention).
#   5. migrate               — --dry-run listing (informational) then the real apply, containerized
#                              (docs/runbooks/operations.md §4.1).
#   6. up v(n)                — docker compose --profile test up -d.
#   7. accept S1/S2/S3 (v(n)) — scripts/accept_s1.sh / accept_s2.sh / accept_s3.sh, their default
#                              fake-provider mode. A failure here IS a drill failure — "三份验收
#                              通过" is the acceptance criterion for the upgrade half.
#   8. PROBE                 — checkout v(n-1) (+ layout_step, same reconciliation as step 3 but
#                              back to whatever v(n-1)'s own tree expects), build, up -d (schema is
#                              still v(n) — migrations were never rolled back), run accept_s1.sh
#                              (v(n-1)'s OWN copy of it) against that schema. Prints `PROBE
#                              old-code-on-new-schema ok` or `PROBE old-code-on-new-schema failed`
#                              — NON-FATAL either way; this is the reversibility evidence
#                              docs/runbooks/release.md's table cites, not a pass/fail gate on this
#                              drill.
#   9. rollback proper        — re-affirm v(n-1) is checked out/built/up (idempotent — step 8 already
#                              did this, including layout_step; done again here so rollback is
#                              correct even if the PROBE step above failed outright, e.g. a build
#                              failure), THEN
#                              `sh scripts/restore.sh --db <pre-upgrade dump> --target-db nexttime
#                              --i-know` (restore.sh's own EXIT trap restarts kernel/agent-host/
#                              worker-supervisor/backup — since those are already v(n-1) images at
#                              this point, the restart lands on v(n-1) code, not v(n)).
#  10. accept S1 (post-rollback) — scripts/accept_s1.sh once more, now v(n-1) code against the
#                              restored v(n-1) database. A failure here IS a drill failure — "回滚
#                              后 S1 通过" is the rollback half's acceptance criterion.
#
# End state: v(n-1) code checked out and running, database restored to its pre-upgrade content.
# Known leftover (recorded, not solved — see docs/runbooks/host-drills.md 常见问题): the S3
# ephemeral-workspace directories under ${NEXTTIME_DATA}/workspaces/ created during step 7/8/10's
# accept_s3.sh runs survive the database restore as orphans on disk (the restore only touches
# Postgres) — this drill does not clean them up, same as a real rollback would not either.
# Similarly, any version-specific manual post-migrate step a release's own runbook/STATUS 主机应用
#注意 called for (e.g. a one-off data fix) is undone by the restore and must be redone by hand
# during a real upgrade — this drill cannot know about those out-of-band steps and does not
# attempt to replay them.

set -u

# Re-exec from a copy outside the checkout before anything else (see the header comment). Done
# before argument parsing so "$@" is still intact.
if [ -z "${DRILL_UPGRADE_SELF_COPY:-}" ]; then
  self_copy=$(mktemp /tmp/nt-drill-upgrade-self.XXXXXX) || {
    echo "drill-upgrade: mktemp failed" >&2
    exit 1
  }
  if ! cat "$0" >"$self_copy"; then
    rm -f "$self_copy"
    echo "drill-upgrade: could not copy $0 to $self_copy" >&2
    exit 1
  fi
  DRILL_UPGRADE_SELF_COPY="$self_copy"
  export DRILL_UPGRADE_SELF_COPY
  exec sh "$self_copy" "$@"
fi

TO_TAG=""
ACK_LIVE_RESTORE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      TO_TAG="${2:-}"
      shift 2
      ;;
    --ack-live-restore)
      ACK_LIVE_RESTORE=1
      shift
      ;;
    --keep-dump)
      # implied always (see this script's own header comment) — accepted as a no-op.
      shift
      ;;
    *)
      echo "drill-upgrade: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TO_TAG" ]; then
  echo "drill-upgrade: --to <vX.Y.Z> is required" >&2
  exit 1
fi
if [ "$ACK_LIVE_RESTORE" -ne 1 ]; then
  echo "drill-upgrade: --ack-live-restore is required — this drill overwrites the live 'nexttime'" >&2
  echo "  database during its rollback phase (scripts/restore.sh --target-db nexttime --i-know)." >&2
  echo "  Refusing without explicit acknowledgement." >&2
  exit 1
fi

if [ ! -f "./docker-compose.yml" ]; then
  echo "drill-upgrade: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "drill-upgrade: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi
if [ ! -f "./scripts/restore.sh" ]; then
  echo "drill-upgrade: scripts/restore.sh not found — run this from the checkout root" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ]; then
  echo "drill-upgrade: .env must set NEXTTIME_DATA" >&2
  exit 1
fi

# --------------------------------------------------------------------------------------------
# PASS/FAIL helpers — same contract as scripts/drill-restore.sh / scripts/accept_s1.sh.
# --------------------------------------------------------------------------------------------

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

# leftover 60: a FAIL anywhere from up_step("to") onward (migrations already applied — MIGRATIONS_
# APPLIED set below, right after migrate_step succeeds) used to exit 1 here with no more than the
# one FAIL line, skipping probe_step and rollback_step entirely — the host was left checked out at
# v(n), migrated to v(n)'s schema, silently, with no printed indication that a rollback was ever
# needed (2026-09-23 this actually happened: `drill-upgrade.sh --to v0.16.0` aborted on an S1
# out-of-band egress/DNS failure and stayed on v0.16.0 until the maintainer treated it as the real
# upgrade). fail() itself is the one choke point every step's failure already goes through, so this
# is where the loud, exact rollback recipe belongs rather than duplicating it at every call site.
# Deliberately NOT an automatic rollback: restore.sh overwrites the live database, and a failure
# here is exactly the moment an operator may want to inspect what broke before doing that again —
# printing the commands (not running them) matches what the leftover asked for.
fail() {
  printf 'FAIL %s %s\n' "$1" "$2" >&2
  if [ "$MIGRATIONS_APPLIED" -eq 1 ]; then
    printf '\n' >&2
    printf '*** HOST LEFT ON %s — migrations already applied, no automatic rollback was run ***\n' "${TO_TAG:-<target>}" >&2
    printf 'to roll back by hand, from the checkout root:\n' >&2
    printf '  sh scripts/restore.sh --db %s --target-db nexttime --i-know\n' "$DUMP_PATH" >&2
    printf '  git checkout %s\n' "${FROM_REF:-$FROM_COMMIT}" >&2
    printf '  export KERNEL_VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo dev) ($(git rev-parse --short HEAD))"\n' >&2
    printf '  docker compose --profile test build && docker compose build worker-runtime\n' >&2
    printf '  docker compose --profile test up -d\n' >&2
    printf '(restore.sh restarts kernel/agent-host/worker-supervisor/backup itself — the checkout/build/up above must land BEFORE it for that restart to come up on %s code, not %s)\n' "${FROM_REF:-$FROM_COMMIT}" "${TO_TAG:-<target>}" >&2
  fi
  exit 1
}

DRILL_LOG=$(mktemp /tmp/nt-drill-upgrade-log.XXXXXX) || {
  echo "drill-upgrade: mktemp failed" >&2
  exit 1
}
cleanup_tmp() {
  rm -f "$DRILL_LOG"
  rm -f "$DRILL_UPGRADE_SELF_COPY"
}
trap cleanup_tmp EXIT INT TERM

MIGRATIONS_APPLIED=0
FROM_COMMIT=""
FROM_TAG=""
FROM_BRANCH=""
FROM_REF=""
DUMP_PATH=""
PROBE_RESULT="not run"

T_PREFLIGHT0=0
T_DUMP0=0
T_BUILD_TO0=0
T_MIGRATE0=0
T_UP0=0
T_ACCEPT_TO0=0
T_PROBE0=0
T_ROLLBACK0=0
PHASE_PREFLIGHT=0
PHASE_DUMP=0
PHASE_BUILD_TO=0
PHASE_MIGRATE=0
PHASE_UP=0
PHASE_ACCEPT_TO=0
PHASE_PROBE=0
PHASE_ROLLBACK=0

# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------

preflight_step() {
  running=$(docker compose ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    fail "preflight-stack" "docker compose ps returned nothing — is the stack up? (docker compose up -d)"
  fi
  if ! printf '%s\n' "$running" | grep -qx "postgres"; then
    fail "preflight-stack" "postgres not running"
  fi
  if ! printf '%s\n' "$running" | grep -qx "kernel"; then
    fail "preflight-stack" "kernel not running"
  fi
  pass "preflight-stack" "running: $(printf '%s' "$running" | tr '\n' ' ')"

  dirty=$(git status --porcelain)
  if [ -n "$dirty" ]; then
    fail "preflight-git-clean" "working tree is dirty — commit or stash before running this drill (it moves HEAD with git checkout)"
  fi
  pass "preflight-git-clean" "working tree clean"

  if ! git ls-remote --tags origin "refs/tags/${TO_TAG}" 2>"$DRILL_LOG" | grep -q "refs/tags/${TO_TAG}\$"; then
    fail "preflight-to-tag" "${TO_TAG} not found on origin: $(tail -10 "$DRILL_LOG")"
  fi
  pass "preflight-to-tag" "${TO_TAG} exists on origin"

  FROM_COMMIT=$(git rev-parse HEAD)
  FROM_TAG=$(git describe --tags --exact-match HEAD 2>/dev/null)
  FROM_BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null)
  if [ -n "$FROM_BRANCH" ]; then
    FROM_REF="$FROM_BRANCH"
  else
    FROM_REF="$FROM_COMMIT"
  fi
  if [ -n "$FROM_TAG" ]; then
    pass "preflight-from-version" "currently at ${FROM_TAG} (${FROM_COMMIT}${FROM_BRANCH:+, branch $FROM_BRANCH})"
  elif [ -n "$FROM_BRANCH" ]; then
    pass "preflight-from-version" "currently on branch ${FROM_BRANCH} at ${FROM_COMMIT} (not on a tag — docs/runbooks/release.md §3's tag-pinning convention was not in use on this checkout; rollback returns to this branch at this commit)"
  else
    pass "preflight-from-version" "currently detached at ${FROM_COMMIT} (not on a tag or branch; rollback will check out this exact commit)"
  fi
}

# checkout_from_step <label>: back to where the drill started — the original branch when there
# was one (so the checkout does not end up detached), verified to still resolve to the recorded
# commit, else the recorded commit itself.
checkout_from_step() {
  label="$1"
  checkout_ref_step "$label" "$FROM_REF"
  now_at=$(git rev-parse HEAD)
  if [ "$now_at" != "$FROM_COMMIT" ]; then
    fail "checkout-$label" "$FROM_REF now resolves to $now_at, not the recorded pre-upgrade commit $FROM_COMMIT — the branch moved during the drill; check out $FROM_COMMIT by hand"
  fi
}

# Always triggers a fresh backup (this must be a *pre-upgrade* dump, not whatever the newest
# existing one happens to be) and resolves it the same way scripts/drill-restore.sh's own
# resolve_dump_step does. Never deleted — DUMP_PATH is printed in the final summary.
dump_step() {
  backup_out=$(docker compose run --rm -e BACKUP_NOW=1 backup </dev/null 2>&1)
  backup_rc=$?
  if [ "$backup_rc" -ne 0 ]; then
    fail "pre-upgrade-dump" "BACKUP_NOW=1 backup run exited $backup_rc: $(printf '%s' "$backup_out" | tail -20)"
  fi

  db_dir="${NEXTTIME_DATA}/backups/db"
  newest=""
  if [ -d "$db_dir" ]; then
    for f in "$db_dir"/nexttime-*.dump; do
      [ -e "$f" ] && newest="$f"
    done
  fi
  if [ -z "$newest" ]; then
    fail "pre-upgrade-dump" "backup run succeeded but no dump appeared under $db_dir"
  fi
  DUMP_PATH="$newest"
  pass "pre-upgrade-dump" "$DUMP_PATH (kept — this drill never deletes it)"
}

# checkout_ref_step <label> <git-ref>: git fetch --tags (only needed the first time, harmless to
# repeat) + git checkout <ref>.
checkout_ref_step() {
  label="$1"
  ref="$2"
  if ! git fetch origin --tags >"$DRILL_LOG" 2>&1; then
    fail "checkout-$label" "git fetch origin --tags failed: $(tail -20 "$DRILL_LOG")"
  fi
  if ! git checkout "$ref" >"$DRILL_LOG" 2>&1; then
    fail "checkout-$label" "git checkout $ref failed: $(tail -20 "$DRILL_LOG")"
  fi
  pass "checkout-$label" "$ref ($(git rev-parse HEAD))"
}

# layout_step <label>: idempotent host-directory-layout reconciliation for the two filesystem
# moves a checkout can straddle — models.json (S7-A, docs/runbooks/release.md §3.2: config/ ->
# its own models/ directory) and ${NEXTTIME_DATA}/llm-proxy/ (S6-B: llm-proxy's own read-write
# state dir, providers.json/keys.json). Run right after every checkout in this script (both
# directions, and around the PROBE checkout) so the on-disk layout always matches whatever code
# is currently checked out. Detected from the checked-out tree's own docker-compose.yml mount
# lines, never by parsing TO_TAG/FROM_TAG version strings.
layout_step() {
  label="$1"

  if grep -qF '${NEXTTIME_DATA:?}/models:/data/models' ./docker-compose.yml; then
    # This tree expects models.json under its own directory (S7-A layout).
    mkdir -p "${NEXTTIME_DATA}/models" || fail "layout-$label" "mkdir -p \${NEXTTIME_DATA}/models failed"
    if [ -f "${NEXTTIME_DATA}/config/models.json" ] && [ ! -e "${NEXTTIME_DATA}/models/models.json" ]; then
      mv "${NEXTTIME_DATA}/config/models.json" "${NEXTTIME_DATA}/models/models.json" || fail "layout-$label" "mv \${NEXTTIME_DATA}/config/models.json -> models/models.json failed"
    fi
    chown 10001:10001 "${NEXTTIME_DATA}/models"
    [ -f "${NEXTTIME_DATA}/models/models.json" ] && chown 10001:10001 "${NEXTTIME_DATA}/models/models.json"
    models_state="\${NEXTTIME_DATA}/models/models.json"
  else
    # This tree expects models.json under config/ (pre-S7-A layout). config/ itself is never
    # chowned (release.md §3.2 / S6-B leftover 50 第二项 — maintainer rejected changing its
    # ownership); only the file, if present, moves back.
    if [ -f "${NEXTTIME_DATA}/models/models.json" ] && [ ! -e "${NEXTTIME_DATA}/config/models.json" ]; then
      mv "${NEXTTIME_DATA}/models/models.json" "${NEXTTIME_DATA}/config/models.json" || fail "layout-$label" "mv \${NEXTTIME_DATA}/models/models.json -> config/models.json failed"
    fi
    models_state="\${NEXTTIME_DATA}/config/models.json"
  fi

  if grep -qF '${NEXTTIME_DATA:?}/llm-proxy:/data/state' ./docker-compose.yml; then
    # This tree expects llm-proxy's own read-write state dir (S6-B+). Created directly here
    # (mkdir/chmod/chown), NOT by running the checked-out tree's own
    # scripts/host-llm-proxy-init.sh — that script's v0.14.0 revision also chowned
    # ${NEXTTIME_DATA}/config (the maintainer rejected that, docs/development-tasks.md §5c "S6
    # 主机应用注意" / S7-A 决定; only v0.15.0+'s revision stopped doing it), and telling the two
    # revisions apart here would mean parsing versions, which this step deliberately avoids.
    mkdir -p "${NEXTTIME_DATA}/llm-proxy" || fail "layout-$label" "mkdir -p \${NEXTTIME_DATA}/llm-proxy failed"
    chmod 0750 "${NEXTTIME_DATA}/llm-proxy"
    chown 10001:10001 "${NEXTTIME_DATA}/llm-proxy"
    llm_proxy_state="\${NEXTTIME_DATA}/llm-proxy/ (0750, 10001:10001)"
  else
    llm_proxy_state="not needed (pre-S6-B tree)"
  fi

  pass "layout-$label" "models.json -> $models_state; llm-proxy/: $llm_proxy_state"
}

# build_step <label>: docker compose --profile test build + explicit worker-runtime build.
build_step() {
  label="$1"
  export KERNEL_VERSION="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"
  if ! docker compose --profile test build >"$DRILL_LOG" 2>&1; then
    fail "build-$label" "docker compose --profile test build failed: $(tail -30 "$DRILL_LOG")"
  fi
  if ! docker compose build worker-runtime >"$DRILL_LOG" 2>&1; then
    fail "build-$label" "docker compose build worker-runtime failed: $(tail -30 "$DRILL_LOG")"
  fi
  pass "build-$label" "images built"
}

# up_step <label>: docker compose --profile test up -d.
up_step() {
  label="$1"
  if ! docker compose --profile test up -d >"$DRILL_LOG" 2>&1; then
    fail "up-$label" "docker compose --profile test up -d failed: $(tail -30 "$DRILL_LOG")"
  fi
  pass "up-$label" "stack up"
}

# migrate_step: containerized --dry-run listing (informational) then real apply (gates).
migrate_step() {
  dry_out=$(docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js --dry-run </dev/null 2>&1)
  echo "$dry_out"
  apply_out=$(docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js </dev/null 2>&1)
  apply_rc=$?
  if [ "$apply_rc" -ne 0 ]; then
    fail "migrate" "migrate.js exited $apply_rc: $(printf '%s' "$apply_out" | tail -30)"
  fi
  pass "migrate" "applied (see --dry-run listing above for what was pending)"
  # leftover 60: from here on, a fail() anywhere (up-to, accept-*-to) prints the rollback recipe —
  # the schema is v(n)'s regardless of whether a later step also succeeds.
  MIGRATIONS_APPLIED=1
}

# accept_step <label> <script> <ok-line>: runs one accept_*.sh, requires exit 0 and the exact
# "<Sx> OK" line — same convention docs/runbooks/accept-s1.md documents for its own output.
accept_step() {
  label="$1"
  script="$2"
  ok_line="$3"
  out=$(sh "$script" </dev/null 2>&1)
  rc=$?
  printf '%s\n' "$out" | tail -10
  if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -qx "$ok_line"; then
    pass "accept-$label" "$ok_line"
    return 0
  fi
  return 1
}

accept_step_required() {
  label="$1"
  script="$2"
  ok_line="$3"
  if ! accept_step "$label" "$script" "$ok_line"; then
    fail "accept-$label" "did not print '$ok_line' — see docs/runbooks/accept-s1.md / host-accept-s2.md / host-accept-s3.md"
  fi
}

# PROBE — non-fatal by construction: never calls fail(), only records PROBE_RESULT.
probe_step() {
  checkout_from_step "probe-from"
  layout_step "probe-from"
  export KERNEL_VERSION="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"
  if ! docker compose --profile test build >"$DRILL_LOG" 2>&1; then
    echo "PROBE old-code-on-new-schema failed (build: $(tail -10 "$DRILL_LOG"))"
    PROBE_RESULT="failed (build)"
    return
  fi
  if ! docker compose build worker-runtime >"$DRILL_LOG" 2>&1; then
    echo "PROBE old-code-on-new-schema failed (worker-runtime build: $(tail -10 "$DRILL_LOG"))"
    PROBE_RESULT="failed (worker-runtime build)"
    return
  fi
  if ! docker compose --profile test up -d >"$DRILL_LOG" 2>&1; then
    echo "PROBE old-code-on-new-schema failed (up: $(tail -10 "$DRILL_LOG"))"
    PROBE_RESULT="failed (up)"
    return
  fi
  out=$(sh scripts/accept_s1.sh </dev/null 2>&1)
  rc=$?
  printf '%s\n' "$out" | tail -10
  if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -qx "S1 OK"; then
    echo "PROBE old-code-on-new-schema ok"
    PROBE_RESULT="ok"
  else
    echo "PROBE old-code-on-new-schema failed (accept_s1.sh)"
    PROBE_RESULT="failed (accept_s1.sh)"
  fi
}

# rollback proper — re-affirms v(n-1) is checked out/built/up (idempotent, correct even if
# probe_step above bailed out early), then the live restore.
rollback_step() {
  checkout_from_step "rollback-from"
  layout_step "rollback-from"
  export KERNEL_VERSION="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"
  if ! docker compose --profile test build >"$DRILL_LOG" 2>&1; then
    fail "rollback-build" "docker compose --profile test build failed: $(tail -30 "$DRILL_LOG")"
  fi
  if ! docker compose build worker-runtime >"$DRILL_LOG" 2>&1; then
    fail "rollback-build" "docker compose build worker-runtime failed: $(tail -30 "$DRILL_LOG")"
  fi
  if ! docker compose --profile test up -d >"$DRILL_LOG" 2>&1; then
    fail "rollback-up" "docker compose --profile test up -d failed: $(tail -30 "$DRILL_LOG")"
  fi
  pass "rollback-code" "v(n-1) (${FROM_COMMIT}) checked out, built, up — restoring the pre-upgrade dump now"

  restore_out=$(sh scripts/restore.sh --db "$DUMP_PATH" --target-db nexttime --i-know </dev/null 2>&1)
  restore_rc=$?
  printf '%s\n' "$restore_out" | tail -20
  if [ "$restore_rc" -ne 0 ]; then
    fail "rollback-restore" "scripts/restore.sh exited $restore_rc — see output above"
  fi
  pass "rollback-restore" "restored $DUMP_PATH over the live 'nexttime' database"
  # The host is genuinely back on v(n-1) code with the pre-upgrade dump restored now — a fail()
  # from here on (the post-rollback accept_s1 check) is a *different* problem (rollback itself
  # already succeeded; verifying it did not) and must not print "HOST LEFT ON v(n)" instructions
  # that are no longer true.
  MIGRATIONS_APPLIED=0
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

T_PREFLIGHT0=$(date +%s)
preflight_step
PHASE_PREFLIGHT=$(( $(date +%s) - T_PREFLIGHT0 ))

T_DUMP0=$(date +%s)
dump_step
PHASE_DUMP=$(( $(date +%s) - T_DUMP0 ))

checkout_ref_step "to" "$TO_TAG"
layout_step "to"

T_BUILD_TO0=$(date +%s)
build_step "to"
PHASE_BUILD_TO=$(( $(date +%s) - T_BUILD_TO0 ))

T_MIGRATE0=$(date +%s)
migrate_step
PHASE_MIGRATE=$(( $(date +%s) - T_MIGRATE0 ))

T_UP0=$(date +%s)
up_step "to"
PHASE_UP=$(( $(date +%s) - T_UP0 ))

T_ACCEPT_TO0=$(date +%s)
accept_step_required "s1-to" "scripts/accept_s1.sh" "S1 OK"
accept_step_required "s2-to" "scripts/accept_s2.sh" "S2 OK"
accept_step_required "s3-to" "scripts/accept_s3.sh" "S3 OK"
PHASE_ACCEPT_TO=$(( $(date +%s) - T_ACCEPT_TO0 ))

T_PROBE0=$(date +%s)
probe_step
PHASE_PROBE=$(( $(date +%s) - T_PROBE0 ))

T_ROLLBACK0=$(date +%s)
rollback_step
accept_step_required "s1-rollback" "scripts/accept_s1.sh" "S1 OK"
PHASE_ROLLBACK=$(( $(date +%s) - T_ROLLBACK0 ))

# --------------------------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------------------------

echo ""
echo "DRILL-UPGRADE OK"
echo "from: ${FROM_TAG:-$FROM_COMMIT} -> to: ${TO_TAG} -> rolled back to: ${FROM_TAG:-$FROM_COMMIT}${FROM_BRANCH:+ (branch $FROM_BRANCH)}"
echo "pre-upgrade dump (kept): $DUMP_PATH"
echo "reversibility probe: $PROBE_RESULT (this is the evidence for docs/runbooks/release.md's 迁移可逆性 table — see that file)"
echo ""
echo "phase timings:"
echo "  preflight:            ${PHASE_PREFLIGHT}s"
echo "  pre-upgrade dump:     ${PHASE_DUMP}s"
echo "  build v(n):           ${PHASE_BUILD_TO}s"
echo "  migrate:              ${PHASE_MIGRATE}s"
echo "  up v(n):               ${PHASE_UP}s"
echo "  accept S1/S2/S3 v(n): ${PHASE_ACCEPT_TO}s"
echo "  probe (non-fatal):    ${PHASE_PROBE}s"
echo "  rollback + accept S1: ${PHASE_ROLLBACK}s"
echo ""
echo "to re-apply this upgrade for real (not a drill), from the checkout root:"
echo "  git fetch origin --tags && git checkout ${TO_TAG}"
echo "  # if the target tag's docker-compose.yml layout differs from what this host currently has on"
echo "  # disk (models.json under config/ vs its own models/ dir, \${NEXTTIME_DATA}/llm-proxy/ state"
echo "  # dir) — see docs/runbooks/release.md §3.2 for the manual mv/mkdir/chown this drill did for you"
echo "  export KERNEL_VERSION=\"\$(git describe --tags --abbrev=0) (\$(git rev-parse --short HEAD))\""
echo "  docker compose --profile test build && docker compose build worker-runtime"
echo "  docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js"
echo "  docker compose --profile test up -d"
echo "  # then redo any version-specific manual step this release's own docs/STATUS.md 主机应用注意 calls for"
