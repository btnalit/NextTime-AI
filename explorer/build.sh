#!/bin/sh
# explorer/build.sh — builds the reference Knowledge Explorer's static bundle for this platform's
# own Explorer mount (docs/development-tasks.md §S3.5; design doc §9.5/§7.6). Runs ON THE HOST
# (or as a Docker build stage — see deploy/caddy/Dockerfile's "explorer" stage), not in CI: CI
# never has network access to an upstream project it does not own, and the explorer bundle is a
# build artifact, not source this repo vendors (see this directory's own README.md for the "why
# not vendor it" reasoning). The Explorer's own front-end source is NOT copied into this repo —
# this script only ever reads it from a temporary clone or a caller-supplied local checkout.
#
# Two source modes:
#   SEMANTICA_SRC=<path>   use an existing local checkout's own explorer/ subdirectory (no clone,
#                           no network) — the fastest loop for iterating against a local checkout
#                           of the reference project, and the only mode this script's own author
#                           actually exercised end-to-end (see README.md's "verified" note).
#   (unset)                clone SEMANTICA_REPO at ref SEMANTICA_REF into a throwaway temp dir.
#
# Output: EXPLORER_OUT_DIR (default deploy/caddy/explorer-placeholder — the same directory
# deploy/caddy/Dockerfile already COPYs into /srv/explorer) is emptied and replaced with the
# built static bundle. That directory stays committed to the repo with a placeholder index.html
# ("explorer bundle not built yet") so `docker build` always finds *something* there whether or
# not this script has ever been run — see deploy/caddy/Dockerfile's own comment.
#
# Usage:
#   sh explorer/build.sh
#   SEMANTICA_SRC=/path/to/semantica-checkout sh explorer/build.sh
#   SEMANTICA_REF=v0.6.7 sh explorer/build.sh
#   EXPLORER_OUT_DIR=/tmp/explorer-dist sh explorer/build.sh   # build without touching the repo
#
# Requires: node + npm (the reference project's explorer/ is a Vite + React + TypeScript SPA,
# node >=20 — its own package.json/engines); git only when SEMANTICA_SRC is unset.
#
# Windows note: run this under WSL or inside the Docker build stage, not native Git-Bash/MSYS —
# MSYS's automatic POSIX-path-to-Windows-path conversion mangles the `--base=/explorer/` and
# `--outDir` flags passed to vite below (a Git-Bash-only artifact, irrelevant to the Linux
# container this normally runs in).
set -eu

SEMANTICA_REPO="${SEMANTICA_REPO:-https://github.com/semantica-agi/semantica.git}"
# Best-known tag for the checkout this task was built against (pyproject.toml's own `version =
# "0.6.7"`) — override if the upstream project's actual tag naming differs, or set SEMANTICA_SRC
# instead to skip the guess entirely.
SEMANTICA_REF="${SEMANTICA_REF:-v0.6.7}"

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
EXPLORER_OUT_DIR="${EXPLORER_OUT_DIR:-$REPO_ROOT/deploy/caddy/explorer-placeholder}"
# `vite build --base` must be an absolute path starting and ending with "/" — this is also the
# exact prefix deploy/caddy/Caddyfile's `handle_path /explorer/*` strips before serving from
# EXPLORER_OUT_DIR, so the two must never drift apart independently.
EXPLORER_BASE_PATH="${EXPLORER_BASE_PATH:-/explorer/}"

log() {
  printf '[explorer/build.sh] %s\n' "$1" >&2
}

# Every temp dir this script creates (the clone, if any, plus the vite build's own output dir) —
# removed on exit regardless of success/failure/interruption. Appended to, never reassigned, so
# one trap covers everything created below it.
CLEANUP_DIRS=""
cleanup() {
  for d in $CLEANUP_DIRS; do
    [ -d "$d" ] && rm -rf "$d"
  done
}
trap cleanup EXIT INT TERM

if [ -n "${SEMANTICA_SRC:-}" ]; then
  if [ ! -d "$SEMANTICA_SRC/explorer" ]; then
    log "SEMANTICA_SRC=$SEMANTICA_SRC has no explorer/ subdirectory — not a reference-project checkout"
    exit 1
  fi
  SRC="$SEMANTICA_SRC"
  log "using local checkout: $SRC"
else
  CLONE_DIR="$(mktemp -d)"
  CLEANUP_DIRS="$CLEANUP_DIRS $CLONE_DIR"
  log "cloning $SEMANTICA_REPO @ $SEMANTICA_REF into $CLONE_DIR"
  git clone --depth 1 --branch "$SEMANTICA_REF" "$SEMANTICA_REPO" "$CLONE_DIR"
  SRC="$CLONE_DIR"
fi

if [ ! -f "$SRC/explorer/package.json" ]; then
  log "no explorer/package.json under $SRC — cannot build"
  exit 1
fi

BUILD_TMP="$(mktemp -d)"
CLEANUP_DIRS="$CLEANUP_DIRS $BUILD_TMP"

log "installing dependencies (explorer/)"
(
  cd "$SRC/explorer"
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi

  log "type-checking (tsc -b)"
  npx tsc -b

  log "building static bundle (vite build --base=$EXPLORER_BASE_PATH)"
  npx vite build --base="$EXPLORER_BASE_PATH" --outDir "$BUILD_TMP" --emptyOutDir
)

if [ ! -f "$BUILD_TMP/index.html" ]; then
  log "build completed but $BUILD_TMP/index.html is missing — treating as a failed build"
  exit 1
fi

log "replacing $EXPLORER_OUT_DIR with the built bundle"
rm -rf "$EXPLORER_OUT_DIR"
mkdir -p "$EXPLORER_OUT_DIR"
cp -R "$BUILD_TMP/." "$EXPLORER_OUT_DIR/"

log "done — $EXPLORER_OUT_DIR now holds the built Explorer bundle"
log "next: docker compose build caddy && docker compose up -d caddy (see docs/runbooks/host-explorer.md)"
