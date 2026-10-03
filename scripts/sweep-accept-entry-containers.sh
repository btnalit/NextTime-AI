#!/bin/sh
# sweep-accept-entry-containers.sh — idempotent sweep for STATUS.md leftover "验收残留自动清理":
# a stopped `nexttime-entry-<principalId>` resident entry container left behind by an
# accept_s1.sh/accept_s2.sh/accept_s3.sh run from before that trio started reclaiming (not just
# stopping) its own containers at the end of every run, or from a run that crashed before its own
# EXIT trap could reach `resident_reclaim` (e.g. worker-supervisor itself was briefly unreachable).
# POSIX sh, run ON THE HOST from the compose project directory — same conventions as
# scripts/delete-workspaces-matching.sh (this script's own structural template): dry run by
# default, lists every candidate before removing anything, `--yes` required to actually reclaim.
#
# What counts as residue (identified only by markers the acceptance scripts already set — no new
# label or metadata is introduced by this script): a resident entry container
# (`nexttime.role=entry`, worker-supervisor's own ENTRY_ROLE_LABEL — every such container is one
# `GET /residents` already lists) that is
#   (a) NOT currently running — a live container is never a candidate, whatever workspace it
#       belongs to, and
#   (b) labelled with the workspace id (`nexttime.workspace`, WORKSPACE_LABEL) of a Workspace whose
#       NAME matches `^accept-s[1-4]-` — the exact naming convention every accept_s*.sh's own
#       bootstrap_step already uses (`ws_name="accept-s$N-$ts"`). A workspace merely
#       `purpose=ephemeral` is not enough to qualify — scripts/demo.sh's own ephemeral workspaces,
#       or an operator's own `create-workspace --purpose ephemeral`, must never be touched by this
#       script; only the acceptance scripts' own name prefix does.
#
# Usage:
#   sh scripts/sweep-accept-entry-containers.sh          # dry run: lists candidates, removes nothing
#   sh scripts/sweep-accept-entry-containers.sh --yes     # reclaims every candidate listed
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/sweep-accept-entry-containers.sh' </dev/null
#
# Reclaim (`POST /resident/reclaim`) is the exact same worker-supervisor internal-plane call
# accept_s1.sh/accept_s2.sh/accept_s3.sh's own cleanup_step now makes at the end of every run, and
# the same call the kernel's own `purge_workspace` capability already makes automatically for every
# purged Principal (STATUS.md leftover 77, application/gateway/platform-handlers.ts's
# `reclaimEntryContainers`) — force-removes the container and its own
# `${NEXTTIME_DATA}/workspaces/<principalId>` data directory, tolerating "not found" as a no-op.
# It never touches a database row: the Workspace/Principal/Grant/audit rows this script's
# candidates belong to are left exactly as they are — audit-only-increases holds, nothing here
# writes or removes an audit row. Deleting those rows (once a workspace's own 7-day ephemeral TTL
# has passed) is still exactly `sh scripts/delete-workspaces-matching.sh --expired --yes`'s job,
# unchanged by this script and not duplicated here.
#
# Never touches: a running container (whatever its workspace); any container without the entry-role
# label (accept_s2.sh's own accept-s2-sshd/accept-s2-openapi/… fixture/gate containers,
# accept_s3.sh's accept-s3-ephemeral — each already cleaned by its own script's cleanup_step,
# `docker compose rm -sf`, not this one); or any workspace not named `accept-s1-`/`accept-s2-`/
# `accept-s3-`/`accept-s4-*` (a real member's own entry container, or another ephemeral
# workspace such as `make demo`'s, is never a candidate).
#
# accept_s4.sh residue (STATUS.md's other named item, "S4 探针主体") needs no script of its own:
# its per-run ungranted-member probe principal (`s4-ungranted-reader`) is a Workspace-scoped
# `principals` row inside that same run's ephemeral accept-s4-<ts> workspace — accept_s4.sh never
# starts a resident container for it — and is already deleted, Handle revoked first, by the exact
# same governed `sh scripts/delete-workspaces-matching.sh --expired --yes` path once that
# workspace's own 7-day TTL passes (docs/runbooks/host-accept-s4.md §5 已经这样约定).

set -u

YES=0
for arg in "$@"; do
	case "$arg" in
		--yes) YES=1 ;;
		*)
			echo "sweep-accept-entry-containers: unknown argument: $arg" >&2
			echo "sweep-accept-entry-containers: usage: sh scripts/sweep-accept-entry-containers.sh [--yes]" >&2
			exit 1
			;;
	esac
done

if [ ! -f "./docker-compose.yml" ]; then
	echo "sweep-accept-entry-containers: run this from the checkout root (where docker-compose.yml lives)" >&2
	exit 1
fi
if [ ! -f "./.env" ]; then
	echo "sweep-accept-entry-containers: ./.env not found next to docker-compose.yml — see .env.example" >&2
	exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "sweep-accept-entry-containers: .env must set NEXTTIME_DATA" >&2
	exit 1
fi

if ! docker compose config >/dev/null 2>&1; then
	echo "sweep-accept-entry-containers: 'docker compose config' failed — run this from the compose project directory" >&2
	exit 1
fi

# id\tname for every workspace named like an acceptance workspace, whatever its status — a still-
# `active` one is a legitimate candidate too: its entry container may already be idle-stopped by
# the supervisor's own 30-minute sweep, or left stopped by a run that predates the cleanup_step fix,
# long before the workspace's own 7-day TTL is anywhere near up.
WS_OUT=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js list-workspaces </dev/null)
WS_RC=$?
if [ "$WS_RC" -ne 0 ]; then
	echo "sweep-accept-entry-containers: list-workspaces exited $WS_RC" >&2
	echo "$WS_OUT" >&2
	exit "$WS_RC"
fi
WS_MATCHES=$(printf '%s\n' "$WS_OUT" | tail -n +2 | awk -F '\t' '$2 ~ /^accept-s[1-4]-/ { print $1 "\t" $2 }')

if [ -z "$WS_MATCHES" ]; then
	echo "sweep-accept-entry-containers: no accept-s1/s2/s3/s4 workspace found — nothing to sweep"
	exit 0
fi

# GET /residents (worker-supervisor, internal-plane token — same "kernel image's own node -e
# fetch()" pattern accept_s1.sh/accept_s3.sh's own resident_status/resident_stop already use):
# principalId\tworkspaceId\trunning for every resident entry container on this host, whatever
# workspace it belongs to.
RES_OUT=$(docker compose run --rm --no-deps -T kernel node -e "
const token = require('fs').readFileSync('/run/secrets/internal_token_worker_supervisor', 'utf8').trim();
fetch('http://worker-supervisor:8081/residents', { headers: { authorization: 'Bearer ' + token } }).then(async (r) => {
  if (!r.ok) { console.error('STATUS=' + r.status); process.exitCode = 1; return; }
  const j = await r.json();
  for (const it of j.items) {
    console.log([it.principalId, it.workspaceId, it.running ? 'true' : 'false'].join('\t'));
  }
});
" </dev/null)
RES_RC=$?
if [ "$RES_RC" -ne 0 ]; then
	echo "sweep-accept-entry-containers: GET /residents failed:" >&2
	echo "$RES_OUT" >&2
	exit 1
fi

TMP_WS="/tmp/sweep-accept-entry-containers.ws.$$"
TMP_RES="/tmp/sweep-accept-entry-containers.res.$$"
TMP_CANDIDATES="/tmp/sweep-accept-entry-containers.candidates.$$"
trap 'rm -f "$TMP_WS" "$TMP_RES" "$TMP_CANDIDATES"' EXIT
printf '%s\n' "$WS_MATCHES" >"$TMP_WS"
printf '%s\n' "$RES_OUT" >"$TMP_RES"

# Join on workspace id; keep only the not-currently-running ones — see the header comment's "what
# counts as residue" paragraph. NR==FNR reads $TMP_WS (the first file) first.
awk -F '\t' '
	NR == FNR { ws_name[$1] = $2; next }
	($2 in ws_name) && $3 == "false" { print $1 "\t" ws_name[$2] }
' "$TMP_WS" "$TMP_RES" >"$TMP_CANDIDATES"

if [ ! -s "$TMP_CANDIDATES" ]; then
	echo "sweep-accept-entry-containers: no stopped entry container belongs to an accept-s1/s2/s3/s4 workspace — nothing to sweep"
	exit 0
fi

echo "sweep-accept-entry-containers: stopped entry container(s) belonging to accept-s1/s2/s3/s4 workspaces:"
awk -F '\t' '{ printf "  principal=%s  workspace=%s  container=nexttime-entry-%s\n", $1, $2, $1 }' "$TMP_CANDIDATES"
CANDIDATE_COUNT=$(wc -l <"$TMP_CANDIDATES" | tr -d ' ')
echo "sweep-accept-entry-containers: $CANDIDATE_COUNT container(s) matched"

if [ "$YES" -ne 1 ]; then
	echo "sweep-accept-entry-containers: dry run (no --yes) — nothing removed. Re-run with --yes to reclaim the container(s) listed above."
	exit 0
fi

echo ""
echo "sweep-accept-entry-containers: reclaiming $CANDIDATE_COUNT container(s) ..."
TAB=$(printf '\t')
FAILED=0
RECLAIMED=0
while IFS="$TAB" read -r pid wname; do
	out=$(docker compose run --rm --no-deps -T kernel node -e "
const token = require('fs').readFileSync('/run/secrets/internal_token_worker_supervisor', 'utf8').trim();
fetch('http://worker-supervisor:8081/resident/reclaim', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ principalId: '$pid' }),
}).then((r) => console.log('STATUS=' + r.status));
" </dev/null 2>&1)
	status=$(printf '%s\n' "$out" | sed -n 's/^STATUS=//p' | tail -n 1)
	if [ "$status" = "204" ]; then
		echo "sweep-accept-entry-containers: reclaimed principal=$pid workspace=$wname"
		RECLAIMED=$((RECLAIMED + 1))
	else
		echo "sweep-accept-entry-containers: failed to reclaim principal=$pid workspace=$wname: $out" >&2
		FAILED=1
	fi
done <"$TMP_CANDIDATES"

echo ""
if [ "$FAILED" -ne 0 ]; then
	echo "sweep-accept-entry-containers: $RECLAIMED/$CANDIDATE_COUNT container(s) reclaimed — one or more reclaims failed, see above" >&2
	exit 1
fi

echo "sweep-accept-entry-containers: done — $RECLAIMED container(s) reclaimed"
