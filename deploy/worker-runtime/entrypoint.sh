#!/bin/sh
# entrypoint.sh — agent runtime container entrypoint (design doc §7.2, §7.3, §7.4;
# docs/development-tasks.md S1.5). Runs as the non-root `nexttime` user (uid 10001), root
# filesystem read-only, `/workspace` (the per-principal bind mount) and `/tmp` (tmpfs) writable.
#
# `NEXTTIME_MODE` (entry/worker/interactive) is read by @nexttime/platform-extension itself, not
# branched on here — this script's job is only to prepare `/workspace`'s directory layout (which
# is the same regardless of mode: pi's own session/config dirs, plus this S1 stopgap system
# prompt) and exec pi with the flags verified against pi 0.84.4's own CLI (see Dockerfile header
# for the exact source files/lines cited).
#
# Flags, verified against pi 0.84.4 (packages/coding-agent/src/cli/args.ts):
#   --mode rpc                    JSON-RPC over stdio (agent-host's later half attaches to this).
#   --session-dir <dir>           pi's own session storage/lookup root.
#   -e <path>                     load the platform extension (jiti-loaded; NEXTTIME_MODE picks
#                                  entry/worker/interactive inside it — @nexttime/platform-
#                                  extension's src/index.ts).
#   --system-prompt <path>        NOT a `--system-prompt-file` flag (no such flag exists in
#                                  0.84.4) — `resource-loader.ts` `resolvePromptInput` reads this
#                                  value as a *file's contents* whenever the path exists, so
#                                  passing a path here does the same thing a `-file` flag would.
# No --tools/--no-tools/--no-builtin-tools/--exclude-tools: built-in tools stay on by pi's own
# default (design doc §7.2/§7.3/§11 "内置工具全开").
#
# Any arguments this container was started with (`docker create ... image [CMD...]`) are appended
# after the flags above — none of the S1.5 resident-mode spawn spec sets a CMD, so ordinarily
# there are none; this only exists so a later one-shot Worker mode (S2.8/S2.9) can extend the
# invocation via a CMD override without editing this file.

set -eu

SESSION_DIR="/workspace/.pi/sessions"
AGENT_DIR="/workspace/.pi/agent"
SYSTEM_PROMPT_FILE="/workspace/.nexttime/system-prompt.md"
EXTENSION_ENTRY="/opt/nexttime/platform-extension/dist/index.js"

mkdir -p "$SESSION_DIR" "$AGENT_DIR" "/workspace/.nexttime" "/workspace/.local"

# S1 stopgap default (design doc §7.2: "--system-prompt 来自该用户入口 WorkerDefinition 的已发布
# 版本" — WorkerDefinition-driven prompts land in S2.6; until then every entry container gets
# this static prompt). Written only if missing, so a future mechanism that pre-seeds a real one
# into the workspace before first spawn is never clobbered on restart.
if [ ! -f "$SYSTEM_PROMPT_FILE" ]; then
	cat >"$SYSTEM_PROMPT_FILE" <<'EOF'
You are the entry agent for a NextTime-AI user, running inside your own container with a
persistent workspace at /workspace. You have real file, bash, and Python tools, can install
packages (pip/npm/apt reach the network through the platform's egress proxy), and can read the
platform's shared knowledge graph through the `get_object`, `traverse`, `search`, `explain`, and
`get_task` tools.

You cannot directly reach internal systems or anything requiring credentials — those go through
Gatekeepers and an approval flow that is not available in this build yet. For now, focus on
answering from the graph, your own tools, and the public internet; say plainly when something
would require a capability you don't have.

This is a generic stopgap prompt (docs/development-tasks.md S1.5); a per-workspace, published
WorkerDefinition-driven prompt replaces it in a later milestone (S2.6).
EOF
fi

exec pi \
	--mode rpc \
	--session-dir "$SESSION_DIR" \
	-e "$EXTENSION_ENTRY" \
	--system-prompt "$SYSTEM_PROMPT_FILE" \
	"$@"
