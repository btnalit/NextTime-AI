# syntax=ghcr.io/btnalit/nexttime-mirror-dockerfile@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# accept-s2 mcp fixture: deterministic test MCP server for scripts/accept_s2.sh (S3.12, test
# fixture only — never part of a production deploy). Same minimal-image convention as
# deploy/accept-s2/openapi-fixture/Dockerfile: plain dependency-free ESM, no build step.
#
# Build context is the repo root: docker build -f deploy/accept-s2/mcp/Dockerfile .

# node:24-bookworm-slim by digest, from its GHCR copy (deploy/image-mirrors.json)
FROM ghcr.io/btnalit/nexttime-mirror-node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
COPY deploy/accept-s2/mcp/server.mjs ./server.mjs

USER nexttime
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
