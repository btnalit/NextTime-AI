# syntax=docker/dockerfile:1.7
#
# caddy image with the web SPA baked in (design doc §7.6, §10.2; E8 + S1.8).
#
# The static roots are build artifacts, not host state, so they ship inside the image instead of
# being bind-mounted from the checkout: no Node toolchain on the host, no root-owned dist/ in the
# working tree, and `docker compose build caddy && docker compose up -d caddy` is the whole
# deploy step for a web change. The Caddyfile stays a bind mount (docker-compose.yml) so a
# routing change never needs an image rebuild.
#
# /srv/explorer (S3.5, docs/development-tasks.md §S3.5; W4 closeout, explorer/README.md): the
# `explorer-src` stage below (picked by the `EXPLORER_BUILD` arg — see its own comment) supplies
# whichever of the two candidates it resolves to. Default (`EXPLORER_BUILD=0`, unset): the
# committed placeholder page under deploy/caddy/explorer-placeholder/ ("explorer bundle not
# built") — this is the CI/default path, matching explorer/README.md's own "CI does not build
# this" invariant (no network access assumed, no multi-minute npm install on every unrelated
# build), and also still works unchanged for a host operator who instead ran `sh
# explorer/build.sh` directly on the host (that script replaces the placeholder directory's own
# contents in place — this Dockerfile's COPY of it is unaffected either way). `EXPLORER_BUILD=1`:
# the real bundle, built from source *inside this image* by the `explorer-build` stage below —
# the host-with-Docker-only path (no node/npm/git needed on the host itself); see
# docs/runbooks/host-explorer.md for the full walkthrough.
#
# Build context is the repo root: docker build -f deploy/caddy/Dockerfile .

# EXPLORER_BUILD (default 0) and SEMANTICA_REF (default v0.6.7, matching explorer/build.sh's own
# default — see that script's own comment on why this specific tag may need adjusting) are global
# args: usable directly in every `FROM` below without redeclaration, redeclared with `ARG` inside
# any stage that needs the value in a `RUN`/`ENV`/`COPY` instruction (BuildKit's own two-scope
# rule for build args).
ARG EXPLORER_BUILD=0
ARG SEMANTICA_REF=v0.6.7

FROM node:24-bookworm-slim AS web-build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/web... build

# ---- Explorer bundle build ----
#
# BuildKit only executes the stages actually reachable from the final target's own dependency DAG
# ("Explorer bundle selection" below) — when EXPLORER_BUILD=0 (the default), nothing downstream
# ever references this stage, so its `RUN` (the clone + npm install + vite build) never runs at
# all: no network access, no minutes-long build, on the default/CI path. It only actually runs
# when EXPLORER_BUILD=1 selects `explorer-src-1` (this stage's own alias) below.
#
# Reuses explorer/build.sh verbatim (COPYed in below, then executed) rather than re-implementing
# its clone/tsc/vite steps here, so the Dockerfile path and the host-direct path
# (docs/runbooks/host-explorer.md's own "run `sh explorer/build.sh` directly" alternative) can
# never drift apart. `git`/`ca-certificates` are the only extra packages `node:24-bookworm-slim`
# needs beyond its bundled node/npm (build.sh's own "Requires: node + npm ... git only when
# SEMANTICA_SRC is unset" — this stage always clones, never sets SEMANTICA_SRC).
FROM node:24-bookworm-slim AS explorer-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY explorer/build.sh explorer/build.sh
ARG SEMANTICA_REF
ENV SEMANTICA_REF=${SEMANTICA_REF}
# Absolute, outside /workspace — build.sh replaces this directory's own contents in place; the
# rest of /workspace (just build.sh itself here) is irrelevant to the output.
ENV EXPLORER_OUT_DIR=/out
RUN sh explorer/build.sh

# ---- Explorer bundle selection ----
# The standard BuildKit "conditional COPY --from" idiom: two same-shaped candidate stages (each
# exposing its bundle at /out), then a final stage whose own `FROM` interpolates the `EXPLORER_
# BUILD` arg to pick one of them by name. Stage 0 is a bare COPY of the committed placeholder onto
# an empty `scratch` base (no node/git pulled in for the default path); stage 1 is just an alias
# onto `explorer-build` above (whose own RUN already produced /out) — see that stage's own comment
# for why only the *selected* one of these two ever actually builds.
FROM scratch AS explorer-src-0
COPY deploy/caddy/explorer-placeholder /out

FROM explorer-build AS explorer-src-1

FROM explorer-src-${EXPLORER_BUILD} AS explorer-src

FROM caddy:2.10
COPY --from=web-build /workspace/packages/web/dist /srv/web
COPY --from=explorer-src /out /srv/explorer
