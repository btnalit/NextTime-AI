# syntax=docker/dockerfile:1.7
#
# Multi-stage build for gatekeepers/docker (design doc §7.5, §7.10, §10.1, §10.2;
# docs/development-tasks.md S2.5) — the preset cli-kind Gatekeeper for the host's own Docker
# Engine. Talks to the Docker Engine API via dockerode (see README.md) — no docker CLI binary is
# installed in this image, matching the task brief's "no docker CLI in the image". As of
# fix/gate-docker-socket-proxy this container reaches the Engine API over DOCKER_HOST (docker-
# compose.yml: docker-socket-proxy-gate on the dockerapi-gate network), not a bind-mounted
# /var/run/docker.sock — see README.md.
#
# NOTE: image build is unverified on this machine — Docker is not installed here. It must be
# built and smoke-tested on the target host (docs/runbooks/host-gatekeepers.md) before use.
#
# Build context is the repo root: docker build -f gatekeepers/docker/Dockerfile .

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/gatekeeper-docker... build
RUN corepack pnpm --filter @nexttime/gatekeeper-docker deploy --prod --legacy /out/gatekeeper-docker

FROM node:24-bookworm-slim AS runtime
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY --from=build --chown=nexttime:nexttime /out/gatekeeper-docker .

# GATE_DATA_DIR: idempotency store only (this gate uses no ConnectedAccount store — no per-user
# credentials, see README.md "Credentials"). docker-compose.yml mounts a persistent volume here
# (${NEXTTIME_DATA}/gatekeepers/docker).
RUN mkdir -p /data/gate && chown nexttime:nexttime /data/gate
ENV GATE_DATA_DIR=/data/gate
ENV GATE_PORT=8083

# Runs as non-root (uid 10001). fix/gate-docker-socket-proxy: no longer needs the host's docker
# group gid / `group_add` — this container never touches /var/run/docker.sock's file permissions
# at all, only docker-socket-proxy-gate's own network-reachable HTTP listener (DOCKER_HOST).
USER nexttime
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
