#!/bin/sh
# check-membership-capabilities-not-in-handle-scope: S3.11's own CI-guard requirement
# (docs/development-tasks.md "中台控制面" — "no capability in the members/governance-management
# set may appear in ENTRY_CEILING_*, WORKER_* capability name sets, or any Handle scope default").
#
# The checked set is every capability packages/shared/src/capabilities.ts registers under the new
# `members` group, plus this task's three governance-group read additions
# (list_grants/list_policies/list_quotas) and three connection-group read additions
# (list_gatekeepers/get_gatekeeper/list_operations) — all `channel: 'human'` by construction
# (`governance/capability/handles.ts`'s own `assertValidScope` already refuses any `channel:
# 'human'` capability in a Handle scope at issuance time; this is the second, independent,
# static check the task's own dispatch asks for, so a future edit to that runtime check — or to
# handles.ts's ceiling-building arrays — cannot silently regress this invariant unnoticed).
#
# `governance/capability/handles.ts` is where every Handle-scope ceiling is built
# (ENTRY_CEILING_CAPABILITIES / WORKER_CEILING_CAPABILITIES / WORKER_INFRASTRUCTURE_CAPABILITY_NAMES
# — every Handle any session ever holds is a subset of one of these two ceilings, by construction
# of `attenuate`/`computeChildHandleScope`, so grepping this one file for a literal hit covers
# "any Handle scope default" too, not just the two named ceiling arrays). A hit here means one of
# these names was added to a ceiling-building array (or otherwise appears as a quoted string in
# this file) — always wrong: these capabilities manage who/what may act on the workspace at all
# and must remain human-channel-only forever (packages/shared/src/capabilities.ts's own
# HUMAN_ONLY_CAPABILITY_NAMES set is the first, registry-level layer of the same rule).
#
# Run directly, via `pnpm ci:guards` (root package.json), `make ci`, or the CI `guards` job
# (.github/workflows/ci.yml).
set -eu

HANDLES_FILE="packages/kernel/src/governance/capability/handles.ts"

if [ ! -f "$HANDLES_FILE" ]; then
  echo "check-membership-capabilities-not-in-handle-scope: $HANDLES_FILE not found" >&2
  exit 1
fi

NAMES="list_principals create_principal set_principal_role rotate_api_key disable_principal get_workspace list_models list_grants list_policies list_quotas list_gatekeepers get_gatekeeper list_operations get_agent_profile set_agent_profile get_agent_policy set_agent_policy platform_overview list_users create_user update_user set_user_status reset_user_password list_user_memberships add_membership set_membership_role remove_membership merge_user set_user_budget get_platform_settings update_platform_settings platform_audit_query"

FOUND=0
for name in $NAMES; do
  if grep -nE "['\"]${name}['\"]" "$HANDLES_FILE" >/dev/null 2>&1; then
    echo "check-membership-capabilities-not-in-handle-scope: \"$name\" (members/governance-management) found in $HANDLES_FILE — it must never appear in a Handle-scope ceiling:" >&2
    grep -nE "['\"]${name}['\"]" "$HANDLES_FILE" >&2
    FOUND=1
  fi
done

if [ "$FOUND" -ne 0 ]; then
  exit 1
fi

exit 0
