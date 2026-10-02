#!/bin/sh
# pull-images.sh — install one release's published platform images instead of building them
# (S9 D1, docs/development-tasks.md §5g). POSIX sh, run ON THE HOST from the checkout root, with
# the checkout already on the same tag (docker compose reads ./docker-compose.yml and ./.env).
#
# Usage:
#   sh scripts/pull-images.sh vX.Y.Z                 # every published platform image
#   sh scripts/pull-images.sh vX.Y.Z kernel caddy    # just the named service(s)
#   sh scripts/pull-images.sh --no-verify vX.Y.Z     # skip signature verification (say why in
#                                                    # the host record — never the default)
#
# What it does, in three passes so a failure never leaves the host half-retagged:
#   1. pull   <registry>/nexttime-ai-<service>:<tag> for each service;
#   2. verify each pulled digest's cosign keyless signature: issuer = GitHub Actions OIDC,
#      identity = this repository's .github/workflows/publish-images.yml on refs/heads/main
#      (a signature from a workflow run on any other branch is rejected). cosign runs as a
#      digest-pinned container — nothing is installed on the host;
#   3. retag each image to the local name docker compose already uses for that service
#      (`docker compose config --images <service>` — e.g. nexttime-ai-kernel, nexttime-ai-caddy,
#      nexttime-ai-worker-runtime), plus nexttime-ai-worker-runtime:pi-<version> like
#      scripts/build-images.sh. Nothing downstream changes: worker-supervisor's image allowlist,
#      the activeRuntimeImage platform setting and the console's "pi 运行时" card all keep reading
#      the same local names and labels.
# Then start with `docker compose up -d --no-build`. scripts/build-images.sh stays the
# source-build fallback.
#
# Registry: NEXTTIME_IMAGE_REGISTRY (e.g. ghcr.io/<owner>) if set, else derived from the checkout's
# GitHub origin remote. Pulling private packages needs a prior `docker login ghcr.io` with a
# read:packages token; public packages need nothing. Acceptance fixtures (accept-s2-*, fake-llm)
# are not published and keep building on the host.
set -eu

COSIGN_IMAGE=${COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8}
ALL_SERVICES="kernel agent-host worker-supervisor llm-proxy egress-proxy caddy worker-runtime gatekeeper-docker gatekeeper-ragflow gate-host collector-host-inventory"

die() { echo "pull-images: $*" >&2; exit 1; }

verify=1
if [ "${1:-}" = "--no-verify" ]; then verify=0; shift; fi
[ "$#" -ge 1 ] || die "usage: sh scripts/pull-images.sh [--no-verify] vX.Y.Z [service...]"
TAG=$1; shift
case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "tag must look like vX.Y.Z, got '$TAG'" ;; esac
[ -f pi.version ] && [ -f docker-compose.yml ] || die "run from the checkout root (pi.version / docker-compose.yml not found)"

SERVICES=${*:-$ALL_SERVICES}
for s in $SERVICES; do
  case " $ALL_SERVICES " in *" $s "*) ;; *) die "'$s' is not a published service (published: $ALL_SERVICES)" ;; esac
done

# owner/repo from the origin remote: https://github.com/<owner>/<repo>(.git) or git@github.com:<owner>/<repo>(.git)
origin=$(git config --get remote.origin.url 2>/dev/null || true)
slug=$(printf '%s\n' "$origin" | sed -n 's#^.*github\.com[:/]\([^/]*/[^/]*\)$#\1#p' | sed 's#\.git$##')
if [ -n "${NEXTTIME_IMAGE_REGISTRY:-}" ]; then
  REGISTRY=$NEXTTIME_IMAGE_REGISTRY
else
  [ -n "$slug" ] || die "cannot derive the registry from origin '$origin'; set NEXTTIME_IMAGE_REGISTRY=ghcr.io/<owner>"
  REGISTRY="ghcr.io/$(printf '%s' "${slug%%/*}" | tr '[:upper:]' '[:lower:]')"
fi
if [ "$verify" -eq 1 ]; then
  [ -n "$slug" ] || die "cannot derive owner/repo from origin '$origin' for the signature identity; use --no-verify only with a recorded reason"
  IDENTITY="^https://github\.com/${slug}/\.github/workflows/publish-images\.yml@refs/heads/main\$"
fi

case "$SERVICES" in
  *caddy*)
    if grep -q '^EXPLORER_BUILD=1' .env 2>/dev/null; then
      echo "pull-images: warning: .env sets EXPLORER_BUILD=1 but the published caddy image has no Explorer bundle — rebuild it with: sh scripts/build-images.sh caddy" >&2
    fi
    ;;
esac

PI_VERSION=$(tr -d '[:space:]' <pi.version)

# The local name compose uses for a service's image. `config --images <service>` also prints the
# images of that service's depends_on chain, in no stable order (kernel → postgres's pgvector
# image too), so keep only the one compose-built name ending in -<service> — explicit `image:`
# names (nexttime-ai-caddy, nexttime-ai-worker-runtime) follow the same pattern — and require
# exactly one.
local_name_of() {
  names=$(docker compose --profile build-only config --images "$1" | grep -E "^[a-z0-9][a-z0-9_.-]*-${1}\$" || true)
  [ "$(printf '%s\n' "$names" | grep -c .)" -eq 1 ] || die "cannot resolve one local image name for '$1' (got: $(printf '%s' "$names" | tr '\n' ' '))"
  printf '%s\n' "$names"
}

# 0. resolve every local name before touching the network
for s in $SERVICES; do
  local_name_of "$s" >/dev/null
done

echo "pull-images: ${TAG} from ${REGISTRY} (verify=${verify}) — ${SERVICES}"

# 1. pull
for s in $SERVICES; do
  ref="${REGISTRY}/nexttime-ai-${s}:${TAG}"
  docker pull -q "$ref" >/dev/null || die "pull failed: $ref"
done

# 2. verify (by digest) and sanity-check the runtime image's pi label against this checkout
for s in $SERVICES; do
  ref="${REGISTRY}/nexttime-ai-${s}:${TAG}"
  digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" | sed -n "s#^${REGISTRY}/nexttime-ai-${s}@##p" | head -n 1)
  [ -n "$digest" ] || die "no repo digest for $ref"
  if [ "$verify" -eq 1 ]; then
    set -- --rm
    if [ -f "${DOCKER_CONFIG:-$HOME/.docker}/config.json" ]; then
      set -- "$@" -v "${DOCKER_CONFIG:-$HOME/.docker}/config.json:/docker-config/config.json:ro" -e DOCKER_CONFIG=/docker-config
    fi
    docker run "$@" "$COSIGN_IMAGE" verify \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      --certificate-identity-regexp "$IDENTITY" \
      "${REGISTRY}/nexttime-ai-${s}@${digest}" >/dev/null 2>&1 \
      || die "signature verification failed: ${REGISTRY}/nexttime-ai-${s}@${digest}"
  fi
  if [ "$s" = "worker-runtime" ]; then
    label=$(docker image inspect --format '{{index .Config.Labels "ai.nexttime.pi-version"}}' "$ref")
    [ "$label" = "$PI_VERSION" ] || die "worker-runtime pi label '$label' != checkout pi.version '$PI_VERSION' — is the checkout on ${TAG}?"
  fi
  echo "pull-images: ${s} ${digest} verified=${verify}"
done

# 3. retag to the names docker compose already uses
for s in $SERVICES; do
  ref="${REGISTRY}/nexttime-ai-${s}:${TAG}"
  local_name=$(local_name_of "$s")
  docker tag "$ref" "$local_name"
  echo "pull-images: ${s} -> ${local_name}"
  if [ "$s" = "worker-runtime" ]; then
    docker tag "$ref" "nexttime-ai-worker-runtime:pi-${PI_VERSION}"
    echo "pull-images: tagged nexttime-ai-worker-runtime:pi-${PI_VERSION}"
  fi
done
echo "pull-images: done — start with: docker compose up -d --no-build"
