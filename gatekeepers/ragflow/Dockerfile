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

COPY . .
RUN corepack pnpm install --frozen-lockfile
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
