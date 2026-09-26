#!/bin/sh
# build-images.sh — build this release's images with real version labels. POSIX sh, run ON THE
# HOST from the checkout root (docker compose reads ./docker-compose.yml and ./.env from cwd).
#
# Usage:
#   sh scripts/build-images.sh                  # every default service + worker-runtime
#   sh scripts/build-images.sh worker-runtime   # just the named service(s)
#
# Why a script instead of a bare `docker compose build` (2026-09-26):
#   - `worker-runtime` sits behind `profiles: ["build-only"]`, so a bare `docker compose build`
#     never rebuilds it — the image every entry agent and Worker runs (pi + platform-extension)
#     silently stays on whatever an older build left behind. This script always builds it.
#   - its `ai.nexttime.*` labels (PI_VERSION / PLATFORM_EXTENSION_VERSION / BUILT_FROM) and the
#     kernel's KERNEL_VERSION are build args that default to "dev"; the console's "pi 运行时" card
#     can only tell which pi the fleet runs when they are real. They are derived here from the
#     checkout itself: `pi.version`, packages/platform-extension/package.json, `git`.
#   - the freshly built runtime image is also tagged `nexttime-ai-worker-runtime:pi-<version>`, so
#     the previous pi build stays addressable for a manual rollback (docs/runbooks/pi-upgrade.md §7).
#
# Builds run one service at a time (COMPOSE_PARALLEL_LIMIT=1): parallel builds on a host whose
# outbound traffic goes through an upstream gateway have had npm downloads cut mid-install.
set -eu

[ -f pi.version ] && [ -f docker-compose.yml ] || {
  echo "build-images: run from the checkout root (pi.version / docker-compose.yml not found)" >&2
  exit 1
}

PI_VERSION=$(tr -d '[:space:]' <pi.version)
PLATFORM_EXTENSION_VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' \
  packages/platform-extension/package.json | head -n 1)
BUILT_FROM=$(git rev-parse --short HEAD 2>/dev/null || echo dev)
if [ -z "${KERNEL_VERSION:-}" ]; then
  KERNEL_VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo dev) (${BUILT_FROM})"
fi
export PI_VERSION PLATFORM_EXTENSION_VERSION BUILT_FROM KERNEL_VERSION
echo "build-images: pi ${PI_VERSION}, platform-extension ${PLATFORM_EXTENSION_VERSION:-?}, commit ${BUILT_FROM}, kernel ${KERNEL_VERSION}"

build_runtime=0
if [ "$#" -eq 0 ]; then
  COMPOSE_PARALLEL_LIMIT=1 docker compose build
  COMPOSE_PARALLEL_LIMIT=1 docker compose --profile build-only build worker-runtime
  build_runtime=1
else
  COMPOSE_PARALLEL_LIMIT=1 docker compose --profile build-only build "$@"
  for service in "$@"; do
    [ "$service" = "worker-runtime" ] && build_runtime=1
  done
fi

if [ "$build_runtime" -eq 1 ]; then
  docker tag nexttime-ai-worker-runtime "nexttime-ai-worker-runtime:pi-${PI_VERSION}"
  echo "build-images: tagged nexttime-ai-worker-runtime:pi-${PI_VERSION}"
fi
