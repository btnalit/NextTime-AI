#!/bin/sh
# apply-release.sh — apply one release tag on the host (S9 D2, docs/development-tasks.md §5g).
# POSIX sh, run ON THE HOST from the checkout root. Host differences come only from ./.env.
# This is the procedure every host apply since v0.20.0 has followed (it lived as an unversioned
# /tmp/nt-apply.sh until S9); docs/runbooks/release.md §3 points here.
#
# Usage:
#   sh scripts/apply-release.sh vX.Y.Z           # images built from source (scripts/build-images.sh)
#   sh scripts/apply-release.sh --pull vX.Y.Z    # published images (scripts/pull-images.sh); falls
#                                                # back to the source build if the pull or the
#                                                # signature check fails, and says so in the log
#   sh scripts/apply-release.sh --prefetch vX.Y.Z  # ahead of the maintenance window: fetch the tag,
#                                                # pull and verify its images, nothing else (below)
#
# Prefetch (legacy 137 — pulling eleven images took ~53 min on the host's egress during the
# v0.43.0 window): runs the TAG's own scripts/pull-images.sh --prefetch, which pulls and verifies
# the published images plus the third-party and fixture base images the apply needs, without
# retagging anything. The checkout, the running stack and the database are not touched, so it is
# safe any time before the window and can be re-run. The later `--pull` apply then finds every
# image present and only re-verifies it. Logs to ${NEXTTIME_DATA}/drills/prefetch-<tag>-<ts>.log;
# last line "RESULT ok" or "RESULT failed-at=<step>".
#
# Long-running (build + four acceptance suites ≈ 20–40 min). Over ssh, run it as a background job
# and follow the log; every step prints one "STEP <name> …" line, a fatal one prints "FAIL <name>"
# and exits non-zero, and the last line is "RESULT ok" or "RESULT acceptance-failures=<n>".
#
# Order and stop rules:
#   1. backup freshness (report only — checked before this run's own dump can make it look fresh)
#   2. pre-upgrade dump into ${NEXTTIME_DATA}/backups/pre-upgrade/ (never backups/db/, whose
#      retention would delete the real nightly dumps — STATUS leftover 92)        FAIL → stop
#   3. checkout the tag                                                           FAIL → stop
#      then derive the internal-plane credentials with the tag's own
#      scripts/derive-internal-tokens.sh (R-03; secrets/internal-*-to-*.token only — the
#      release's compose file mounts them, and compose refuses a missing secret file)
#                                                                                 FAIL → stop
#   4. images: pull (--pull) or build                                             FAIL → stop
#   5. migrations: dry-run listing, then the real apply (the kernel never migrates at startup)
#                                                                                 FAIL → stop
#      Steps 2–5 stopping leaves the running stack untouched by the new release. A stop in 3–5
#      also switches the checkout back to the ref it was on before step 3 (recorded as
#      "STEP checkout-from"), so the checkout keeps matching the running stack; a stop in 5 first
#      lists the migrations that did commit (each file is its own transaction) — R-71.
#   6. docker compose up -d                                                       FAIL → stop
#      (the checkout stays on $TAG here: some containers may already run the new release; decide
#      the rollback by hand — release.md §5 — the log names the previous ref)
#   7. acceptance S3 → S1 → S2 → S4 (failures are counted and reported, not fatal: the stack is
#      already on the new release; read the per-suite logs and decide whether to roll back —
#      release.md §5)
#   8. BACKUP_NOW on the new release; keep the newest 3 pre-upgrade dumps (maintainer
#      2026-10-01) — reached only after 2–6 succeeded, so a failed apply never prunes a rollback
#      point; keep this project's images of the newest 2 releases (scripts/prune-images.sh);
#      purge expired ephemeral workspaces (acceptance / probe / demo leftovers); compact
#      Observations older than 30 days (leftover 103) — only when BACKUP_NOW succeeded, since its
#      dump is the recovery point; logged, never fatal
set -u

# Step 3 checks out another tag, which can rewrite this very file while sh is still reading it.
# Run from a private copy instead (same self-copy drill-upgrade.sh does).
if [ "${APPLY_RELEASE_SELF_COPY:-}" != 1 ]; then
  self_copy=$(mktemp /tmp/apply-release.XXXXXX) || exit 1
  cp "$0" "$self_copy" || exit 1
  APPLY_RELEASE_SELF_COPY=1 exec sh "$self_copy" "$@"
fi
# Remove only the private copy — never the tracked script, even if someone exports the flag.
case "$0" in /tmp/apply-release.*) trap 'rm -f "$0"' EXIT ;; esac

pull=0
prefetch=0
case "${1:-}" in
  --pull) pull=1; shift ;;
  --prefetch) prefetch=1; shift ;;
esac
[ "$#" -eq 1 ] || { echo "usage: sh scripts/apply-release.sh [--pull | --prefetch] vX.Y.Z" >&2; exit 2; }
TAG=$1
case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "apply-release: tag must look like vX.Y.Z, got '$TAG'" >&2; exit 2 ;; esac
[ -f docker-compose.yml ] && [ -f .env ] || { echo "apply-release: run from the checkout root (docker-compose.yml / .env not found)" >&2; exit 2; }

D=$(sed -n 's/^NEXTTIME_DATA=//p' .env | tail -n 1)
[ -n "$D" ] && [ -d "$D" ] || { echo "apply-release: NEXTTIME_DATA in .env is unset or not a directory" >&2; exit 2; }
export NEXTTIME_DATA="$D"
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG_DIR=${APPLY_LOG_DIR:-$D/drills}
mkdir -p "$LOG_DIR"
if [ "$prefetch" -eq 1 ]; then LOG="$LOG_DIR/prefetch-$TAG-$TS.log"; else LOG="$LOG_DIR/apply-$TAG-$TS.log"; fi
echo "apply-release: logging to $LOG"
exec >"$LOG" 2>&1
echo "STEP start $TAG $TS pull=$pull prefetch=$prefetch"

fail() { echo "FAIL $1"; echo "RESULT failed-at=$1"; exit 1; }

# Prefetch only: the tag's own pull-images.sh, taken with `git show` like this script itself (the
# checkout stays on the running release), then stop.
if [ "$prefetch" -eq 1 ]; then
  git fetch -q origin --tags || echo "STEP fetch WARNING git fetch failed — using the tags already in this checkout"
  git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null || fail fetch
  pull_script=$(mktemp /tmp/pull-images-prefetch.XXXXXX) || fail prefetch
  git show "$TAG:scripts/pull-images.sh" >"$pull_script" 2>/dev/null && grep -q -- '--prefetch' "$pull_script" ||
    { rm -f "$pull_script"; echo "STEP prefetch $TAG's scripts/pull-images.sh has no --prefetch"; fail prefetch; }
  # Exit status from the script itself, not from a pipe into sed (same as step 4 below).
  sh "$pull_script" --prefetch "$TAG" >"$LOG_DIR/prefetch-$TAG-$TS-pull.log" 2>&1 </dev/null
  rc=$?
  sed 's/^/STEP prefetch /' "$LOG_DIR/prefetch-$TAG-$TS-pull.log"
  rm -f "$pull_script"
  [ "$rc" -eq 0 ] || fail prefetch
  echo "RESULT ok"
  exit 0
fi

# R-71: a stop between checkout and `up` puts the checkout back where it was, so the next
# `docker compose …` on this host does not run the new release's compose file against the old
# stack. The running containers were never touched; only the working tree moves back.
PREV_REF=
PREV_SHA=
restore_checkout() {
  [ -n "$PREV_SHA" ] || return 0
  if git checkout -q "$PREV_REF" 2>/dev/null; then
    echo "STEP checkout restored to $(git describe --tags --always HEAD 2>/dev/null) ($PREV_REF) — the running stack was not touched by $TAG"
  else
    echo "STEP checkout NOT restored — run: git checkout $PREV_REF   (was $PREV_SHA)"
  fi
}
fail_before_up() { restore_checkout; fail "$1"; }

# Applied migrations as module/version lines (the runner's own table; empty when unreadable).
applied_migrations() {
  docker compose exec -T postgres sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select module || chr(47) || version from schema_migrations order by 1"' \
    </dev/null 2>/dev/null | sort
}

# 1. backup freshness — report only
if [ -f scripts/check-backup-freshness.sh ]; then
  sh scripts/check-backup-freshness.sh 2>&1 | sed 's/^/STEP backup-freshness /'
fi

# 2. pre-upgrade dump — named after the version it actually captures (the checkout is still on
#    the running release here; step 3 moves it). A re-run after a failure past checkout finds the
#    checkout already on $TAG: that dump is NOT a pre-$TAG rollback point, so it is named
#    `nexttime-rerun-…` and kept out of the `nexttime-pre-*` set (and its retention), where it
#    would otherwise push the genuine pre-upgrade dump out (2026-10-02 review L9-7).
mkdir -p "$D/backups/pre-upgrade"
# D-28: the kernel bind-mounts backups/last-success (one file, read-only). Every `docker compose
# run/up` of the kernel below would make Docker create a DIRECTORY there if the file were missing,
# which would stop backup.sh from ever writing the marker again — so make sure it exists first
# (an empty marker reads as "unknown" until the next backup). Same rule as host-env-init.sh.
if [ -d "$D/backups/last-success" ]; then
  rmdir "$D/backups/last-success" 2>/dev/null && echo "STEP backup-marker removed an empty directory in place of backups/last-success"
fi
if [ ! -e "$D/backups/last-success" ]; then
  : >"$D/backups/last-success" && chmod 644 "$D/backups/last-success" &&
    echo "STEP backup-marker created an empty backups/last-success (0644)"
fi
# S10 U1: the update-feed service (uid 10002) writes into config/update-feed/. Docker creates a
# missing bind source root-owned, after which the service can never write, so the owner is set on
# every apply, not only when the directory is new: an earlier `up` that beat this step heals here.
# Same rule as host-env-init.sh.
mkdir -p "$D/config/update-feed" && chown 10002:10002 "$D/config/update-feed" &&
  chmod 755 "$D/config/update-feed" &&
  echo "STEP update-feed-dir config/update-feed is 10002:10002 0755"
# worker-supervisor (uid 10001) rewrites config/egress-sources.json in place on every spawn / stop;
# a root-owned file makes every write fail, and egress-proxy then refuses those containers'
# traffic as unknown sources. Older hosts have it root-owned (host-env-init.sh only set the owner
# from v0.43.0), so the owner is set on every apply. A missing file is created as an empty map:
# Docker would otherwise create a directory at the bind source — and one an earlier `up` already
# created is removed first (same as backups/last-success above); a non-empty one stops the apply,
# since chown on it would "succeed" while every egress registration still failed.
# Same rule as host-env-init.sh.
if [ -d "$D/config/egress-sources.json" ]; then
  rmdir "$D/config/egress-sources.json" 2>/dev/null &&
    echo "STEP egress-sources removed an empty directory in place of config/egress-sources.json" ||
    { echo "STEP egress-sources config/egress-sources.json is a non-empty directory — move it aside by hand"; fail egress-sources; }
fi
if [ ! -e "$D/config/egress-sources.json" ]; then
  echo "{}" >"$D/config/egress-sources.json"
fi
chown 10001:10001 "$D/config/egress-sources.json" && chmod 644 "$D/config/egress-sources.json" &&
  echo "STEP egress-sources config/egress-sources.json is 10001:10001 0644" ||
  echo "STEP egress-sources WARNING could not set config/egress-sources.json to 10001:10001 0644 — worker egress will be refused as unknown-source"
FROM=$(git describe --tags --always HEAD 2>/dev/null || echo unknown)
if [ "$FROM" = "$TAG" ]; then
  echo "STEP dump WARNING checkout already on $TAG (re-run) — this dump is not a pre-$TAG rollback point"
  DUMP="$D/backups/pre-upgrade/nexttime-rerun-$TAG-$TS.dump"
else
  DUMP="$D/backups/pre-upgrade/nexttime-pre-$TAG-from-$FROM-$TS.dump"
fi
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$DUMP" </dev/null || fail dump
echo "STEP dump $(stat -c %s "$DUMP") bytes $(docker compose exec -T postgres pg_restore --list <"$DUMP" | wc -l) toc"

# 3. checkout — later steps deliberately run the *new* tag's helper scripts (build-images,
#    pull-images, accept_s*): the release being applied owns its own build and acceptance
PREV_SHA=$(git rev-parse HEAD)
PREV_REF=$(git symbolic-ref -q --short HEAD || echo "$PREV_SHA")
echo "STEP checkout-from $PREV_REF ($(git describe --tags --always HEAD 2>/dev/null || echo "$PREV_SHA"))"
# A failed fetch is not fatal when the tag is already here (a prefetch fetched it): the host's
# egress drops connections, and the tag is all this step needs from GitHub.
if ! git fetch -q origin --tags; then
  git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null || fail_before_up checkout
  echo "STEP checkout WARNING git fetch failed — $TAG is already in this checkout, using it"
fi
git checkout -q "$TAG" || fail_before_up checkout
KERNEL_VERSION="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"
export KERNEL_VERSION
echo "STEP checkout $(git rev-parse --short HEAD) KV=$KERNEL_VERSION"

# 3b. internal-plane credentials (R-03) — before anything below creates a container: compose
#     refuses to start one whose declared secret file is missing (the migration's `run` included).
#     Idempotent; touches only secrets/internal-*-to-*.token, never the root or any other file.
#     A tag that predates per-service credentials has no such script and needs none.
if [ -f scripts/derive-internal-tokens.sh ]; then
  sh scripts/derive-internal-tokens.sh </dev/null || fail_before_up secrets
  echo "STEP secrets ok"
fi

# 4. images
images_from=build
if [ "$pull" -eq 1 ]; then
  # Exit status from the script itself, not from a pipe into sed (that masked a failed pull as
  # success on 2026-10-02 — no fallback build ran).
  pull_rc=1
  if [ -f scripts/pull-images.sh ]; then
    sh scripts/pull-images.sh "$TAG" >"$LOG_DIR/apply-$TAG-$TS-pull.log" 2>&1
    pull_rc=$?
    sed 's/^/STEP pull /' "$LOG_DIR/apply-$TAG-$TS-pull.log"
  fi
  if [ "$pull_rc" -eq 0 ]; then
    images_from=pull
  else
    echo "STEP pull failed (rc=$pull_rc) — falling back to the source build"
  fi
fi
if [ "$images_from" = build ]; then
  sh scripts/build-images.sh || fail_before_up build
fi
echo "STEP images from=$images_from kernel=$(docker image inspect nexttime-ai-kernel --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^KERNEL_VERSION=//p')"
echo "STEP runtime-image $(docker image inspect nexttime-ai-worker-runtime --format '{{.Id}} pi={{index .Config.Labels "ai.nexttime.pi-version"}} ext={{index .Config.Labels "ai.nexttime.platform-extension-version"}} from={{index .Config.Labels "ai.nexttime.built-from"}}')"
echo "STEP runtime-pi $(docker run --rm --entrypoint pi nexttime-ai-worker-runtime --version 2>&1 | tail -n 1)"

# 5. migrations
echo "STEP migrate-dry-run"
docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js --dry-run </dev/null
migs_before="$LOG_DIR/apply-$TAG-$TS-migrations-before.txt"
applied_migrations >"$migs_before"
if ! docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js </dev/null; then
  # Each migration file is one transaction: everything listed here is committed, the failing file
  # is not. The pre-upgrade dump from step 2 is the rollback point for these rows (release.md §5 /
  # §6); the previous release keeps running on them only where §6 says the migration is reversible.
  applied_migrations | comm -13 "$migs_before" - | sed 's/^/STEP migrate committed /'
  echo "STEP migrate rollback point: $DUMP"
  fail_before_up migrate
fi
echo "STEP migrate ok"

# 6. up
if [ "$images_from" = pull ]; then
  docker compose up -d --no-build </dev/null || fail up
else
  docker compose up -d </dev/null || fail up
fi
sleep 30
echo "STEP up"
docker compose ps --format '{{.Service}} {{.Status}}'

# 7. acceptance — the S2 fixtures build FROM docker/dockerfile:1.7; pre-pull it with retries unless
#    it is already here (a prefetch, an earlier apply)
docker image inspect docker/dockerfile:1.7 >/dev/null 2>&1 ||
  for i in 1 2 3; do docker pull -q docker/dockerfile:1.7 >/dev/null 2>&1 && break; sleep 10; done
failures=0
for s in 3 1 2 4; do
  [ -f "scripts/accept_s$s.sh" ] || { echo "STEP S$s skipped (not in this tag)"; continue; }
  slog="$LOG_DIR/apply-$TAG-$TS-s$s.log"
  sh "scripts/accept_s$s.sh" >"$slog" 2>&1 </dev/null
  rc=$?
  nfail=$(grep -c '^FAIL' "$slog")
  echo "STEP S$s exit=$rc pass=$(grep -c '^PASS' "$slog") fail=$nfail log=$slog"
  grep -E '^FAIL|^S4 (gate|NOTE|OK|FAIL)' "$slog" | sort -u | head -n 8
  if [ "$rc" -ne 0 ] || [ "$nfail" -gt 0 ]; then failures=$((failures + 1)); fi
done
docker compose --profile test stop fake-llm >/dev/null 2>&1

# 8. backup on the new release, pre-upgrade retention, expired workspaces, observation compaction
docker compose run --rm -e BACKUP_NOW=1 backup </dev/null >/dev/null 2>&1
backup_rc=$?
echo "STEP backup-now exit=$backup_rc last=$(sed -n 's/^db_dump=//p' "$D/backups/last-success" 2>/dev/null)"
ls -t "$D/backups/pre-upgrade"/nexttime-pre-*.dump 2>/dev/null | tail -n +4 | xargs -r rm -f --
ls -t "$D/backups/pre-upgrade"/nexttime-rerun-*.dump 2>/dev/null | tail -n +2 | xargs -r rm -f --
echo "STEP pre-upgrade-retention kept $(ls "$D/backups/pre-upgrade"/nexttime-pre-*.dump 2>/dev/null | wc -l)"
# Image retention: this project's images of the newest two releases, anything a container uses and
# the runtime-image rollback target stay; older release tags go (scripts/prune-images.sh).
if [ -f scripts/prune-images.sh ]; then
  sh scripts/prune-images.sh --keep 2 --yes </dev/null 2>&1 | grep -E '^prune-images:|could not' | sed 's/^/STEP images-retention /'
fi
if [ -f scripts/delete-workspaces-matching.sh ]; then
  sh scripts/delete-workspaces-matching.sh --expired --yes </dev/null 2>&1 | tail -n 3 | sed 's/^/STEP expired-workspaces /'
fi
# Observation retention (STATUS leftover 103): delete redundant ingest Observations older than 30
# days — never one a Fact references, a Source's newest, the last of its (activity, source) pair,
# or one carrying a payload (packages/kernel/src/application/platform/compact-observations.ts).
# Only on top of the BACKUP_NOW above: that dump is the recovery point. After the expired-workspace
# purge, so it does not compact rows about to be purged. Failures are logged, never fatal.
if [ -f packages/kernel/src/cli/compact-observations.ts ]; then
  if [ "$backup_rc" -ne 0 ]; then
    echo "STEP observations-compaction skipped — backup-now failed (exit=$backup_rc), no fresh recovery point"
  else
    clog="$LOG_DIR/apply-$TAG-$TS-compaction.log"
    docker compose run --rm --no-deps -T kernel node dist/cli/compact-observations.js --yes >"$clog" 2>&1 </dev/null
    echo "STEP observations-compaction exit=$? $(tail -n 1 "$clog") log=$clog"
  fi
fi

echo "STEP done"
if [ "$failures" -eq 0 ]; then echo "RESULT ok"; else echo "RESULT acceptance-failures=$failures"; fi
