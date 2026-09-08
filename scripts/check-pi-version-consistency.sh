#!/bin/sh
# check-pi-version-consistency: root `pi.version` is the single source of truth for the pinned pi
# version (docs/runbooks/pi-upgrade.md "升级契约"). deploy/worker-runtime/Dockerfile reads it
# directly (COPY + cat), so there is nothing to check there beyond "the file parses". pnpm/npm
# need a literal version string in packages/platform-extension/package.json's own
# `dependencies["@earendil-works/pi-coding-agent"]` and `devDependencies["@earendil-works/pi-ai"]`
# — no syntax exists for a package.json field to read its version from another file — so those
# two pins are physically separate copies of the same string, kept honest by this guard rather
# than by construction. A hit here means an upgrade PR bumped pi.version without also bumping
# both package.json pins (or vice versa) — see docs/runbooks/pi-upgrade.md for the full procedure.
#
# Run directly, via `pnpm ci:guards` (root package.json), `make ci`, or the CI `guards` job
# (.github/workflows/ci.yml).
set -eu

VERSION=$(tr -d '[:space:]' <pi.version)

if [ -z "$VERSION" ]; then
  echo "check-pi-version-consistency: pi.version is empty" >&2
  exit 1
fi

fail=0

EXT_PKG=packages/platform-extension/package.json

# Plain grep/sed, not `node -e` + require: the CI `guards` job (.github/workflows/ci.yml) never
# installs Node.js/pnpm (that only happens in the separate `quality`/`test` jobs) — this guard
# must not add a new toolchain dependency to it. package.json's own JSON is simple/flat enough
# for this here (one occurrence of each key, single-line "key": "value" formatting).
AGENT_DEP=$(grep -m1 '"@earendil-works/pi-coding-agent"' "$EXT_PKG" | sed -E 's/.*"@earendil-works\/pi-coding-agent" *: *"([^"]*)".*/\1/')
if [ "$AGENT_DEP" != "$VERSION" ]; then
  echo "check-pi-version-consistency: $EXT_PKG dependencies['@earendil-works/pi-coding-agent']=$AGENT_DEP does not match pi.version=$VERSION" >&2
  fail=1
fi

AI_DEP=$(grep -m1 '"@earendil-works/pi-ai"' "$EXT_PKG" | sed -E 's/.*"@earendil-works\/pi-ai" *: *"([^"]*)".*/\1/')
if [ "$AI_DEP" != "$VERSION" ]; then
  echo "check-pi-version-consistency: $EXT_PKG devDependencies['@earendil-works/pi-ai']=$AI_DEP does not match pi.version=$VERSION" >&2
  fail=1
fi

if ! grep -q 'COPY pi.version /tmp/pi.version' deploy/worker-runtime/Dockerfile; then
  echo "check-pi-version-consistency: deploy/worker-runtime/Dockerfile no longer reads pi.version (see docs/runbooks/pi-upgrade.md)" >&2
  fail=1
fi

exit $fail
