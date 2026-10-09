#!/bin/sh
# Docs-only change detector for CI (ci.yml / e2e.yml `changes` job). Writes `code=true|false` to
# $GITHUB_OUTPUT: false only when every changed path is documentation: under docs/ (except
# docs/contracts/, which `pnpm contract:check` and the prompt-contract guard read), a top-level
# *.md, any README.md, or .github/*.md. Any other .md (a prompt or template under packages/,
# ontology/, ...) counts as code, so it never skips the tests that may load it. No build, test or
# e2e step reads the documentation paths above (checked 2026-10-09).
#
# Fails open: any event other than pull_request / push to main, a missing base commit, a failed
# compare API call, an empty list or a list at the compare API's 300-file cap all mean code=true,
# so a broken detector runs the jobs instead of skipping them. Callers also run their jobs when
# this job itself fails (`if: !cancelled() && needs.changes.outputs.code != 'false'`): a skipped
# job counts as passed for a required check, so skipping must only ever follow a definite "false".
#
# Env: EVENT_NAME, BASE_SHA / HEAD_SHA (pull_request), BEFORE_SHA / AFTER_SHA (push),
# GITHUB_REPOSITORY, GH_TOKEN. Renames count both their old and new path.
set -u

out=${GITHUB_OUTPUT:-/dev/stdout}
emit() {
  echo "code=$1" >>"$out"
  echo "code=$1 ($2)"
  exit 0
}

case "${EVENT_NAME:-}" in
  pull_request) base=${BASE_SHA:-} head=${HEAD_SHA:-} ;;
  push) base=${BEFORE_SHA:-} head=${AFTER_SHA:-} ;;
  *) emit true "event '${EVENT_NAME:-}' always runs" ;;
esac
case "$base" in
  '' | *[!0]*) ;;
  *) base='' ;;
esac
[ -n "$base" ] && [ -n "$head" ] || emit true "no base/head commit"

files=$(gh api "repos/$GITHUB_REPOSITORY/compare/$base...$head" \
  --jq '.files[] | .filename, (.previous_filename // empty)') || emit true "compare API failed"
n=$(printf '%s\n' "$files" | grep -c .)
[ "$n" -gt 0 ] || emit true "no changed files listed"
[ "$n" -lt 300 ] || emit true "$n paths, at the compare API's file cap"

code=$(printf '%s\n' "$files" | grep . | awk '!((/^docs\// && !/^docs\/contracts\//) || /^[^\/]+\.md$/ || /(^|\/)README\.md$/ || /^\.github\/[^\/]+\.md$/)')
if [ -n "$code" ]; then
  emit true "non-docs paths changed, first: $(printf '%s\n' "$code" | head -n 1)"
fi
emit false "all $n paths are documentation"
