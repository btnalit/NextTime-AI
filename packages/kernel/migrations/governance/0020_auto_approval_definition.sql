-- module: governance, version: 0020
--
-- 0020_auto_approval_definition (legacy 218: "always allow" outlived the definition it allowed).
--
-- A gate-scoped auto-approval rule (`gatekeeper_policies.auto_approve = true`, written by "Always
-- allow" or by `set_policy` with a gate) is keyed by (gatekeeper, action kind) only. The person
-- who ticked it was looking at one definition of that Operation. When a revision with another
-- definition was published later, the rule kept auto-approving it: the new definition never went
-- past a person.
--
--   1. `operation_digest` records the definition the rule allows: the same digest a gate checks on
--      every call (@nexttime/gatekeeper-base operation-digest.ts), which an ActionRequest already
--      records (0019). `operation_version` records the published version it was, for display.
--      The kernel writes both whenever a gate-scoped rule turns auto-approval on, and the engine
--      honours `auto_approve = true` only while the request's digest is this one
--      (`governance/policy/policies.ts`). A rule that names no definition never auto-approves; it
--      is shown as suspended until a person allows the current definition again.
--   2. Existing gate-scoped auto-approval rules are bound from evidence, never wider. "Always
--      allow" is ticked on an ActionRequest, right after approving it: the definition the person
--      saw is that request's `operation_digest`. So a rule takes the digest of the latest request
--      for its gate and action kind that its own writer approved at or before the rule was last
--      written. No such request, or one made before 0019 (no digest), binds nothing and the rule
--      is suspended: the definition it was meant for cannot be proven. One audit record per rule
--      says which.
--
-- Reversibility (release.md §6): two nullable columns and data in them only. The previous release
-- reads and writes `gatekeeper_policies` with explicit column lists and never sees them; a rule it
-- writes after a rollback names no definition, which this release suspends (narrower, never
-- wider) until it is allowed again.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table gatekeeper_policies add column if not exists operation_digest text
  constraint gatekeeper_policies_operation_digest_shape
  check (operation_digest is null or operation_digest ~ '^sha256:[0-9a-f]{64}$');

alter table gatekeeper_policies add column if not exists operation_version integer
  constraint gatekeeper_policies_operation_version_positive
  check (operation_version is null or operation_version > 0);

-- 2. Bind the existing rules (see the header). Idempotent: a bound rule no longer matches, and an
-- unbound one is only audited once (`policy.auto_approve_definition_unproven` already on file).
do $$
declare
  gp record;
  evidence text;
  bound integer := 0;
  suspended integer := 0;
begin
  for gp in
    select workspace_id, id, gatekeeper_id, action_kind, set_by, updated_at
    from gatekeeper_policies
    where auto_approve = true
      and operation_digest is null
    order by workspace_id, gatekeeper_id, action_kind
  loop
    select ar.operation_digest
      into evidence
      from action_requests ar
      join decisions d
        on d.workspace_id = ar.workspace_id and d.id = ar.approval_decision_id
     where ar.workspace_id = gp.workspace_id
       and ar.gatekeeper_id = gp.gatekeeper_id
       and ar.action_kind = gp.action_kind
       and d.decided_by = gp.set_by
       and d.decided_at <= gp.updated_at
     order by d.decided_at desc
     limit 1;

    if evidence ~ '^sha256:[0-9a-f]{64}$' then
      update gatekeeper_policies
         set operation_digest = evidence
       where workspace_id = gp.workspace_id and id = gp.id;
      insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
      values (
        gp.workspace_id,
        gp.set_by,
        'policy.auto_approve_definition_bound',
        'policy',
        gp.id,
        jsonb_build_object(
          'by', 'migration governance/0020_auto_approval_definition',
          'reason', '"always allow" now names the definition it allows (legacy 218): the one its writer last approved on this gate before writing it',
          'gatekeeperId', gp.gatekeeper_id,
          'actionKindTag', gp.action_kind,
          'operationDigest', evidence
        )
      );
      bound := bound + 1;
    elsif not exists (
      select 1 from audit_records a
       where a.workspace_id = gp.workspace_id
         and a.action = 'policy.auto_approve_definition_unproven'
         and a.resource_id = gp.id
    ) then
      insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
      values (
        gp.workspace_id,
        gp.set_by,
        'policy.auto_approve_definition_unproven',
        'policy',
        gp.id,
        jsonb_build_object(
          'by', 'migration governance/0020_auto_approval_definition',
          'reason', '"always allow" suspended until allowed again (legacy 218): no approved request records which definition it was given for',
          'gatekeeperId', gp.gatekeeper_id,
          'actionKindTag', gp.action_kind
        )
      );
      suspended := suspended + 1;
    end if;
  end loop;
  raise notice 'governance 0020: bound % auto-approval rule(s) to the definition approved, suspended %', bound, suspended;
end
$$;
