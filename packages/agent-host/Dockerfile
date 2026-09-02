# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @nexttime/agent-host (design doc §7.2, §10.1, §10.2).
# NOTE (R1): image build is unverified on this machine — Docker is not installed here. It must
# be built and smoke-tested on the target host before E3 sign-off.
#
# Build context is the repo root: docker build -f packages/agent-host/Dockerfile .

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/agent-host... build
RUN corepack pnpm --filter @nexttime/agent-host deploy --prod --legacy /out/agent-host

FROM node:24-bookworm-slim AS runtime
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY --from=build --chown=nexttime:nexttime /out/agent-host .

USER nexttime
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
