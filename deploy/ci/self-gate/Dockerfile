# syntax=ghcr.io/btnalit/nexttime-mirror-dockerfile@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# deploy/ci/self-gate: the CI stack's self-connected gate (legacy 671; server.mjs's header). Test
# fixture only — built by deploy/ci/docker-compose.ci.yml, never part of a real deployment. Same
# minimal-image convention as deploy/accept-s2/mcp/Dockerfile: plain dependency-free ESM.
#
# Build context is the repo root: docker build -f deploy/ci/self-gate/Dockerfile .

# node:24-bookworm-slim by digest, from its GHCR copy (deploy/image-mirrors.json)
FROM ghcr.io/btnalit/nexttime-mirror-node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY deploy/ci/self-gate/server.mjs ./server.mjs

USER nexttime
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
