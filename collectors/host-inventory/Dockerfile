# syntax=docker/dockerfile:1.7
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

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/collector-host-inventory... build
RUN corepack pnpm --filter @nexttime/collector-host-inventory deploy --prod --legacy /out/collector-host-inventory

FROM node:24-bookworm-slim AS runtime
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
