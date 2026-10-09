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
#   sh scripts/pull-images.sh --prefetch vX.Y.Z      # ahead of the maintenance window: pull and
#                                                    # verify only (see "Prefetch" below)
#
# What it does, in three passes so a failure never leaves the host half-retagged:
#   1. pull   <registry>/nexttime-ai-<service>:<tag> for each service;
#   2. verify each pulled digest's cosign keyless signature, every part matched exactly (R-33):
#      issuer = GitHub Actions OIDC; identity = this repository's
#      .github/workflows/publish-images.yml on refs/heads/main; and the run that signed was this
#      repository's, on refs/heads/main — so neither a run of that workflow on another branch nor
#      a workflow elsewhere (another branch, another repository) calling it as a reusable
#      workflow passes. cosign runs as a digest-pinned container — nothing is installed on the
#      host;
#   3. retag each image to the local name docker compose already uses for that service
#      (`docker compose config --images <service>` — e.g. nexttime-ai-kernel, nexttime-ai-caddy,
#      nexttime-ai-worker-runtime), plus nexttime-ai-worker-runtime:pi-<version> like
#      scripts/build-images.sh. Nothing downstream changes: worker-supervisor's image allowlist,
#      the activeRuntimeImage platform setting and the console's "pi 运行时" card all keep reading
#      the same local names and labels.
# Then start with `docker compose up -d --no-build`. scripts/build-images.sh stays the
# source-build fallback.
#
# Already present (legacy 137): an image whose <registry>/nexttime-ai-<service>:<tag> is on the
# host with a repo digest — a --prefetch, or an earlier attempt — is not pulled again; it is still
# verified by digest like a fresh pull. Every image, pulled or present, must also carry
# publish-images.yml's org.opencontainers.image.revision label equal to the tag's own commit, so
# an image of another release under that tag name never passes. A pull or a verification that
# fails is retried twice (the host's egress drops connections) before the script gives up.
#
# Prefetch (--prefetch): the bulk transfer, taken out of the maintenance window. Pass 1 and 2 only
# — no retag, so the running stack, its compose names and the checkout are untouched — plus the
# digest-pinned third-party images the tag's docker-compose.yml names and the BuildKit frontend the
# acceptance fixtures build with, so `up` and the fixture builds find them on the host too. It runs
# with the checkout still on the RUNNING release: the tag must be fetched (`git fetch origin
# --tags`), and its pi.version and docker-compose.yml are read with `git show`. apply-release.sh
# --prefetch is the entry (docs/runbooks/release.md §3); the later apply's own pull then finds
# every image present and only re-verifies.
#
# Registry: NEXTTIME_IMAGE_REGISTRY (e.g. ghcr.io/<owner>) if set, else derived from the checkout's
# GitHub origin remote. Pulling private packages needs a prior `docker login ghcr.io` with a
# read:packages token; public packages need nothing. The bare acceptance fixtures (accept-s2-sshd /
# -openapi / -mcp, fake-llm) are not published and build on the host from base images alone; the
# two accept-s2 gates run this release's gate-host image (scripts/accept_s2.sh preflight).
set -eu

COSIGN_IMAGE=${COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8}
ALL_SERVICES="kernel agent-host worker-supervisor llm-proxy egress-proxy caddy worker-runtime gatekeeper-docker gatekeeper-ragflow gate-host collector-host-inventory"

die() { echo "pull-images: $*" >&2; exit 1; }

verify=1
prefetch=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-verify) verify=0 ;;
    --prefetch) prefetch=1 ;;
    *) break ;;
  esac
  shift
done
[ "$#" -ge 1 ] || die "usage: sh scripts/pull-images.sh [--no-verify] [--prefetch] vX.Y.Z [service...]"
TAG=$1; shift
case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "tag must look like vX.Y.Z, got '$TAG'" ;; esac
[ -f pi.version ] && [ -f docker-compose.yml ] || die "run from the checkout root (pi.version / docker-compose.yml not found)"
# The commit every image's revision label must name. Read from the tag itself, not HEAD: a
# prefetch runs with the checkout still on the running release.
TAG_REV=$(git rev-parse -q --verify "refs/tags/${TAG}^{commit}" 2>/dev/null) ||
  die "tag ${TAG} is not in this checkout — git fetch origin --tags first"

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
  IDENTITY="https://github.com/${slug}/.github/workflows/publish-images.yml@refs/heads/main"
fi

case "$SERVICES" in
  *caddy*)
    if grep -q '^EXPLORER_BUILD=1' .env 2>/dev/null; then
      echo "pull-images: warning: .env sets EXPLORER_BUILD=1 but the published caddy image has no Explorer bundle — rebuild it with: sh scripts/build-images.sh caddy" >&2
    fi
    ;;
esac

# A full run sits on the tag (step 3 retags into this checkout's compose names); a prefetch reads
# the tag's own files.
if [ "$prefetch" -eq 1 ]; then
  PI_VERSION=$(git show "${TAG}:pi.version" | tr -d '[:space:]')
else
  PI_VERSION=$(tr -d '[:space:]' <pi.version)
fi

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

# One cosign verification of an image@digest; extra `docker run` options (a mounted docker config)
# follow the reference. The certificate identity is the reusable workflow that signed
# (publish-images.yml@refs/heads/main); the workflow repository / ref extensions belong to the run
# that called it — release-please on main, or a dispatch from main.
cosign_verify() {
  image_ref=$1
  shift
  docker run --rm "$@" "$COSIGN_IMAGE" verify \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    --certificate-identity "$IDENTITY" \
    --certificate-github-workflow-repository "$slug" \
    --certificate-github-workflow-ref refs/heads/main \
    "$image_ref"
}

# retry <cmd...>: up to three attempts, 15 s then 30 s apart — the host's egress drops connections.
retry() {
  attempt=1
  while :; do
    "$@" && return 0
    [ "$attempt" -ge 3 ] && return 1
    echo "pull-images: attempt ${attempt} failed, retrying: $*" >&2
    sleep $((attempt * 15))
    attempt=$((attempt + 1))
  done
}

# The repo digest of a local <registry>/nexttime-ai-<service> image, empty when it has none.
repo_digest_of() {
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null |
    sed -n "s#^${REGISTRY}/nexttime-ai-${2}@##p" | head -n 1
}

# 0. resolve every local name before touching the network (a prefetch does not retag)
if [ "$prefetch" -eq 0 ]; then
  for s in $SERVICES; do
    local_name_of "$s" >/dev/null
  done
fi

echo "pull-images: ${TAG} ($(printf '%s' "$TAG_REV" | cut -c1-12)) from ${REGISTRY} (verify=${verify} prefetch=${prefetch}) — ${SERVICES}"

# 1. pull — unless already on the host with a repo digest (prefetched, or an earlier attempt)
for s in $SERVICES; do
  ref="${REGISTRY}/nexttime-ai-${s}:${TAG}"
  if [ -n "$(repo_digest_of "$ref" "$s")" ]; then
    echo "pull-images: ${s} present, not pulled again"
    continue
  fi
  retry docker pull -q "$ref" >/dev/null || die "pull failed: $ref"
done

# One verification of an image@digest, anonymous first: the published packages are public. Only if
# that fails and the host has a docker config (private packages, `docker login ghcr.io`) retry with
# it mounted — as uid 0, because the cosign image runs as a non-root user that cannot read root's
# 0600 config.json (2026-10-02 host: "loading config file: permission denied" failed every
# verification). The last attempt's output is left in $VERIFY_OUT.
verify_digest() {
  cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  VERIFY_OUT=$(cosign_verify "$1" 2>&1) && return 0
  [ -f "$cfg" ] || return 1
  VERIFY_OUT=$(cosign_verify "$1" --user 0:0 -v "$cfg:/docker-config/config.json:ro" -e DOCKER_CONFIG=/docker-config 2>&1)
}

# 2. verify (by digest); check each image was built from the tag's own commit, and the runtime
#    image's pi label against the tag's pi.version
for s in $SERVICES; do
  ref="${REGISTRY}/nexttime-ai-${s}:${TAG}"
  digest=$(repo_digest_of "$ref" "$s")
  [ -n "$digest" ] || die "no repo digest for $ref"
  if [ "$verify" -eq 1 ]; then
    retry verify_digest "${REGISTRY}/nexttime-ai-${s}@${digest}" ||
      die "signature verification failed: ${REGISTRY}/nexttime-ai-${s}@${digest}: $(printf '%s\n' "$VERIFY_OUT" | tail -n 2 | tr '\n' ' ')"
  fi
  rev=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")
  [ "$rev" = "$TAG_REV" ] || die "${ref} revision label '${rev}' != ${TAG}'s commit ${TAG_REV}"
  if [ "$s" = "worker-runtime" ]; then
    label=$(docker image inspect --format '{{index .Config.Labels "ai.nexttime.pi-version"}}' "$ref")
    [ "$label" = "$PI_VERSION" ] || die "worker-runtime pi label '$label' != ${TAG}'s pi.version '$PI_VERSION'"
  fi
  echo "pull-images: ${s} ${digest} verified=${verify}"
done

# Prefetch stops here, after the other images later steps need, each pulled only when missing:
# the digest-pinned third-party images of the tag's compose file (`up` would pull a missing one),
# the BuildKit frontend and base images of the acceptance fixtures, which are built on the host
# (apply-release.sh step 7; a missing base image is all their builds would fetch — an existing one
# is never refreshed, which would void the fixtures' cached package layers).
if [ "$prefetch" -eq 1 ]; then
  fixture_bases=$(git ls-tree -r --name-only "$TAG" deploy/accept-s2 deploy/fake-llm | grep '/Dockerfile$' |
    while read -r f; do git show "${TAG}:${f}" | sed -n 's/^FROM[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p'; done | sort -u)
  for ref in $(git show "${TAG}:docker-compose.yml" |
    sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]#]*@sha256:[0-9a-f]*\).*/\1/p' | sort -u) docker/dockerfile:1.7 $fixture_bases; do
    if docker image inspect "$ref" >/dev/null 2>&1; then
      echo "pull-images: ${ref} present"
    elif retry docker pull -q "$ref" >/dev/null; then
      echo "pull-images: ${ref} pulled"
    else
      missing="${missing:-} $ref"
    fi
  done
  # Every one is tried before giving up, so a re-run (idempotent: present images are skipped)
  # has only the failures left to fetch.
  [ -z "${missing:-}" ] || die "prefetch incomplete — the platform images are verified, but these failed to pull (re-run to retry):${missing}"
  echo "pull-images: prefetch done — ${TAG} is on the host and verified; apply it with apply-release.sh --pull ${TAG}"
  exit 0
fi

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
