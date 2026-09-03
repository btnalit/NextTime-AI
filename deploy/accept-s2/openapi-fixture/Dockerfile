# syntax=docker/dockerfile:1.7
#
# accept-s2 openapi-fixture: deterministic test "system" for scripts/accept_s2.sh (S2.12, test
# fixture only — never part of a production deploy). Same minimal-image convention as
# deploy/fake-llm/Dockerfile: plain dependency-free ESM, no build step.
#
# Build context is the repo root: docker build -f deploy/accept-s2/openapi-fixture/Dockerfile .

FROM node:24-bookworm-slim
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY deploy/accept-s2/openapi-fixture/server.mjs ./server.mjs
COPY deploy/accept-s2/openapi-fixture/openapi.json ./openapi.json

USER nexttime
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
