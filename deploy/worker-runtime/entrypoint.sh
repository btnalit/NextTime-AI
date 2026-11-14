#!/bin/sh
# entrypoint.sh — agent runtime container entrypoint (design doc §7.2, §7.3, §7.4;
# docs/development-tasks.md S1.5). Runs as the non-root `nexttime` user (uid 10001), root
# filesystem read-only, `/workspace` (the per-principal bind mount) and `/tmp` (tmpfs) writable.
#
# `NEXTTIME_MODE` (entry/admin/worker/interactive) is read by @nexttime/platform-extension itself;
# here it only picks which checks run (below) — this script's job is to prepare pi's directories
# and exec pi with an explicit whitelist of everything it loads, with the flags verified against
# pi 0.84.4's own CLI and re-verified on 0.87.1, 0.99.2 and 1.1.0 (see Dockerfile header for the
# exact source files/lines cited).
#
# Whitelist start (STATUS leftover 422, docs/runbooks/pi-upgrade.md §2.6; maintainer 2026-10-23:
# the platform uses pi's core runtime only, every outer layer is the platform's own): pi loads nothing it finds on its own — not from
# `/workspace` (persistent, written by the agent's own bash / write tools), not from `$HOME`, not
# from its agent directory. What it loads is exactly what this script names:
#   - the platform extension (`-e`), the platform's system prompt (`--system-prompt`) and the
#     published Skills (`--skill`) — the last two from `/opt/nexttime/platform`, which
#     worker-supervisor writes outside the workspace and mounts read-only (host-paths.ts);
#   - pi's settings (`/opt/nexttime/pi-settings.json`, image content) and models.json (read-only
#     mount), copied / linked into a fresh agent directory under `/tmp` at every start.
# Everything else is switched off (pi 1.1.0 `dist/cli/args.js`, `dist/core/resource-loader.js`):
#   --no-context-files            AGENTS.md / CLAUDE.md from the agent dir, cwd and every parent.
#   --no-extensions               extension discovery, settings/package extensions, and pi's
#                                  built-in extensions (llama.cpp, codemode, tool-search, mcp —
#                                  the platform uses none of them); `-e` paths still load.
#   --no-skills                   skill discovery (agent dir, `~/.agents/skills`, settings,
#                                  packages); `--skill` paths still load.
#   --no-prompt-templates / --no-themes   the same for prompt templates and themes.
#   --no-mcp                      pi's own MCP client (systems are reached through the kernel).
#   --no-approve                  project-local `.pi/` resources (settings, extensions, skills,
#                                  SYSTEM.md / APPEND_SYSTEM.md, mcp.json) are never trusted,
#                                  whatever a trust.json or `defaultProjectTrust` says.
#   --append-system-prompt ""     an explicit (empty) addendum, so pi never looks for
#                                  `<agentDir>/APPEND_SYSTEM.md` — no flag switches that one off.
# pi's agent directory itself is not discoverable state either: it holds auth.json, trust.json,
# models-store.json and settings.json, which pi reads with no switch to stop it, and pi must be
# able to write there (settings locks), so it cannot be read-only. It lives under `/tmp` (the
# container's tmpfs) and is rebuilt from scratch here at every start; the platform extension puts
# it back to exactly this state whenever pi replaces its session — a new, resumed or forked
# conversation, a reload (`src/pi-agent-dir.ts`) — so a change the agent makes there never
# outlives the conversation it was made in.
#
# Flags, verified against pi 0.84.4 (packages/coding-agent/src/cli/args.ts) and unchanged in
# 0.87.1, 0.99.2 and 1.1.0 (`dist/cli/args.js`, `pi --help`):
#   --mode rpc                    JSON-RPC over stdio (agent-host's later half attaches to this).
#                                  0.87.1 exits non-zero on a missing/invalid --mode value
#                                  instead of silently falling back; `rpc` is valid.
#   --session-dir <dir>           pi's own session storage/lookup root.
#   -e <path>                     load the platform extension (jiti-loaded; NEXTTIME_MODE picks
#                                  entry/worker/interactive inside it — @nexttime/platform-
#                                  extension's src/index.ts).
#   --system-prompt <path>        NOT a `--system-prompt-file` flag (no such flag exists in
#                                  0.84.4 through 1.1.0) — `resource-loader.ts` `resolvePromptInput`
#                                  reads this value as a *file's contents* whenever the path
#                                  exists, so passing a path here does the same thing a `-file`
#                                  flag would.
# Built-in tools (STATUS leftover 95, maintainer 2026-09-27: "pi agent 本身的权限其实不需要限制的，
# 主要限制是访问其他系统"): every pi built-in the image can actually run is active — read / bash /
# edit / write / grep / find / ls. pi's own default active set is only read / bash / edit / write
# (`core/sdk.js` `defaultActiveToolNames`; 0.99.2: `core/settings-manager.js` `DEFAULT_TOOL_NAMES`);
# the wider set is `defaultTools` in pi's global settings (`pi-settings.json`, next to this file) — a
# plain-name list, which still replaces the default set on 1.1.0 (the `+name`/`-name` modifiers are
# not used).
# 0.99's built-in `codemode`/`tool_search` tools are `defaultActive: false` and not listed, so they
# stay off (docs/runbooks/pi-upgrade.md §2.4). NOT via `--tools`: that option is an allowlist over *every* tool,
# extension tools included (`agent-session.js` `_refreshToolRegistry` `isAllowedTool`), so it
# would switch off the platform extension's kernel tools. `powershell` stays off — no pwsh in
# this Linux image. Access to other systems is untouched: it is the kernel's (Handles,
# gatekeepers, approvals). See docs/runbooks/pi-upgrade.md §2.2.
#
# The one exception (S11 GO18a P3, independent review N6): a Worker the kernel limits to reading
# files — a goal reviewer, which reads what other Workers wrote and must not run any of it —
# comes with `NEXTTIME_BUILTIN_TOOLS=read_only` (worker-supervisor `task-spawn-spec.ts`), and pi
# then starts from `pi-settings-read-only.json` instead: read / grep / find / ls, no bash / edit /
# write. The same file is what the platform extension restores on every session change
# (`NEXTTIME_PI_SETTINGS`), and the agent has no tool left that could write pi's settings. Any
# other value refuses to start (`check=builtin_tools`): never the full set by mistake. This
# image speaks runtime contract 3 for it (Dockerfile label), so a supervisor that asks for it
# never starts an image that would ignore it.
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
# (`NEXTTIME_SELFCHECK_SKIP_PUBLIC_EGRESS_PROBE=1`, for offline test runs) but defaults on — in
# entry and worker mode only: in admin mode the probe is an invariant (below) and always runs.
#
# Which checks are fatal (W8, STATUS leftover 29): the two *invariant* checks — no provider key in
# the environment (I9) and no direct route out (I10) — still refuse to start pi. The proxied
# public-reachability probe is a *liveness* check, not an invariant: a slow or flaky WAN made it
# miss its 5 s budget twice on 2026-09-11, each time killing a fresh entry container 5 s after
# spawn, so the user's first Turn ended `interrupted` with zero tool calls and nothing retried.
# Isolation is already proven by the direct-route check; a proxy that is merely slow right now is
# something the agent finds out on its first fetch. So that probe now reports `result=warn` and
# continues. `no_proxy_configured` stays fatal: that is a misconfigured container, not weather.
# The two source-binding checks are invariants too and fatal: `handle_env` (no Handle in the
# environment) and `handle_binding` (pi starts only once this container's address is bound to this
# container).
#
# Admin mode (S11 AA4c-2): a platform administrator's admin agent, in a resident container of its
# own (worker-supervisor `resident-kind.ts`). Every check above runs for it as for entry mode, and
# two are stricter. Its egress source is registered deny-all, so the probe's request must be
# *refused* (`egress_denied`) — through the proxy when one is configured, straight out when none is
# (curl takes the proxy variables when they are set), and whatever the skip switch says: a request
# that goes through means its isolation is not in place, and pi does not start. A refusal, the
# proxy's 403 and no route at all are all "denied". And it needs the platform's own admin agent
# prompt (`admin_prompt`): the image's default prompt is the entry agent's, so an admin container
# without its prompt refuses to start rather than run as something it is not (worker-supervisor
# refuses an admin spawn without one too, `config.ts` `SpawnRequestSchema`).

set -eu

# Test-only path prefix: packages/platform-extension's runtime-whitelist test runs this script on a
# CI runner, with real pi, under a scratch directory standing in for `/`. worker-supervisor never
# sets it (its env allowlist, spawn-spec.ts / task-spawn-spec.ts), and an entry or Worker container
# that has it refuses to start rather than load anything from another root.
ROOT="${NEXTTIME_RUNTIME_ROOT:-}"
if [ -n "$ROOT" ]; then
	case "${NEXTTIME_MODE:-}" in
	entry | admin | worker)
		echo "nexttime-selfcheck check=runtime_root result=fail reason=test_only_variable_set"
		exit 1
		;;
	esac
fi

SESSION_DIR="$ROOT/workspace/.pi/sessions"
AGENT_DIR="$ROOT/tmp/pi-agent"
PLATFORM_DIR="$ROOT/opt/nexttime/platform"
PI_SETTINGS_FILE="$ROOT/opt/nexttime/pi-settings.json"
MODELS_JSON="$ROOT/opt/nexttime/models.json"
DEFAULT_SYSTEM_PROMPT_FILE="$ROOT/opt/nexttime/default-system-prompt.md"
EXTENSION_ENTRY="$ROOT/opt/nexttime/platform-extension/dist/index.js"

# Admin mode (header): never on the image's default prompt, which is the entry agent's. Checked
# before anything is written, so a container started without its prompt changes nothing.
if [ "${NEXTTIME_MODE:-}" = "admin" ] && [ ! -f "$PLATFORM_DIR/system-prompt.md" ]; then
	echo "nexttime-selfcheck check=admin_prompt result=fail reason=platform_prompt_missing"
	exit 1
fi

# The built-in tool set (header): checked before anything is written, so a container started with
# a value this image does not know changes nothing.
case "${NEXTTIME_BUILTIN_TOOLS:-}" in
"") ;;
read_only)
	PI_SETTINGS_FILE="$ROOT/opt/nexttime/pi-settings-read-only.json"
	echo "nexttime-selfcheck check=builtin_tools result=ok set=read_only"
	;;
*)
	echo "nexttime-selfcheck check=builtin_tools result=fail reason=unknown_value"
	exit 1
	;;
esac

mkdir -p "$SESSION_DIR" "$ROOT/workspace/.local"

# pi's agent directory, rebuilt at every start (header): the platform's settings, the platform's
# models.json, and nothing else. `PI_CODING_AGENT_DIR` is pi's own variable (`dist/config.js`
# `getAgentDir`); the platform extension rebuilds the same directory from `NEXTTIME_PI_SETTINGS`
# and `NEXTTIME_PI_MODELS` whenever pi replaces its session (header).
rm -rf "$AGENT_DIR"
mkdir -p "$AGENT_DIR"
cp "$PI_SETTINGS_FILE" "$AGENT_DIR/settings.json"
ln -s "$MODELS_JSON" "$AGENT_DIR/models.json"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
export NEXTTIME_PI_SETTINGS="$PI_SETTINGS_FILE"
export NEXTTIME_PI_MODELS="$MODELS_JSON"
# pi loads the platform extension through jiti, whose compile cache defaults to `/tmp/jiti`:
# agent-writable, and a cached file is used as is whenever the extension is loaded again in this
# container. Off, so what pi runs as the platform extension is always the image's own file
# (`runtime-whitelist.test.ts`, the file-access test, fails on anything else under `/tmp`).
export JITI_FS_CACHE=false

# The published entry WorkerDefinition's prompt (S2.6) or Worker prompt (P-A2), written by
# worker-supervisor; the image's own default when there is none yet.
SYSTEM_PROMPT_FILE="$PLATFORM_DIR/system-prompt.md"
system_prompt_source=platform
if [ ! -f "$SYSTEM_PROMPT_FILE" ]; then
	SYSTEM_PROMPT_FILE="$DEFAULT_SYSTEM_PROMPT_FILE"
	system_prompt_source=default
fi

case "${NEXTTIME_MODE:-}" in
worker | entry | admin) run_selfcheck=1 ;;
*) run_selfcheck=0 ;;
esac

# The public reachability probe, the self-check's last step (header). A function of its own that
# reads only the environment and `curl`, so `runtime-whitelist.test.ts` can run it on its own: the
# whole script never gets this far there, since admin mode refuses the test-only root.
egress_probe() {
	if [ "${NEXTTIME_MODE:-}" = "admin" ]; then
		# Admin mode (header): its source is deny-all, so this request must fail — fatal when it
		# does not: not weather, its isolation. Checked before the skip switch, which has no say
		# here, and with or without proxy variables: curl goes through the proxy when they are set
		# and straight out when they are not, and either way out must be closed.
		if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
			denied_route=proxied
		else
			denied_route=direct
		fi
		denied_rc=0
		curl --max-time 5 -s -o /dev/null https://example.com || denied_rc=$?
		if [ "$denied_rc" -eq 0 ]; then
			echo "nexttime-selfcheck check=egress_denied result=fail reason=${denied_route}_request_allowed"
			exit 1
		fi
		echo "nexttime-selfcheck check=egress_denied result=ok curl_rc=${denied_rc}"
	elif [ "${NEXTTIME_SELFCHECK_SKIP_PUBLIC_EGRESS_PROBE:-}" = "1" ]; then
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
}

if [ "$run_selfcheck" = "1" ]; then
	# Whitelist start (STATUS leftover 422): models.json is worker-supervisor's read-only mount; the
	# image only holds an empty placeholder at that path. Empty means a worker-supervisor from before
	# this image started the container (an upgrade between pulling the images and restarting the
	# services, or a rollback of the supervisor alone), and pi would only fail later, on an unknown
	# provider at the first prompt.
	if [ ! -s "$MODELS_JSON" ]; then
		echo "nexttime-selfcheck check=models_json result=fail reason=empty_mount"
		exit 1
	fi
	echo "nexttime-selfcheck check=models_json result=ok"

	# I9: no agent process (this one included) may ever hold an LLM provider credential — provider
	# keys live only in llm-proxy. A *_API_KEY-shaped env var here means a misconfigured container;
	# fail before pi ever starts. Names only, never values.
	if env | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*_API_KEY='; then
		leaked_vars=$(env | grep -E '^[A-Za-z_][A-Za-z0-9_]*_API_KEY=' | cut -d= -f1 | tr '\n' ',' | sed 's/,$//')
		echo "nexttime-selfcheck check=api_key_env result=fail vars=${leaked_vars}"
		exit 1
	fi
	echo "nexttime-selfcheck check=api_key_env result=ok"

	# Source binding (@nexttime/shared handle-binding.ts; design doc §7.3): an entry agent's or a
	# WorkerRun's Handle never enters this container — worker-supervisor binds it to the
	# container's address, and the kernel / llm-proxy take it from there. `CAPABILITY_HANDLE` is
	# only the `source-bound` marker pi's models.json resolves as the provider key; a JWT-shaped
	# value (`eyJ….eyJ….…`, the form every Handle has) in any variable means a Handle leaked into
	# the environment. Fatal, names only — never a value (I9).
	if [ "${CAPABILITY_HANDLE:-}" != "source-bound" ]; then
		echo "nexttime-selfcheck check=handle_env result=fail reason=capability_handle_not_source_bound"
		exit 1
	fi
	if env | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*=.*eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}'; then
		token_vars=$(env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=.*eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}' | cut -d= -f1 | tr '\n' ',' | sed 's/,$//')
		echo "nexttime-selfcheck check=handle_env result=fail reason=token_shaped_value vars=${token_vars}"
		exit 1
	fi
	echo "nexttime-selfcheck check=handle_env result=ok"

	# The other half: pi — the first model-controlled process here — starts only once the binding at
	# this container's address names this container. Docker can hand a new container an address
	# whose previous holder's binding is still in place (the previous container exited and
	# worker-supervisor has not seen it yet); worker-supervisor replaces it right after this
	# container starts. `GET /api/source-binding` answers with the id of the container bound to the
	# caller's address — never the Handle — and this container's hostname is its own id's prefix.
	# Bounded (20 s), fatal on timeout.
	self_id=${HOSTNAME:-$(cat /etc/hostname 2>/dev/null || true)}
	case "$self_id" in
	"" | *[!0-9a-f]*)
		echo "nexttime-selfcheck check=handle_binding result=fail reason=hostname_not_a_container_id"
		exit 1
		;;
	esac
	bound_id=""
	binding_deadline=$(($(date +%s) + 20))
	while :; do
		binding_body=$(curl --noproxy '*' --max-time 5 -fsS "${KERNEL_URL%/}/api/source-binding" 2>/dev/null || true)
		bound_id=$(printf '%s' "$binding_body" | sed -n 's/.*"containerId"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
		case "$bound_id" in
		"$self_id"*) break ;;
		esac
		if [ "$(date +%s)" -ge "$binding_deadline" ]; then
			if [ -n "$bound_id" ]; then
				echo "nexttime-selfcheck check=handle_binding result=fail reason=address_bound_to_another_container"
			else
				echo "nexttime-selfcheck check=handle_binding result=fail reason=address_not_bound"
			fi
			exit 1
		fi
		sleep 0.25
	done
	echo "nexttime-selfcheck check=handle_binding result=ok"

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

	egress_probe
fi

# Published Skills (S2.14 / S3.13), one directory per Skill, written by worker-supervisor.
skill_count=0
if [ -d "$PLATFORM_DIR/skills" ]; then
	skill_count=$(find "$PLATFORM_DIR/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
	set -- --skill "$PLATFORM_DIR/skills" "$@"
fi
echo "nexttime-selfcheck check=pi_resource_discovery result=off system_prompt=${system_prompt_source} skills=${skill_count}"

exec pi \
	--mode rpc \
	--session-dir "$SESSION_DIR" \
	--no-context-files \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-themes \
	--no-mcp \
	--no-approve \
	--append-system-prompt "" \
	-e "$EXTENSION_ENTRY" \
	--system-prompt "$SYSTEM_PROMPT_FILE" \
	"$@"
