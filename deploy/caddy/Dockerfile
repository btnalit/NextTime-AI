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
# /srv/explorer (S3.5, docs/development-tasks.md §S3.5; explorer/README.md): COPYs whatever
# deploy/caddy/explorer-placeholder/ currently holds — the committed placeholder page ("explorer
# bundle not built") by default, or a real built Explorer bundle after a host operator has run
# `sh explorer/build.sh` (which replaces that directory's own contents in place; this COPY line
# itself never changes either way — see explorer/build.sh's own doc comment). CI never runs
# explorer/build.sh (it would need network access to a project this repo does not own), so this
# COPY must always succeed against whatever is already committed — that is exactly why the
# placeholder ships checked in rather than the directory being empty.
#
# Build context is the repo root: docker build -f deploy/caddy/Dockerfile .

FROM node:24-bookworm-slim AS web-build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/web... build

FROM caddy:2.10
COPY --from=web-build /workspace/packages/web/dist /srv/web
COPY deploy/caddy/explorer-placeholder /srv/explorer
