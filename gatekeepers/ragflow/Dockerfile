# syntax=docker/dockerfile:1.7
#
# Multi-stage build for gatekeepers/ragflow (design doc §7.5, §7.10, §10.1, §10.2;
# docs/development-tasks.md S2.5) — the preset http-kind Gatekeeper for a RAGFlow deployment's
# REST API. See README.md for the manifest, credential env var names, and known limitations.
#
# NOTE: image build is unverified on this machine — Docker is not installed here. It must be
# built and smoke-tested on the target host (docs/runbooks/host-gatekeepers.md) before use.
#
# Build context is the repo root: docker build -f gatekeepers/ragflow/Dockerfile .

FROM node:24-bookworm-slim AS build
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
RUN corepack pnpm --filter @nexttime/gatekeeper-ragflow... build
RUN corepack pnpm --filter @nexttime/gatekeeper-ragflow deploy --prod --legacy /out/gatekeeper-ragflow

FROM node:24-bookworm-slim AS runtime
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY --from=build --chown=nexttime:nexttime /out/gatekeeper-ragflow .

# GATE_DATA_DIR: idempotency store only (this gate uses SharedEnvCredentialResolver, not a
# ConnectedAccount store — see README.md "Credentials"). docker-compose.yml mounts a persistent
# volume here (${NEXTTIME_DATA}/gatekeepers/ragflow).
RUN mkdir -p /data/gate && chown nexttime:nexttime /data/gate
ENV GATE_DATA_DIR=/data/gate
ENV GATE_PORT=8083

USER nexttime
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
