# syntax=ghcr.io/btnalit/nexttime-mirror-dockerfile@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
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
RUN corepack pnpm --filter @nexttime/kernel... build
RUN corepack pnpm --filter @nexttime/kernel deploy --prod --legacy /out/kernel

# node:24-bookworm-slim by digest, from its GHCR copy (deploy/image-mirrors.json)
FROM ghcr.io/btnalit/nexttime-mirror-node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
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
# The pi version this release expects (the same repo-root file deploy/worker-runtime/Dockerfile
# installs pi from) — the console's "pi 运行时" card compares it with the active runtime image's
# own ai.nexttime.pi-version label (application/platform/runtime.ts `pi_drift`).
COPY --from=build --chown=nexttime:nexttime /workspace/pi.version ./pi.version

USER nexttime
ENV NODE_ENV=production
ENV ONTOLOGY_DIR=/app/ontology
ENV PI_VERSION_FILE=/app/pi.version
# Declared in this (runtime) stage, not at the top of the file: an ARG only lives in the stage
# that declares it, and placing it after every COPY keeps a version bump from invalidating any
# cached layer above — only this metadata-only ENV layer changes between two builds of the same
# tree. See the header comment for where the value comes from.
ARG KERNEL_VERSION=dev
ENV KERNEL_VERSION=${KERNEL_VERSION}
EXPOSE 8080
CMD ["node", "dist/index.js"]
