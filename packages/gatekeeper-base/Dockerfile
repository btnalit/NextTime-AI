# syntax=docker/dockerfile:1.7
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

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/gatekeeper-base... build
RUN corepack pnpm --filter @nexttime/gatekeeper-base deploy --prod --legacy /out/gatekeeper-base

FROM node:24-bookworm-slim AS runtime
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
