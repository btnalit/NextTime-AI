-- module: governance, version: 0021
--
-- 0021_action_request_withdraw_failure_kind (S11 GO1:
-- docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.3 I-G9, §4.7).
--
--   1. `withdrawn`: a request that had not started executing, taken back because the step it
--      belongs to was cancelled or revised away (I-G9). Legal only from `pending_approval`,
--      `approved` and `auto_approved` (packages/shared transitions.ts `ACTION_REQUEST_EDGES`), and
--      terminal. The status CHECK is recreated with it, and `action_requests_status_guard` refuses
--      any other way in or out: nothing that started executing is ever withdrawn, and a withdrawn
--      row never starts. The rest of the graph stays enforced in code (the transition table under
--      the row lock and a conditional UPDATE) and checked after the fact by I6.
--   2. `failure_kind`: why a `failed` row failed, as a column whatever acts on a failure can split
--      on (it used to be only the reason prefix in the `action_request.fail` audit payload):
--      `not_delivered` (the request never reached the gate — nothing ran), `refused` (the platform
--      or the gate said no, or the gate's target answered with a failure), `outcome_unknown` (it may
--      have run). Set exactly when the row is `failed` or `compensated`. Existing rows are read
--      from their last recorded reason by a whitelist (below): only a reason whose code says for
--      certain nothing ran is `not_delivered` or `refused`; every other row is `outcome_unknown`,
--      since nothing says it did not run.
--
-- Reversibility (release.md §6): the previous release reads and writes `action_requests` with an
-- explicit column list and never sees `failure_kind`; it never writes `withdrawn`. A `failed` row it
-- writes after a rollback names no kind, and the guard trigger records `outcome_unknown` — the
-- reading that never invites a second run. A `withdrawn` row left from this release is terminal to
-- the previous one too: its drain and expiry only pick `auto_approved` / `approved` /
-- `pending_approval` / `executing` rows, by name.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

-- 1. `withdrawn` joins the status CHECK (0003 named it inline: `action_requests_status_check`).
alter table action_requests drop constraint if exists action_requests_status_check;
alter table action_requests add constraint action_requests_status_check
  check (status in ('proposed', 'policy_evaluated', 'auto_approved', 'pending_approval', 'approved', 'rejected', 'expired', 'denied', 'executing', 'executed', 'failed', 'verified', 'compensated', 'withdrawn'));

-- 2. The failure kind. Values from packages/shared enums.ts `ACTION_REQUEST_FAILURE_KIND_VALUES`.
alter table action_requests add column if not exists failure_kind text;
alter table action_requests drop constraint if exists action_requests_failure_kind_check;
alter table action_requests add constraint action_requests_failure_kind_check
  check (failure_kind in ('not_delivered', 'refused', 'outcome_unknown'));

-- The guard (both parts above). A writer that names no failure kind — code from before this
-- column — gets `outcome_unknown`; `withdrawn` is reachable only from the three not-yet-executing
-- states and is terminal.
create or replace function action_requests_status_guard() returns trigger
language plpgsql as $$
begin
  if new.status in ('failed', 'compensated') and new.failure_kind is null then
    new.failure_kind := 'outcome_unknown';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'withdrawn' then
      raise exception 'action_requests: a request is never created withdrawn (I-G9)';
    end if;
  elsif new.status is distinct from old.status then
    if old.status = 'withdrawn' then
      raise exception 'action_requests: a withdrawn request is terminal (I-G9)';
    end if;
    if new.status = 'withdrawn'
       and old.status not in ('pending_approval', 'approved', 'auto_approved') then
      raise exception
        'action_requests: only a request that has not started executing can be withdrawn, not one that is % (I-G9)',
        old.status;
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger action_requests_status_guard
  before insert or update on action_requests
  for each row execute function action_requests_status_guard();

-- Existing failed / compensated rows: the kind their last `action_request.fail` reason says for
-- certain, else `outcome_unknown` (review of #601, M1). The codes are packages/shared
-- action-failure-reason.ts's two lists (`action-executor.test.ts` holds them equal); any other
-- reason — no code, `outcome unknown: …` with a space (v0.35), a bare timeout, `network_error`,
-- `response_too_large`, `invalid_response`, `internal_error`, `unrecognized_gate_error`, and
-- `transport_error` from gates before legacy 287 — is a call that may have run.
--
-- A reason only speaks for the call that wrote it. The stale-`executing` reaper ends a row long
-- after its first call, by asking again: up to v0.35 through `execute` itself, so with the platform's
-- own pre-checks (`operation_disabled`, an unregistered gatekeeper) and the gate's refusals of a
-- second call, whatever the first did. So a refusal or a not-sent code counts only for a row no
-- replay touched (`replay_attempts`, since governance/0013) that failed within two minutes of
-- starting to execute — longer than one call's timeout, shorter than any stale threshold (default
-- ten minutes). A row with no `executing_at` started before governance/0006 brought the reaper,
-- which never picks such a row, so its reason is its first call's. The exception is
-- `apply_not_received`: the gate's own answer about the call's key — nothing ran under it, and it
-- is closed.
--
-- One pass over the audit trail (no index on its resource), then idempotent: only rows without a
-- kind are touched.
with fail as materialized (
  select distinct on (workspace_id, resource_id)
         workspace_id, resource_id, payload ->> 'reason' as reason
    from audit_records
   where action = 'action_request.fail'
     and resource_type = 'action_request'
   order by workspace_id, resource_id, created_at desc
)
update action_requests ar
   set failure_kind = case
     when f.reason is null then 'outcome_unknown'
     when f.reason ~ '^apply_not_received:' then 'not_delivered'
     when target.replay_attempts > 0
       or (target.executing_at is not null
           and (target.failed_at is null
                or target.failed_at >= target.executing_at + interval '2 minutes')) then 'outcome_unknown'
     when f.reason ~ '^(gate_unreachable|gate_token_unavailable|connection_secret_missing|gate_not_found|apply_not_received):' then 'not_delivered'
     when f.reason ~ '^(operation_disabled|operation_definition_unavailable|target_refused|redirect_refused|unauthorized|operation_not_found|invalid_params|invalid_operation_schema|operation_definition_mismatch|operation_refused|credential_unavailable):' then 'refused'
     when f.reason ~ '^gatekeeper "[^"]*" is not registered$' then 'refused'
     else 'outcome_unknown'
   end
  from action_requests target
  left join fail f
    on f.workspace_id = target.workspace_id and f.resource_id = target.id
 where ar.workspace_id = target.workspace_id
   and ar.id = target.id
   and target.status in ('failed', 'compensated')
   and target.failure_kind is null;

alter table action_requests drop constraint if exists action_requests_failure_kind_status;
alter table action_requests add constraint action_requests_failure_kind_status
  check ((status in ('failed', 'compensated')) = (failure_kind is not null));
