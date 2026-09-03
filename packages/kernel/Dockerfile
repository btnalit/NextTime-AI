# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @nexttime/kernel (design doc §7.1, §10.1, §10.2).
# NOTE (R1): image build is unverified on this machine — Docker is not installed here. It must
# be built and smoke-tested on the target host before E3 sign-off.
#
# Build context is the repo root: docker build -f packages/kernel/Dockerfile .

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/kernel... build
RUN corepack pnpm --filter @nexttime/kernel deploy --prod --legacy /out/kernel

FROM node:24-bookworm-slim AS runtime
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY --from=build --chown=nexttime:nexttime /out/kernel .
# S2.6: repo-root ontology/ (platform-meta.yaml, entry-agent.yaml, ops-runner.yaml — design doc
# §7.10 "内容以两种包交付...ontology/<domain>/") is *not* part of the @nexttime/kernel package
# itself (`pnpm deploy` above only carries that package's own files), so it needs its own COPY
# here. ONTOLOGY_DIR tells `substrate/ontology/loader.ts`'s `resolveOntologyDir` exactly where to
# find it — see that file's own doc comment for why its relative-path fallback (correct in local
# dev) cannot resolve inside this flattened image.
COPY --from=build --chown=nexttime:nexttime /workspace/ontology ./ontology

USER nexttime
ENV NODE_ENV=production
ENV ONTOLOGY_DIR=/app/ontology
EXPOSE 8080
CMD ["node", "dist/index.js"]
