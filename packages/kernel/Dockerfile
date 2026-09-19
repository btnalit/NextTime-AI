# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @nexttime/kernel (design doc §7.1, §10.1, §10.2).
#
# Build context is the repo root: docker build -f packages/kernel/Dockerfile .
#
# KERNEL_VERSION (docs/console-completion-plan.md §5.8 "版本号", B1): the version string the
# platform overview shows (`application/gateway/platform-handlers.ts` reads `process.env.
# KERNEL_VERSION`) is baked into the image at build time as a build arg → ENV, never hand-
# maintained in the host's `.env` (that is exactly how the overview drifted to "0.10.0" while the
# host ran v0.13.2). docker-compose.yml passes `${KERNEL_VERSION:-dev}` from the *build* shell's
# environment; `.git/` is excluded from the build context (.dockerignore), so the Dockerfile cannot
# derive it from `git describe` itself — docs/runbooks/release.md §3 has the one-line export to
# run before `docker compose build`. Unset → "dev", which is what a local/CI build should show.

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
# Declared in this (runtime) stage, not at the top of the file: an ARG only lives in the stage
# that declares it, and placing it after every COPY keeps a version bump from invalidating any
# cached layer above — only this metadata-only ENV layer changes between two builds of the same
# tree. See the header comment for where the value comes from.
ARG KERNEL_VERSION=dev
ENV KERNEL_VERSION=${KERNEL_VERSION}
EXPOSE 8080
CMD ["node", "dist/index.js"]
