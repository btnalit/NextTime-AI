# syntax=docker/dockerfile:1.7
#
# Agent runtime image (design doc §7.2, §7.3, §10.1; docs/development-tasks.md S1.5): the SAME
# image runs both the per-user resident entry container (NEXTTIME_MODE=entry, spawned by
# @nexttime/worker-supervisor's resident mode, this half) and, later, one-shot Worker containers
# (NEXTTIME_MODE=worker, S2.8/S2.9) — design doc §7.3 "入口与 Worker 同一镜像".
#
# NOTE: image build is unverified on this machine (no Docker on Windows dev host, per this
# task's dispatch) — built and smoke-tested on the target host; see
# docs/private/host-s1-5a-*.md and the PR body "主机验收结果".
#
# Verified against the pi 0.84.4 reference checkout (D:\NextTime AI\pi-0.84.4 — read-only
# reference project, never copied into this repo):
#   - packages/coding-agent/docs/containerization.md "Plain Docker" recipe is the base for the
#     runtime stage below: `node:24-bookworm-slim`, apt `bash ca-certificates git ripgrep`,
#     `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. This Dockerfile adds
#     curl/python3/python3-pip/python3-venv/build-essential on top, per this task's own toolchain
#     list — pi's own install needs none of them (no native compilation: its one optional native
#     dep, @mariozechner/clipboard, ships prebuilt platform binaries); they exist for the agent's
#     own bash/python tool use inside the container.
#   - packages/coding-agent/package.json `engines.node: ">=22.19.0"` — node:24 satisfies it.
#   - packages/coding-agent/src/cli/args.ts: `--mode rpc`, `--session-dir <dir>`,
#     `--system-prompt <text-or-path>`, `--extension`/`-e <path>` (repeatable) are the real CLI
#     flags. There is NO `--system-prompt-file` flag.
#   - packages/coding-agent/src/core/resource-loader.ts `resolvePromptInput`: `--system-prompt`'s
#     value is read as a *file's contents* when `existsSync(value)` is true, otherwise used as
#     literal text — so `--system-prompt /workspace/.nexttime/system-prompt.md` (entrypoint.sh)
#     does exactly what a `--system-prompt-file` flag would, without one existing.
#   - packages/coding-agent/src/config.ts: the installed package's `piConfig.name` is unset, so
#     `APP_NAME` defaults to `"pi"` and `ENV_AGENT_DIR` = `PI_CODING_AGENT_DIR`. `getAgentDir()`
#     honors that env var, and `getModelsPath()` = `<agentDir>/models.json` — so bind-mounting
#     `models.json` at `${PI_CODING_AGENT_DIR}/models.json` (worker-supervisor's spawn spec) is
#     exactly the path pi itself reads.
#   - packages/coding-agent/src/core/extensions/loader.ts: `-e <path>` loads via jiti, which
#     alias-resolves `@earendil-works/pi-*`/`typebox`/etc. imports against pi's OWN install (the
#     `npm install -g` below), never the extension's own `node_modules` — so
#     @nexttime/platform-extension's own `@earendil-works/pi-coding-agent` dependency (needed for
#     its TS types) is redundant at runtime but harmless. `@nexttime/shared` is NOT one of pi's
#     bundled/aliased modules, so it DOES need to resolve from the extension's own
#     `node_modules`, which `pnpm deploy --prod` (build stage) provides.
#   - packages/coding-agent/src/core/tools/index.ts: built-in tools are bash/edit/find/grep/ls/
#     powershell/read/write. entrypoint.sh passes none of `--tools`/`--no-tools`/
#     `--no-builtin-tools`/`--exclude-tools`, so all of them (minus powershell, irrelevant here)
#     stay enabled by pi's own default — "内置工具全开" (design doc §7.2/§7.3/§11).
#
# Build context is the repo root: `docker compose build worker-runtime` (docker-compose.yml
# `worker-runtime` service, profile `build-only` — it exists only to produce the
# `nexttime-ai-worker-runtime` image @nexttime/worker-supervisor references by name; that
# service is never itself `up`).

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace

COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @nexttime/platform-extension... build
RUN corepack pnpm --filter @nexttime/platform-extension deploy --prod --legacy /out/platform-extension

FROM node:24-bookworm-slim AS runtime

# Toolchain the entry/Worker agent's own bash/python tool use needs (docs/development-tasks.md
# S1.5 task brief) — not a pi runtime requirement (see header). One apt layer, cleaned after.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 python3-pip python3-venv build-essential ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Pinned exact version (docs/development-tasks.md §0.3 "pi 锁 @earendil-works/pi-coding-
# agent@0.84.4"). --ignore-scripts matches pi's own containerization.md recipe (header above).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4

# Same non-root uid:gid every other @nexttime/* image uses (kernel/agent-host/worker-supervisor/
# llm-proxy/egress-proxy Dockerfiles; scripts/host-env-init.sh CONTAINER_UID/CONTAINER_GID) —
# design doc §7.3/§11 "非 root". --home-dir /workspace: at runtime /workspace is always the
# per-user bind mount (worker-supervisor spawn spec), not image content, so HOME just needs to
# name that mount point, not pre-exist with real content.
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /workspace --shell /usr/sbin/nologin nexttime \
 && mkdir -p /workspace && chown nexttime:nexttime /workspace

COPY --from=build --chown=nexttime:nexttime /out/platform-extension /opt/nexttime/platform-extension
COPY --chmod=755 deploy/worker-runtime/entrypoint.sh /opt/nexttime/entrypoint.sh

# pip installs as the non-root user under the read-only root filesystem (design doc §7.3 "只读根
# 文件系统只写工作目录与 /tmp"): PYTHONUSERBASE under /workspace, which is always writable (the
# per-user bind mount) — never the default `~/.local` resolution some pip versions derive
# differently across HOME-handling edge cases. PATH picks up console-script entry points pip
# --user installs there.
ENV PIP_USER=1
ENV PYTHONUSERBASE=/workspace/.local
ENV PATH=/workspace/.local/bin:$PATH

WORKDIR /workspace
USER nexttime
ENV NODE_ENV=production
ENV HOME=/workspace
# pi 0.84.4 checks for a newer release at startup (dist/utils/version-check.js →
# https://pi.dev/api/latest-version) unless this env var is set; observed on the host as an
# unexplained `pi.dev` entry in a Turn's activities.metadata.egress. The image is pinned and
# updated only by rebuilding it, so the check is pure noise here — and every agent container's
# outbound traffic should be the agent's own, not the runtime's. Image-level ENV: it does not
# depend on worker-supervisor's env allowlist, which deliberately passes nothing else through.
ENV PI_SKIP_VERSION_CHECK=1

ENTRYPOINT ["/opt/nexttime/entrypoint.sh"]
