#!/bin/sh
# host-checkout.sh — clone or update the NextTime-AI checkout on a target host. POSIX sh.
#
# Usage (local):
#   CODE_DIR=/path/to/checkout sh scripts/host-checkout.sh
#
# Usage (remote, piped over SSH — do not put git commands directly in the ssh command string;
# pipe this script's contents to a remote shell instead):
#   ssh <TARGET_HOST> 'CODE_DIR=/path/to/checkout sh -s' < scripts/host-checkout.sh
#
# Env:
#   CODE_DIR  (required) — checkout directory on the target host.
#   REPO_URL  (optional) — default https://github.com/btnalit/NextTime-AI.git
#   BRANCH    (optional) — default main
#
# Behavior: if $CODE_DIR/.git exists, fetch origin and hard-reset the working tree to
# origin/$BRANCH (discarding any local changes/commits in that checkout — this directory is
# meant to be a deployment checkout, not a place for local edits). Otherwise, clone $REPO_URL
# into $CODE_DIR at $BRANCH. Prints the resulting commit. No other side effects (does not touch
# $NEXTTIME_DATA, does not write .env, does not run docker).

set -eu

if [ -z "${CODE_DIR:-}" ]; then
	echo "host-checkout: CODE_DIR is not set; refusing to run" >&2
	exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/btnalit/NextTime-AI.git}"
BRANCH="${BRANCH:-main}"

echo "host-checkout: CODE_DIR=$CODE_DIR"
echo "host-checkout: REPO_URL=$REPO_URL"
echo "host-checkout: BRANCH=$BRANCH"

if [ -d "$CODE_DIR/.git" ]; then
	echo "host-checkout: existing checkout found, fetching + resetting to origin/$BRANCH"
	git -C "$CODE_DIR" fetch origin "$BRANCH"
	# lane-7 P3 fix: `checkout -B` refuses (fails the whole script, set -e) on a dirty working
	# tree whenever the switch would overwrite a locally-modified tracked file — this checkout
	# is meant to be a reproducible deployment target, never blocked by an operator's stray edit
	# (this file's own header comment already promises "hard-reset ... discarding any local
	# changes/commits"). `symbolic-ref` (never fails on a dirty tree — it only rewrites which
	# branch HEAD points at, without touching the index/working tree; works even if
	# refs/heads/$BRANCH doesn't exist locally yet) + `reset --hard` (the actual, guaranteed
	# "make the working tree exactly match this commit, discarding anything else" primitive —
	# unlike `checkout -f`, it also reverts a locally-modified file back to a tree it was already
	# unchanged between, not just files that differ from the old commit) together give the
	# hard-reset semantics the header comment already documents, for real.
	git -C "$CODE_DIR" symbolic-ref HEAD "refs/heads/$BRANCH"
	git -C "$CODE_DIR" reset --hard "origin/$BRANCH"
else
	echo "host-checkout: no existing checkout, cloning"
	git clone --branch "$BRANCH" "$REPO_URL" "$CODE_DIR"
fi

commit=$(git -C "$CODE_DIR" rev-parse HEAD)
echo "host-checkout: done"
echo "host-checkout: commit=$commit"
