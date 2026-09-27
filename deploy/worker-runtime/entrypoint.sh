#!/bin/sh
# entrypoint.sh — agent runtime container entrypoint (design doc §7.2, §7.3, §7.4;
# docs/development-tasks.md S1.5). Runs as the non-root `nexttime` user (uid 10001), root
# filesystem read-only, `/workspace` (the per-principal bind mount) and `/tmp` (tmpfs) writable.
#
# `NEXTTIME_MODE` (entry/worker/interactive) is read by @nexttime/platform-extension itself, not
# branched on here — this script's job is only to prepare `/workspace`'s directory layout (which
# is the same regardless of mode: pi's own session/config dirs, plus this S1 stopgap system
# prompt) and exec pi with the flags verified against pi 0.84.4's own CLI and re-verified on
# 0.87.1 (see Dockerfile header for the exact source files/lines cited).
#
# Flags, verified against pi 0.84.4 (packages/coding-agent/src/cli/args.ts) and unchanged in
# 0.87.1 (`dist/cli/args.js`, `pi --help`):
#   --mode rpc                    JSON-RPC over stdio (agent-host's later half attaches to this).
#                                  0.87.1 exits non-zero on a missing/invalid --mode value
#                                  instead of silently falling back; `rpc` is valid.
#   --session-dir <dir>           pi's own session storage/lookup root.
#   -e <path>                     load the platform extension (jiti-loaded; NEXTTIME_MODE picks
#                                  entry/worker/interactive inside it — @nexttime/platform-
#                                  extension's src/index.ts).
#   --system-prompt <path>        NOT a `--system-prompt-file` flag (no such flag exists in
#                                  0.84.4 or 0.87.1) — `resource-loader.ts` `resolvePromptInput`
#                                  reads this value as a *file's contents* whenever the path
#                                  exists, so passing a path here does the same thing a `-file`
#                                  flag would.
# Built-in tools (STATUS leftover 95, maintainer 2026-09-27: "pi agent 本身的权限其实不需要限制的，
# 主要限制是访问其他系统"): every pi built-in the image can actually run is active — read / bash /
# edit / write / grep / find / ls. pi's own default active set is only read / bash / edit / write
# (`core/sdk.js` `defaultActiveToolNames`); the wider set is written as `defaultTools` into pi's
# global settings below. NOT via `--tools`: that option is an allowlist over *every* tool,
# extension tools included (`agent-session.js` `_refreshToolRegistry` `isAllowedTool`), so it
# would switch off the platform extension's kernel tools. `powershell` stays off — no pwsh in
# this Linux image. Access to other systems is untouched: it is the kernel's (Handles,
# gatekeepers, approvals). See docs/runbooks/pi-upgrade.md §2.2.
#
# Any arguments this container was started with (`docker create ... image [CMD...]`) are appended
# after the flags above — none of the S1.5 resident-mode spawn spec sets a CMD, so ordinarily
# there are none; this only exists so a later one-shot Worker mode (S2.8/S2.9) can extend the
# invocation via a CMD override without editing this file.
#
# Self-check (design doc §5.4 I9/I10; docs/development-tasks.md S2.9; lane-6 review P3): when
# `NEXTTIME_MODE` is `worker` **or `entry`**, this script exits non-zero *before* exec'ing pi if
# either invariant does not hold — a misconfigured container must fail loudly, never start with a
# leaked provider credential or a broken egress boundary. I9/I10 are invariants of *every* agent
# container this image runs as, not just one-shot Workers: an entry container shares the exact
# same egress/credential isolation guarantees (design doc §7.2/§7.3), runs far longer-lived
# (resident, hours to days vs. one-shot), and handles a real user's Handle — there was never a
# reason it should skip a check a Worker container gets. Originally shipped worker-only (S2.9);
# widened to cover entry mode too once that gap was noticed (this fix does not touch
# `interactive` mode, which stays unchecked — a local dev/test path outside the full deployment
# topology this check assumes). S1.5's entry-mode behavior otherwise (directory prep, the stopgap
# system prompt, the exec itself) is entirely unchanged. One structured `nexttime-selfcheck
# check=<name> result=<ok|fail|skip> ...` line per check — never an env var's *value*, only its
# name, even on failure (I9). The public proxied-reachability probe is skippable
# (`NEXTTIME_SELFCHECK_SKIP_PUBLIC_EGRESS_PROBE=1`, for offline test runs) but defaults on.
#
# Which checks are fatal (W8, STATUS leftover 29): the two *invariant* checks — no provider key in
# the environment (I9) and no direct route out (I10) — still refuse to start pi. The proxied
# public-reachability probe is a *liveness* check, not an invariant: a slow or flaky WAN made it
# miss its 5 s budget twice on 2026-09-11, each time killing a fresh entry container 5 s after
# spawn, so the user's first Turn ended `interrupted` with zero tool calls and nothing retried.
# Isolation is already proven by the direct-route check; a proxy that is merely slow right now is
# something the agent finds out on its first fetch. So that probe now reports `result=warn` and
# continues. `no_proxy_configured` stays fatal: that is a misconfigured container, not weather.

set -eu

SESSION_DIR="/workspace/.pi/sessions"
AGENT_DIR="/workspace/.pi/agent"
SYSTEM_PROMPT_FILE="/workspace/.nexttime/system-prompt.md"
EXTENSION_ENTRY="/opt/nexttime/platform-extension/dist/index.js"

mkdir -p "$SESSION_DIR" "$AGENT_DIR" "/workspace/.nexttime" "/workspace/.local"

# pi's global settings live at <agentDir>/settings.json — `/workspace/.pi/agent` for both modes
# (entry: PI_CODING_AGENT_DIR; task: HOME=/workspace, pi's default). Merged, never overwritten:
# pi and the agent may keep their own settings there. An unreadable file is left alone (pi then
# falls back to its default four tools) rather than failing the container.
node -e '
const fs = require("fs");
const file = process.argv[1];
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") {
    console.log("nexttime-selfcheck check=pi_default_tools result=warn reason=settings_unreadable");
    process.exit(0);
  }
}
settings.defaultTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
try {
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
} catch {
  console.log("nexttime-selfcheck check=pi_default_tools result=warn reason=settings_unwritable");
  process.exit(0);
}
console.log("nexttime-selfcheck check=pi_default_tools result=ok tools=" + settings.defaultTools.join(","));
' "$AGENT_DIR/settings.json"

# S1 stopgap default (design doc §7.2: "--system-prompt 来自该用户入口 WorkerDefinition 的已发布
# 版本" — WorkerDefinition-driven prompts land in S2.6; until then every entry container gets
# this static prompt). Written only if missing, so a future mechanism that pre-seeds a real one
# into the workspace before first spawn is never clobbered on restart.
if [ ! -f "$SYSTEM_PROMPT_FILE" ]; then
	cat >"$SYSTEM_PROMPT_FILE" <<'EOF'
You are the entry agent for a NextTime-AI user, running inside your own container with a
persistent workspace at /workspace. This workspace has not published an entry WorkerDefinition
yet (or the platform could not load it), so you are running with the default configuration: real
file, bash, and Python tools, package installs through the platform's egress proxy, and read
access to the platform's shared knowledge graph through the `get_object`, `traverse`, `search`,
`explain`, and `get_task` tools.

You cannot directly reach internal systems or anything requiring credentials. Answer from the
graph, your own tools, and the public internet, and say plainly when something would need a
capability you don't have.
EOF
fi

if [ "${NEXTTIME_MODE:-}" = "worker" ] || [ "${NEXTTIME_MODE:-}" = "entry" ]; then
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
		# Non-fatal (see the header): a transient proxied failure must not take the container down.
		if curl --max-time 5 -s -o /dev/null https://example.com; then
			echo "nexttime-selfcheck check=egress_via_proxy result=ok"
		else
			echo "nexttime-selfcheck check=egress_via_proxy result=warn reason=proxied_request_failed"
		fi
	fi
fi

exec pi \
	--mode rpc \
	--session-dir "$SESSION_DIR" \
	-e "$EXTENSION_ENTRY" \
	--system-prompt "$SYSTEM_PROMPT_FILE" \
	"$@"
