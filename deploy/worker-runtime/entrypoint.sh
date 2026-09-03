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
#
# S2.9 worker-mode self-check (design doc §5.4 I9/I10; docs/development-tasks.md S2.9): when
# `NEXTTIME_MODE=worker`, this script exits non-zero *before* exec'ing pi if either invariant does
# not hold — a misconfigured Worker container must fail loudly, never start with a leaked provider
# credential or a broken egress boundary. S1.5's entry-mode behavior (directory prep, the stopgap
# system prompt, the exec itself) is entirely unchanged; the self-check is additive and only runs
# for `worker` mode. One structured `nexttime-selfcheck check=<name> result=<ok|fail|skip> ...`
# line per check — never an env var's *value*, only its name, even on failure (I9). The public
# proxied-reachability probe is skippable (`NEXTTIME_SELFCHECK_SKIP_PUBLIC_EGRESS_PROBE=1`, for
# offline test runs) but defaults on.

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

if [ "${NEXTTIME_MODE:-}" = "worker" ]; then
	# I9: no agent process (this one included) may ever hold an LLM provider credential — provider
	# keys live only in llm-proxy. A *_API_KEY-shaped env var here means a misconfigured container;
	# fail before pi ever starts. Names only, never values.
	if env | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*_API_KEY='; then
		leaked_vars=$(env | grep -E '^[A-Za-z_][A-Za-z0-9_]*_API_KEY=' | cut -d= -f1 | tr '\n' ',' | sed 's/,$//')
		echo "nexttime-selfcheck check=api_key_env result=fail vars=${leaked_vars}"
		exit 1
	fi
	echo "nexttime-selfcheck check=api_key_env result=ok"

	# I10: this container must have no direct route out at all — only through the egress proxy
	# (design doc §7.9 "容器没有直接路由"). Probes the same public domain the proxied check below
	# uses, with the proxy explicitly bypassed (--noproxy '*'), so this needs no internal
	# service name/address of its own — and is offline-safe by construction: a DNS/connect failure
	# while genuinely disconnected is exactly the "blocked" outcome this check wants (curl_rc is
	# reported either way, for visibility). Bounded timeout so a hung attempt cannot wedge startup.
	direct_rc=0
	curl --noproxy '*' --max-time 3 -s -o /dev/null https://example.com 2>/dev/null || direct_rc=$?
	if [ "$direct_rc" -eq 0 ]; then
		echo "nexttime-selfcheck check=egress_no_direct_route result=fail reason=direct_connection_succeeded"
		exit 1
	fi
	echo "nexttime-selfcheck check=egress_no_direct_route result=ok curl_rc=${direct_rc}"

	if [ "${NEXTTIME_SELFCHECK_SKIP_PUBLIC_EGRESS_PROBE:-}" = "1" ]; then
		echo "nexttime-selfcheck check=egress_via_proxy result=skip reason=NEXTTIME_SELFCHECK_SKIP_PUBLIC_EGRESS_PROBE=1"
	else
		# A false "proxied ok" (direct route + unset proxy vars) is worse than no check at all.
		if [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
			echo "nexttime-selfcheck check=egress_via_proxy result=fail reason=no_proxy_configured"
			exit 1
		fi
		if curl --max-time 5 -s -o /dev/null https://example.com; then
			echo "nexttime-selfcheck check=egress_via_proxy result=ok"
		else
			echo "nexttime-selfcheck check=egress_via_proxy result=fail reason=proxied_request_failed"
			exit 1
		fi
	fi
fi

exec pi \
	--mode rpc \
	--session-dir "$SESSION_DIR" \
	-e "$EXTENSION_ENTRY" \
	--system-prompt "$SYSTEM_PROMPT_FILE" \
	"$@"
