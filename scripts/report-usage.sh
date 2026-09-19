#!/bin/sh
# report-usage.sh — S5.7 真实模型回归常态化 (docs/development-tasks.md §"S5.7 真实模型回归常态化";
# docs/runbooks/host-accept-real-model.md §"每次发版后的例行回归"). POSIX sh, run ON THE HOST from
# the checkout root — same conventions as scripts/drill-restore.sh: sources ./.env, queries the
# already-running `postgres` compose service directly via `docker compose exec`, no jq dependency,
# no temp files written into the repo.
#
# What this reports: aggregated `llm_usage` (packages/kernel/migrations/llm-usage/0001_llm_usage.sql)
# rows for one workspace and/or time window — the token/cost side of a post-release `--real --runs
# 10` regression. It does NOT know about accept-script scenario labels (docker_restart/api_observe/
# ssh_run_approve/ssh_run_auto/dependency_chat) — those exist only in scripts/accept_s2.sh's/
# accept_s3.sh's own `RUN scenario=<key> ...`/`REAL scenario=<key> ok=<k>/<n> ...` stdout lines, not
# in any database row. The runbook documents how the two are combined by hand into
# docs/private/real-model-<date>.md; this script's job stops at "here is what `llm_usage` says for
# this workspace/window", grouped one of three ways:
#
#   --by turn   (default): group by llm_usage.turn_id — the Activity id a Turn's usage rows share
#                (turn_id is NOT foreign-keyed to activities — see the migration's own header
#                comment on why — but is the same id core/0008_chat_messages.sql's chat_messages.
#                turn_id and activities.id carry).
#   --by handle: group by llm_usage.jti, left-joined to capability_handles on (workspace_id, jti)
#                (governance/0001_capability_handles.sql) for parent_jti/on_behalf_of lineage.
#                capability_handles has no "subject"/"kind" column of its own: on_behalf_of (→
#                principals.id) is the closest analog to a subject, and a session's kind
#                ('entry'/'worker_run'/...) lives on sessions.kind (core/0001_identity.sql), not on
#                capability_handles — this mode does not join sessions, so on_behalf_of is the only
#                identity column surfaced.
#   --by task:   llm_usage.session_id = worker_runs.session_id (task/0001_tasks.sql: a WorkerRun's
#                own session is the one whose usage llm-proxy reports), LEFT JOIN tasks on
#                worker_runs.task_id = tasks.id. This is a real, existing join path — no fallback
#                to Handle lineage (parent_jti) was needed. LEFT JOIN (not INNER): a row whose
#                session_id matches no worker_runs row (the entry agent's own session, which is
#                never itself a Task) still comes back, with task_id/task_status = empty, rather
#                than being silently dropped.
#   --by provider: group by llm_usage.provider, llm_usage.model (S6-B, docs/console-completion-
#                plan.md §5.4 acceptance: "report-usage.sh 里能按 provider / model 汇总") — the
#                per-provider view after a provider was added in the console. `provider` is the
#                proxy route name (the llm-providers.yaml / console store id), `model` the
#                upstream id; no join needed, both are columns of llm_usage.
#
# Usage:
#   sh scripts/report-usage.sh --workspace <uuid> [--since <ISO-8601 UTC>] [--until <ISO-8601 UTC>]
#                               [--by turn|handle|task|provider] [--markdown] [--summary]
#   sh scripts/report-usage.sh --since <ISO-8601 UTC> [--until <ISO-8601 UTC>] ...   # cross-workspace
#
#   --workspace <uuid>   Required unless --since is given (then the report spans every workspace
#                         whose llm_usage rows fall in the window — cross-workspace ops query).
#   --since <ISO-8601>    Optional lower bound on started_at, e.g. 2026-09-17T10:00:00Z.
#   --until <ISO-8601>    Optional (exclusive) upper bound on started_at.
#   --by turn|handle|task|provider  Grouping for the table report. Default: turn. Ignored when --summary is
#                         also given (see below).
#   --markdown            Emit a Markdown table block (or, with --summary, a Markdown-formatted
#                         summary line) ready to paste into docs/private/real-model-<date>.md.
#                         Default output is plain `|`-separated rows, one per line, with a leading
#                         `# `-commented header line.
#   --summary              Short-circuits --by: prints exactly one aggregate line for the whole
#                         workspace/window — calls, input tokens, output tokens, cost_usd, distinct
#                         turns, avg tokens/turn, avg cost/turn — instead of a per-turn/handle/task
#                         table. This is the shape docs/runbooks/host-accept-real-model.md's
#                         post-release routine pastes into the private record.
#
# Provider/model names ARE printed in the data rows themselves (--by turn's providers_models
# column, --by handle's provider/model columns — --by task and --summary omit them, nothing in
# those two modes needs them). That is expected and fine: this script's own STDOUT is meant to be
# pasted straight into docs/private/real-model-<date>.md, which is exactly where the public-repo
# red line says provider/model names, real cost figures, and per-call raw output belong — never
# into a committed file, commit message, or PR body. This script's own comments use
# `<provider/model>` only, per that same red line.
#
# Validation: --workspace must match a uuid shape, --since/--until must match an ISO-8601 UTC
# timestamp shape — checked with `grep -E` BEFORE either value is ever interpolated into a SQL
# string. Nothing else accepts free-form input from the caller.

set -u

WORKSPACE=""
SINCE=""
UNTIL=""
BY="turn"
MARKDOWN=0
SUMMARY=0

usage() {
	cat >&2 <<'EOF'
usage: report-usage.sh --workspace <uuid> [--since <ISO-8601 UTC>] [--until <ISO-8601 UTC>]
                        [--by turn|handle|task|provider] [--markdown] [--summary]
       report-usage.sh --since <ISO-8601 UTC> [--until <ISO-8601 UTC>] [same flags]
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--workspace)
			WORKSPACE="${2:-}"
			shift 2
			;;
		--since)
			SINCE="${2:-}"
			shift 2
			;;
		--until)
			UNTIL="${2:-}"
			shift 2
			;;
		--by)
			BY="${2:-}"
			shift 2
			;;
		--markdown)
			MARKDOWN=1
			shift
			;;
		--summary)
			SUMMARY=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "report-usage: unknown argument: $1" >&2
			usage
			exit 1
			;;
	esac
done

# --------------------------------------------------------------------------------------------
# Validation — every value below is checked against a fixed regex before it is ever interpolated
# into a SQL string (see the WHERE-clause assembly further down). Refuse rather than guess.
# --------------------------------------------------------------------------------------------

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'

if [ -z "$WORKSPACE" ] && [ -z "$SINCE" ]; then
	echo "report-usage: --workspace <uuid> is required unless --since is given" >&2
	usage
	exit 1
fi

if [ -n "$WORKSPACE" ]; then
	if ! printf '%s' "$WORKSPACE" | grep -Eq "$UUID_RE"; then
		echo "report-usage: --workspace does not look like a uuid: $WORKSPACE" >&2
		exit 1
	fi
fi

if [ -n "$SINCE" ]; then
	if ! printf '%s' "$SINCE" | grep -Eq "$TS_RE"; then
		echo "report-usage: --since does not look like an ISO-8601 UTC timestamp (want e.g. 2026-09-17T10:00:00Z): $SINCE" >&2
		exit 1
	fi
fi

if [ -n "$UNTIL" ]; then
	if ! printf '%s' "$UNTIL" | grep -Eq "$TS_RE"; then
		echo "report-usage: --until does not look like an ISO-8601 UTC timestamp (want e.g. 2026-09-17T10:00:00Z): $UNTIL" >&2
		exit 1
	fi
fi

case "$BY" in
	turn | handle | task | provider) ;;
	*)
		echo "report-usage: --by must be one of turn|handle|task|provider, got: $BY" >&2
		exit 1
		;;
esac

# --------------------------------------------------------------------------------------------
# Preflight — same shape as scripts/drill-restore.sh's own checks.
# --------------------------------------------------------------------------------------------

if [ ! -f "./docker-compose.yml" ]; then
	echo "report-usage: run this from the checkout root (where docker-compose.yml lives)" >&2
	exit 1
fi
if [ ! -f "./.env" ]; then
	echo "report-usage: ./.env not found next to docker-compose.yml — see .env.example" >&2
	exit 1
fi

set -a
. ./.env
set +a

running=$(docker compose ps --status running --services 2>/dev/null)
if ! printf '%s\n' "$running" | grep -qx "postgres"; then
	echo "report-usage: postgres not running — run: docker compose up -d postgres" >&2
	exit 1
fi

# --------------------------------------------------------------------------------------------
# WHERE-clause assembly — every value substituted here was already regex-validated above.
# --------------------------------------------------------------------------------------------

WHERE_CLAUSE="1=1"
if [ -n "$WORKSPACE" ]; then
	WHERE_CLAUSE="$WHERE_CLAUSE and l.workspace_id = '$WORKSPACE'"
fi
if [ -n "$SINCE" ]; then
	WHERE_CLAUSE="$WHERE_CLAUSE and l.started_at >= '$SINCE'"
fi
if [ -n "$UNTIL" ]; then
	WHERE_CLAUSE="$WHERE_CLAUSE and l.started_at < '$UNTIL'"
fi

TOTAL_TOKENS_EXPR="(l.input_tokens + l.output_tokens + coalesce(l.cache_read_tokens,0) + coalesce(l.cache_write_tokens,0))"

run_query() {
	# $1 = SQL. -t -A -F '|' (tuples-only, unaligned, pipe-separated) — same flags the task asked
	# for, matching scripts/drill-restore.sh's own psql invocation style. </dev/null: this script
	# may run non-interactively over ssh, same reasoning accept-common.sh's run_driver documents.
	docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 -t -A -F '|' -c "$1" </dev/null
}

# --------------------------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------------------------

# print_table <header|pipe|separated> <data-or-empty>
print_table() {
	header="$1"
	data="$2"
	if [ "$MARKDOWN" -eq 1 ]; then
		md_header=$(printf '%s' "$header" | awk -F'|' '{line="|"; for (i=1;i<=NF;i++) line = line " " $i " |"; print line}')
		md_sep=$(printf '%s' "$header" | awk -F'|' '{line="|"; for (i=1;i<=NF;i++) line = line "---|"; print line}')
		echo "$md_header"
		echo "$md_sep"
		if [ -n "$data" ]; then
			printf '%s\n' "$data" | awk -F'|' '{line="|"; for (i=1;i<=NF;i++) line = line " " $i " |"; print line}'
		fi
	else
		echo "# $header"
		[ -n "$data" ] && printf '%s\n' "$data"
	fi
}

# --------------------------------------------------------------------------------------------
# Summary mode — short-circuits --by (see usage comment above).
# --------------------------------------------------------------------------------------------

if [ "$SUMMARY" -eq 1 ]; then
	sql="select count(*) as calls, coalesce(sum(l.input_tokens),0) as input_tokens, coalesce(sum(l.output_tokens),0) as output_tokens, coalesce(sum(coalesce(l.cache_read_tokens,0)),0) as cache_read_tokens, coalesce(sum(coalesce(l.cache_write_tokens,0)),0) as cache_write_tokens, coalesce(sum($TOTAL_TOKENS_EXPR),0) as total_tokens, coalesce(sum(coalesce(l.cost_usd,0)),0) as cost_usd, count(distinct l.turn_id) as distinct_turns, case when count(distinct l.turn_id) > 0 then round(sum($TOTAL_TOKENS_EXPR)::numeric / count(distinct l.turn_id), 2) else null end as avg_tokens_per_turn, case when count(distinct l.turn_id) > 0 then round(coalesce(sum(l.cost_usd),0)::numeric / count(distinct l.turn_id), 6) else null end as avg_cost_per_turn from llm_usage l where $WHERE_CLAUSE;"

	data=$(run_query "$sql")
	rc=$?
	if [ "$rc" -ne 0 ]; then
		echo "report-usage: summary query failed (exit $rc)" >&2
		exit "$rc"
	fi

	header="calls|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|total_tokens|cost_usd|distinct_turns|avg_tokens_per_turn|avg_cost_per_turn"
	print_table "$header" "$data"
	exit 0
fi

# --------------------------------------------------------------------------------------------
# Grouped table mode
# --------------------------------------------------------------------------------------------

case "$BY" in
	turn)
		header="turn_id|calls|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|total_tokens|cost_usd|first_started_at|last_started_at|providers_models"
		sql="select coalesce(l.turn_id::text, '(none)') as turn_id, count(*) as calls, coalesce(sum(l.input_tokens),0) as input_tokens, coalesce(sum(l.output_tokens),0) as output_tokens, coalesce(sum(coalesce(l.cache_read_tokens,0)),0) as cache_read_tokens, coalesce(sum(coalesce(l.cache_write_tokens,0)),0) as cache_write_tokens, coalesce(sum($TOTAL_TOKENS_EXPR),0) as total_tokens, coalesce(sum(coalesce(l.cost_usd,0)),0) as cost_usd, min(l.started_at) as first_started_at, max(l.started_at) as last_started_at, string_agg(distinct l.provider || '/' || l.model, ',') as providers_models from llm_usage l where $WHERE_CLAUSE group by l.turn_id order by min(l.started_at);"
		;;
	handle)
		header="jti|parent_jti|on_behalf_of|session_id|provider|model|calls|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|total_tokens|cost_usd|first_started_at|last_started_at"
		sql="select l.jti::text as jti, coalesce(ch.parent_jti::text, '(none)') as parent_jti, coalesce(ch.on_behalf_of::text, '(none)') as on_behalf_of, l.session_id::text as session_id, l.provider, l.model, count(*) as calls, coalesce(sum(l.input_tokens),0) as input_tokens, coalesce(sum(l.output_tokens),0) as output_tokens, coalesce(sum(coalesce(l.cache_read_tokens,0)),0) as cache_read_tokens, coalesce(sum(coalesce(l.cache_write_tokens,0)),0) as cache_write_tokens, coalesce(sum($TOTAL_TOKENS_EXPR),0) as total_tokens, coalesce(sum(coalesce(l.cost_usd,0)),0) as cost_usd, min(l.started_at) as first_started_at, max(l.started_at) as last_started_at from llm_usage l left join capability_handles ch on ch.workspace_id = l.workspace_id and ch.jti = l.jti where $WHERE_CLAUSE group by l.jti, ch.parent_jti, ch.on_behalf_of, l.session_id, l.provider, l.model order by min(l.started_at);"
		;;
	task)
		header="task_id|task_status|worker_definition_id|calls|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|total_tokens|cost_usd|first_started_at|last_started_at"
		sql="select coalesce(t.id::text, '(none: no task, e.g. entry-agent session)') as task_id, coalesce(t.status, '(none)') as task_status, coalesce(t.worker_definition_id::text, '(none)') as worker_definition_id, count(*) as calls, coalesce(sum(l.input_tokens),0) as input_tokens, coalesce(sum(l.output_tokens),0) as output_tokens, coalesce(sum(coalesce(l.cache_read_tokens,0)),0) as cache_read_tokens, coalesce(sum(coalesce(l.cache_write_tokens,0)),0) as cache_write_tokens, coalesce(sum($TOTAL_TOKENS_EXPR),0) as total_tokens, coalesce(sum(coalesce(l.cost_usd,0)),0) as cost_usd, min(l.started_at) as first_started_at, max(l.started_at) as last_started_at from llm_usage l left join worker_runs wr on wr.workspace_id = l.workspace_id and wr.session_id = l.session_id left join tasks t on t.workspace_id = wr.workspace_id and t.id = wr.task_id where $WHERE_CLAUSE group by t.id, t.status, t.worker_definition_id order by min(l.started_at);"
		;;
	provider)
		header="provider|model|calls|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|total_tokens|cost_usd|first_started_at|last_started_at"
		sql="select l.provider, l.model, count(*) as calls, coalesce(sum(l.input_tokens),0) as input_tokens, coalesce(sum(l.output_tokens),0) as output_tokens, coalesce(sum(coalesce(l.cache_read_tokens,0)),0) as cache_read_tokens, coalesce(sum(coalesce(l.cache_write_tokens,0)),0) as cache_write_tokens, coalesce(sum($TOTAL_TOKENS_EXPR),0) as total_tokens, coalesce(sum(coalesce(l.cost_usd,0)),0) as cost_usd, min(l.started_at) as first_started_at, max(l.started_at) as last_started_at from llm_usage l where $WHERE_CLAUSE group by l.provider, l.model order by l.provider, l.model;"
		;;
esac

data=$(run_query "$sql")
rc=$?
if [ "$rc" -ne 0 ]; then
	echo "report-usage: --by $BY query failed (exit $rc)" >&2
	exit "$rc"
fi

print_table "$header" "$data"
