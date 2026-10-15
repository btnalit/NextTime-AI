#!/bin/sh
# check-caddy-log-redaction.sh — does any credential a client sends reach caddy's logs? (legacy
# 236, #549 security review C1). Caddy's JSON log entries carry the request's headers and its URI;
# out of the box only Authorization / Cookie / Set-Cookie / Proxy-Authorization are masked, so an
# `X-API-Key` or a `?token=` was written as sent, and the docker gate's `container.logs_tail` can
# read platform containers' logs. deploy/caddy/Caddyfile now drops request headers and masks query
# values in both the access log and caddy's default (error) log; this script proves it on a
# running stack.
#
# Usage (from the checkout root, against a stack that is up):
#   sh scripts/check-caddy-log-redaction.sh [base-url]          (default https://127.0.0.1:8443)
# Environment:
#   COMPOSE                 the compose command whose `logs caddy` is read (default
#                           `docker compose`; CI passes its `sudo docker compose -f … -f …`)
#   FORBIDDEN_VALUES_FILE   optional file, one value per line, that must not appear in the logs
#                           either (e.g. the run's own owner API key) — a file, so no real value
#                           is ever on a command line; a file without a single value fails the
#                           check (whatever was meant to fill it did not)
#   LOGS_SINCE              optional: read only caddy's log lines since this time (RFC 3339, as
#                           `docker compose logs --since` takes it); default: the container's whole
#                           log
#   EXPECT_ERROR_ENTRY      1 = also require at least one caddy error entry for the probes (CI,
#                           where llm-proxy is not running and /api/llm-admin/* answers 502)
#
# Sends a synthetic Handle-shaped value, unique per run, in every credential-bearing place a
# client can put one (X-API-Key, Authorization, Proxy-Authorization, Cookie, query parameters),
# then reads caddy's logs. Prints counts only, never a log line or a value.
#   PASS/FAIL logged      the probe requests are in the access log (else the check is vacuous)
#   PASS/FAIL probe       the synthetic value appears nowhere in caddy's output
#   PASS/FAIL headers     no entry carries a request header map with X-Api-Key in it
#   PASS/FAIL forbidden   the file holds at least one value and none of them appears (when given)
#   PASS/FAIL error-entry an error entry was written and is redacted too (EXPECT_ERROR_ENTRY=1)
# Exit 0 only when every check passes. Read-only apart from the probe requests themselves, which
# all fail authentication or answer 404/502.

set -u

BASE=${1:-https://127.0.0.1:8443}
COMPOSE=${COMPOSE:-docker compose}
failed=0
pass() { echo "PASS $1 $2"; }
fail() { echo "FAIL $1 $2"; failed=1; }

# Three base64url segments like a Handle (a signed JWT), the last one random: never a credential.
nonce=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
probe="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzeW50aGV0aWMiOnRydWV9.caddyprobe${nonce}"

probe_request() {
	curl -gsk -o /dev/null --max-time 10 "$@" \
		-H "X-API-Key: $probe" \
		-H "Authorization: Bearer $probe" \
		-H "Proxy-Authorization: Bearer $probe" \
		-H "Cookie: nexttime_console_session=$probe; nexttime_workspace=$probe" || true
}
probe_request "$BASE/api/health?caddyprobe=1&token=$probe&format=json"
probe_request "$BASE/api/graph/nodes?access_token=$probe"
probe_request "$BASE/mcp?sig=$probe"
probe_request -H 'X-Requested-With: nexttime' "$BASE/api/llm-admin/providers?key=$probe"
sleep 2

logs=$(mktemp) || { echo "FAIL setup mktemp"; exit 1; }
trap 'rm -f "$logs"' EXIT
# shellcheck disable=SC2086 # COMPOSE is a command line on purpose
if ! $COMPOSE logs --no-color ${LOGS_SINCE:+--since "$LOGS_SINCE"} caddy >"$logs" 2>&1 </dev/null; then
	echo "FAIL setup could not read caddy's logs with: $COMPOSE logs caddy"
	exit 1
fi

logged=$(grep -c 'caddyprobe=REDACTED&token=REDACTED&format=REDACTED' "$logs")
[ "$logged" -ge 1 ] && pass logged "access-log-entries=$logged" ||
	fail logged "the probe request is not in caddy's access log (or its query was not masked) — nothing below would mean anything"

leaks=$(grep -cF "caddyprobe$nonce" "$logs")
[ "$leaks" -eq 0 ] && pass probe "lines-with-the-synthetic-value=0" ||
	fail probe "lines-with-the-synthetic-value=$leaks"

headers=$(grep -ciE '"x-api-key":\[' "$logs")
[ "$headers" -eq 0 ] && pass headers "entries-with-an-X-Api-Key-header=0" ||
	fail headers "entries-with-an-X-Api-Key-header=$headers"

if [ -n "${FORBIDDEN_VALUES_FILE:-}" ]; then
	n=0
	hits=0
	if [ -r "$FORBIDDEN_VALUES_FILE" ]; then
		while IFS= read -r value || [ -n "$value" ]; do
			[ -n "$value" ] || continue
			n=$((n + 1))
			grep -qF -- "$value" "$logs" && hits=$((hits + 1))
		done <"$FORBIDDEN_VALUES_FILE"
	fi
	if [ "$n" -eq 0 ]; then
		fail forbidden "values=0 — FORBIDDEN_VALUES_FILE is missing or holds no value, so nothing was checked"
	elif [ "$hits" -eq 0 ]; then
		pass forbidden "values=$n found=0"
	else
		fail forbidden "values=$n found=$hits"
	fi
fi

if [ "${EXPECT_ERROR_ENTRY:-0}" = 1 ]; then
	errors=$(grep '"logger":"http.log.error' "$logs" | grep -c 'key=REDACTED')
	[ "$errors" -ge 1 ] && pass error-entry "redacted-error-entries=$errors" ||
		fail error-entry "no caddy error entry for the /api/llm-admin probe — the default-log redaction went untested"
fi

exit "$failed"
