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
# reference project, never copied into this repo), and re-verified for the 0.87.1 upgrade against
# the published npm package's own `dist/` + `docs/` (the same modules, compiled: `dist/cli/args.js`,
# `dist/core/resource-loader.js`, `dist/config.js`, `dist/core/extensions/loader.js`,
# `dist/core/tools/index.js`, `dist/core/sdk.js`) plus a real `pi --mode rpc -e <extension>` run
# against deploy/fake-llm (docs/runbooks/pi-upgrade.md §2). Every bullet below still holds on
# 0.87.1; the only CLI change is that `--mode` now rejects a missing/invalid value instead of
# silently ignoring it (`rpc` is valid):
#   - packages/coding-agent/docs/containerization.md "Plain Docker" recipe is the base for the
#     runtime stage below: `node:24-bookworm-slim`, apt `bash ca-certificates git ripgrep`,
#     `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. This Dockerfile adds
#     curl/python3/python3-pip/python3-venv/build-essential on top, per this task's own toolchain
#     list — pi's own install needs none of them (no native compilation: 0.84.4's one optional
#     native dep, @mariozechner/clipboard, shipped prebuilt platform binaries, and 0.86.0 dropped
#     it for bundled clipboard helpers); they exist for the agent's own bash/python tool use
#     inside the container.
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
#     `--no-builtin-tools`/`--exclude-tools`, so pi's own default *active* set applies — which is
#     `read`/`bash`/`edit`/`write` (`core/sdk.js` `defaultActiveToolNames`, identical in 0.84.4
#     and 0.87.1, and confirmed by the `toolsAdded` of a real 0.87.1 RPC run), not all eight:
#     find/grep/ls are reached through `bash` (ripgrep is installed below). Design doc
#     §7.2/§7.3/§11 "内置工具全开" holds in that sense only.
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
# agent@<pi.version>", currently 0.87.1). --ignore-scripts matches pi's own containerization.md
# recipe (header above; unchanged in 0.87.1).
#
# Single source of truth (docs/runbooks/pi-upgrade.md "升级契约"): the root `pi.version` file,
# read here rather than hardcoded — bumping pi means editing exactly that one file for the image.
# `pnpm`/`npm` still need a literal version string in packages/platform-extension/package.json's
# own `dependencies`/`devDependencies` (no file-reference syntax exists for that), so those two
# pins are kept honest against pi.version by scripts/check-pi-version-consistency.sh
# (`pnpm ci:guards`) instead of reading the same file directly — see the runbook for why a
# Dockerfile ARG wired through docker-compose.yml's build args was not used instead (this COPY
# needs no change to the build invocation `docker compose build worker-runtime` already uses).
COPY pi.version /tmp/pi.version
RUN PI_VERSION="$(cat /tmp/pi.version)" \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && rm /tmp/pi.version

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
# pi (0.84.4; unchanged in 0.87.1, whose `dist/main.js` still skips the RPC-mode catalog refresh
# under it) performs "startup network operations" of its own — a release check
# (dist/utils/version-check.js → https://pi.dev/api/latest-version) and a remote model-catalog
# refresh (DEFAULT_CATALOG_BASE_URL = https://pi.dev, written to <agentDir>/models-store.json) —
# observed on the host as unexplained `pi.dev` entries in Turns' activities.metadata.egress.
# PI_OFFLINE=1 is pi's own documented switch for exactly this ("--offline: Disable startup
# network operations (same as PI_OFFLINE=1)"; it also covers the version check). The image is
# pinned and models.json is generated by the platform, so nothing is lost — and every agent
# container's outbound traffic should be the agent's own, not the runtime's. Image-level ENV: it
# does not depend on worker-supervisor's env allowlist, which deliberately passes nothing else.
ENV PI_OFFLINE=1

# S7-E (docs/platform-admin-design.md §6.5 "镜像 label"; docs/development-tasks.md §5d S7-E):
# `worker-supervisor`'s `GET /images` (packages/worker-supervisor/src/docker-client.ts
# `IMAGE_PI_VERSION_LABEL`) lists only images carrying these three labels — the kernel's
# `runtime_inventory`/`pi_drift` capabilities read them back over that HTTP call, never by
# reaching into the image build itself.
#
# Same "build arg -> image metadata, value supplied by the *build* shell's environment" shape
# `packages/kernel/Dockerfile`'s own `KERNEL_VERSION` already uses (see that file's header comment
# for the full "why not derive it inside the Dockerfile" reasoning — `.git/` is excluded from the
# build context here too, and this image has no equivalent way to read
# `packages/platform-extension/package.json`'s own version after `pnpm deploy` flattens it away).
# `pi.version` stays the single source of truth for the *pinned dependency* (the `COPY pi.version`
# + `npm install` above, unchanged) — `PI_VERSION` here is only the transient carrier that copies
# that same file's content into this label, computed by the build invoker immediately before
# `docker compose build worker-runtime`:
#
#   export PI_VERSION="$(cat pi.version)"
#   export PLATFORM_EXTENSION_VERSION="$(node -p "require('./packages/platform-extension/package.json').version")"
#   export BUILT_FROM="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"
#
# (docs/runbooks — "运行层" operations section). Unset -> "dev", matching KERNEL_VERSION's own
# fallback for a local/CI build that never exported these.
ARG PI_VERSION=dev
ARG PLATFORM_EXTENSION_VERSION=dev
ARG BUILT_FROM=dev
LABEL ai.nexttime.pi-version="${PI_VERSION}" \
      ai.nexttime.platform-extension-version="${PLATFORM_EXTENSION_VERSION}" \
      ai.nexttime.built-from="${BUILT_FROM}"

ENTRYPOINT ["/opt/nexttime/entrypoint.sh"]
