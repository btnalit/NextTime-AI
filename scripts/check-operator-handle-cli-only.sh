#!/bin/sh
# check-operator-handle-cli-only (legacy 702): every Handle the kernel issues names what it is
# issued under — the role its scope was computed from, or the parent Handle it narrows
# (`IssuanceBasis`, packages/kernel/src/governance/capability/handles.ts) — and `issueHandle`
# re-checks that basis under governance 0043's authority locks. The one issuer with no basis is
# the operator CLI's bootstrap (`issue-service-handle`, packages/kernel/src/cli/), which acts with
# host-level trust and calls `issueOperatorHandle`. This guard keeps it there: a call anywhere
# else in the kernel (a handler, a runtime, a test) would issue a Handle whose authority nothing
# re-checks.
#
# Run directly, via `pnpm ci:guards` (root package.json), or the CI `guards` job.
set -eu

SRC="packages/kernel/src"
DEFINED_IN="$SRC/governance/capability/handles.ts"

if [ ! -f "$DEFINED_IN" ]; then
  echo "check-operator-handle-cli-only: $DEFINED_IN not found" >&2
  exit 1
fi

HITS=$(grep -rln --include='*.ts' 'issueOperatorHandle' "$SRC" | grep -v "^$SRC/cli/" | grep -vx "$DEFINED_IN" || true)

if [ -n "$HITS" ]; then
  echo "check-operator-handle-cli-only: issueOperatorHandle is the operator CLI's alone (src/cli/); issue with issueHandle and a basis instead. Found in:" >&2
  echo "$HITS" >&2
  exit 1
fi

exit 0
