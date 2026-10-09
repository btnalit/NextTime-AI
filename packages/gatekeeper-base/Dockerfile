# syntax=ghcr.io/btnalit/nexttime-mirror-dockerfile@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Multi-stage build for @nexttime/gatekeeper-base (design doc §5.1.4, §7.5, §10.1, §10.2).
# This package is a library first — S2.5's `gatekeepers/docker` and `gatekeepers/ragflow` (and any
# future接入包) build their own image FROM this stage or a similar one, adding their own manifest
# file and env. This Dockerfile exists so the base package itself can be built and smoke-tested
# standalone (`main()` — env-driven single-transport bootstrap, see src/index.ts).
#
# NOTE (S2.4): image build is unverified on this machine — Docker is not installed here. It must
# be built and smoke-tested on the target host before use.
#
# Build context is the repo root: docker build -f packages/gatekeeper-base/Dockerfile .

# node:24-bookworm-slim by digest, from its GHCR copy (deploy/image-mirrors.json)
FROM ghcr.io/btnalit/nexttime-mirror-node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
RUN corepack enable
WORKDIR /workspace

# Dependency layer keyed only on the workspace manifests + lockfile, not the full source tree
# (STATUS leftover 93; full rationale in docs/runbooks/release.md §3.4). Every workspace
# package.json is copied — `pnpm install` always resolves the whole workspace graph (workspace:*
# cross-refs), regardless of which package this Dockerfile later --filters — so a source-only
# change anywhere else in the repo still hits this layer's cache. `pnpm fetch` reads only
# pnpm-lock.yaml (package manifests are ignored); the cache mount persists the downloaded store
# across separate builds/releases, so even a lockfile change reuses whatever it doesn't need to
# re-fetch. network-concurrency=4 (pnpm default 16): this host's outbound goes through an upstream
# gateway that cuts concurrent downloads (UND_ERR_SOCKET) — fewer simultaneous connections trades
# fetch speed for not tripping it.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/agent-host/package.json packages/agent-host/package.json
COPY packages/egress-proxy/package.json packages/egress-proxy/package.json
COPY packages/gatekeeper-base/package.json packages/gatekeeper-base/package.json
COPY packages/kernel/package.json packages/kernel/package.json
COPY packages/llm-proxy/package.json packages/llm-proxy/package.json
COPY packages/platform-extension/package.json packages/platform-extension/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/worker-supervisor/package.json packages/worker-supervisor/package.json
COPY gatekeepers/docker/package.json gatekeepers/docker/package.json
COPY gatekeepers/ragflow/package.json gatekeepers/ragflow/package.json
COPY collectors/host-inventory/package.json collectors/host-inventory/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    corepack pnpm fetch --frozen-lockfile --network-concurrency=4 --store-dir=/pnpm/store

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    corepack pnpm install --offline --frozen-lockfile --store-dir=/pnpm/store
RUN corepack pnpm --filter @nexttime/gatekeeper-base... build
RUN corepack pnpm --filter @nexttime/gatekeeper-base deploy --prod --legacy /out/gatekeeper-base

# node:24-bookworm-slim by digest, from its GHCR copy (deploy/image-mirrors.json)
FROM ghcr.io/btnalit/nexttime-mirror-node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
# The ssh transport shells out to the system `ssh` client (src/kinds/ssh.ts) — installed here so a
# gate built directly from this base image (rather than a system-specific image with its own
# apt-get layer) can still use it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY --from=build --chown=nexttime:nexttime /out/gatekeeper-base .

# GATE_DATA_DIR (idempotency store, ConnectedAccount store) — mount a persistent volume here in
# any concrete gate's own compose service definition (S2.5).
RUN mkdir -p /data/gate && chown nexttime:nexttime /data/gate
ENV GATE_DATA_DIR=/data/gate

USER nexttime
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
