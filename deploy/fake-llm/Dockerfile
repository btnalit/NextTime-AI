# syntax=docker/dockerfile:1.7
#
# fake-llm: deterministic OpenAI-compatible upstream test double for llm-proxy (design doc S1.10;
# docs/development-tasks.md S1.5, second half, deliverable 4). No build step — server.mjs is
# plain, dependency-free ESM JavaScript (see its own doc comment for why not TypeScript+build);
# this Dockerfile only needs the base image and a non-root user, matching every other
# @nexttime/* image's convention.
#
# Build context is the repo root: docker build -f deploy/fake-llm/Dockerfile .

FROM node:24-bookworm-slim
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY deploy/fake-llm/server.mjs ./server.mjs

USER nexttime
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
