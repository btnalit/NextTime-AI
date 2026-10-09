# syntax=ghcr.io/btnalit/nexttime-mirror-dockerfile@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Multi-stage build for collectors/host-inventory (design doc §7.8, §10.1, §10.2; docs/
# development-tasks.md S3.3). Talks to the Docker Engine API via dockerode — no docker CLI binary
# is installed in this image (matches the "no docker CLI" rule every other Docker-facing service in
# this repo already follows — gatekeepers/docker's own Dockerfile has the same note). `systemctl`/
# `git` ARE installed (both are read-only, structural-facts-only call sites here — see systemd.ts's
# and repository.ts's own module doc comments; neither is ever used to mutate anything).
#
# NOTE: image build is unverified on this machine — Docker is not installed here. It must be built
# and smoke-tested on the target host (docs/runbooks/host-collector.md) before use.
#
# Build context is the repo root: docker build -f collectors/host-inventory/Dockerfile .

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
RUN corepack pnpm --filter @nexttime/collector-host-inventory... build
RUN corepack pnpm --filter @nexttime/collector-host-inventory deploy --prod --legacy /out/collector-host-inventory

# node:24-bookworm-slim by digest, from its GHCR copy (deploy/image-mirrors.json)
FROM ghcr.io/btnalit/nexttime-mirror-node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
# systemd (for systemctl) and git — both read-only data sources this collector shells out to
# (systemd.ts / repository.ts). No docker CLI, matching this file's own module doc comment above.
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd git \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY --from=build --chown=nexttime:nexttime /out/collector-host-inventory .

# Local state (register_source idempotency cache — run.ts's own doc comment) and the optional
# repository-paths mount both live under here; docker-compose.yml mounts a persistent volume at
# this path (${NEXTTIME_DATA}/collectors/host-inventory).
RUN mkdir -p /data/state && chown nexttime:nexttime /data/state

USER nexttime
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/index.js"]
