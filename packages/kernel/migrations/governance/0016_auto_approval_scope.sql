-- module: governance, version: 0016
--
-- 0016_auto_approval_scope (review 2026-10-02: R-20 / decision D-15, R-21 / decision D-16).
--
-- R-20 / D-15 — "Always allow" is keyed by (gatekeeper, action kind). Until now the approval
-- surfaces' "总是允许" wrote `policies(workspace_id, action_kind)` with `auto_approve = true`: one
-- rule for the bare Operation name, on every gate, for every requester. Operation names collide
-- across gates (two docker gate instances are enough), so approving one lab request auto-approved
-- the same-named Operation on every other gate. The approver only ever saw one gate.
--
--   1. `gatekeeper_policies` holds the gate-scoped rule: the same columns as `policies`, one row
--      per (workspace, gatekeeper, action kind). `set_auto_approved_action_kind` writes only here;
--      `set_policy` writes here when it names a gate. Evaluation reads the gate row first, then the
--      workspace-wide `policies` row, then the compiled-in default
--      (`governance/policy/policies.ts` `readEffectivePolicy`).
--   2. A workspace-wide `policies` row may only narrow from now on: the kernel refuses to write
--      `auto_approve = true` without a gate, and the engine treats a workspace-wide
--      `auto_approve = true` as "no opinion" (`governance/policy/engine.ts`). The table itself is
--      unchanged, so the previous release's code keeps working on it (release.md §6).
--   3. Existing workspace-wide `auto_approve = true` rows are migrated without widening anything.
--      Every "always allow" was ticked on an ActionRequest, so the gates that have ever received a
--      request for the row's action kind are the only candidates for what the approver saw:
--        - exactly one such gate: the rule moves to that gate (the only gate it ever applied to in
--          practice; other gates exposing the same name lose it — narrower, never wider);
--        - zero or several: the gate the approver meant cannot be proven, so the auto-approval is
--          dropped everywhere (a later request asks again, and the new, gate-scoped "Always allow"
--          records the right gate);
--      and in both cases the workspace-wide row stops auto-approving: deleted when auto-approval
--      was all it said, otherwise kept with `auto_approve = false` (its `requester_can_approve`
--      survives; `false` is stricter than the default for a low Operation, never looser). Each
--      migrated row gets one audit record carrying its previous values and the candidate gates.
--
-- R-21 / D-16 — `AgentPolicy.allowMemberAutoApproveLow` becomes an enforced narrowing (the
-- runtime now reads the resolved value; before, it only honoured a principal's own explicit
-- `false`). Its compiled-in default flips to `true` in the same change (store.ts) so a workspace
-- with no AgentPolicy row keeps low-blast-radius auto-approval. Most workspaces do have a row,
-- though — seeded by workspace creation or the platform plane's model settings — carrying the old
-- column default `false` that no owner ever chose. So:
--   4. the column default becomes `true`;
--   5. a row still holding `false` is flipped to `true` only when no `set_agent_policy` call in
--      that workspace ever submitted `allowMemberAutoApproveLow` (the audit log keeps every call's
--      params). Such a `false` was never shown-and-saved by an owner, and `true` is what the
--      runtime did until now. A row whose owner did submit the field keeps its value — under
--      D-16 an owner's `false` now takes effect, which is the point of the change. One audit
--      record per flipped row.
--
-- Reversibility (release.md §6): additive table, a column default, and data changes that only
-- narrow `policies`; the previous release reads and writes `policies` / `agent_policies` with
-- explicit column lists and never sees `gatekeeper_policies`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

create table if not exists gatekeeper_policies (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  gatekeeper_id uuid not null,
  action_kind text not null,
  -- Same meaning as `policies.blast_radius`: the snapshot this row's CHECK below is judged
  -- against (the Operation's own blast radius when "Always allow" wrote it).
  blast_radius text check (blast_radius in ('low', 'medium', 'high')),
  auto_approve boolean not null default false,
  requester_can_approve boolean,
  set_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, gatekeeper_id, action_kind),
  foreign key (workspace_id, gatekeeper_id) references objects (workspace_id, id),
  foreign key (workspace_id, set_by) references principals (workspace_id, id),
  -- I8 / §5.4 "工作区不能关闭", exactly as on `policies` (0002).
  check (blast_radius is distinct from 'high' or auto_approve = false)
);

alter table gatekeeper_policies enable row level security;

drop policy if exists gatekeeper_policies_workspace_isolation on gatekeeper_policies;

create policy gatekeeper_policies_workspace_isolation on gatekeeper_policies
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Same grants as `policies` (0002): a rule is configuration; removing one falls back to the
-- workspace-wide row or the default, and every use is recorded on the ActionRequest itself.
grant select, insert, update, delete on gatekeeper_policies to nexttime_app;

-- 3. Re-scope existing workspace-wide auto-approval rules (see the header). Idempotent: a second
-- run finds no workspace-wide `auto_approve = true` row left.
do $$
declare
  p record;
  candidates uuid[];
  target uuid;
  migrated integer := 0;
begin
  for p in
    select workspace_id, id, action_kind, blast_radius, requester_can_approve, set_by,
           created_at, updated_at
    from policies
    where auto_approve = true
    order by workspace_id, action_kind
  loop
    select coalesce(array_agg(distinct ar.gatekeeper_id order by ar.gatekeeper_id), '{}'::uuid[])
      into candidates
      from action_requests ar
     where ar.workspace_id = p.workspace_id
       and ar.action_kind = p.action_kind;

    target := case when cardinality(candidates) = 1 then candidates[1] end;

    if target is not null then
      insert into gatekeeper_policies (
        workspace_id, gatekeeper_id, action_kind, blast_radius, auto_approve,
        requester_can_approve, set_by, created_at, updated_at
      ) values (
        p.workspace_id, target, p.action_kind, p.blast_radius, true,
        p.requester_can_approve, p.set_by, p.created_at, p.updated_at
      )
      on conflict (workspace_id, gatekeeper_id, action_kind) do nothing;
    end if;

    if p.requester_can_approve is null then
      delete from policies where workspace_id = p.workspace_id and id = p.id;
    else
      update policies
         set auto_approve = false, updated_at = now()
       where workspace_id = p.workspace_id and id = p.id;
    end if;

    insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
    values (
      p.workspace_id,
      p.set_by,
      'policy.auto_approve_rescoped',
      'policy',
      p.id,
      jsonb_build_object(
        'by', 'migration governance/0016_auto_approval_scope',
        'reason', case
          when target is not null then
            'workspace-wide "always allow" moved to the only gate that ever received this action kind (R-20 / D-15)'
          else
            'workspace-wide "always allow" dropped: the gate it was meant for cannot be determined (R-20 / D-15)'
        end,
        'actionKindTag', p.action_kind,
        'gatekeeperId', target,
        'candidateGatekeeperIds', to_jsonb(candidates),
        'workspaceRule', case when p.requester_can_approve is null then 'deleted' else 'auto_approve_cleared' end,
        'previous', jsonb_build_object(
          'blastRadius', p.blast_radius,
          'autoApprove', true,
          'requesterCanApprove', p.requester_can_approve,
          'setBy', p.set_by,
          'updatedAt', p.updated_at
        )
      )
    );
    migrated := migrated + 1;
  end loop;
  raise notice 'governance 0016: re-scoped % workspace-wide auto-approval rule(s)', migrated;
end
$$;

-- 4. New AgentPolicy rows default to allowing low-blast-radius auto-approval (D-16).
alter table agent_policies alter column allow_member_auto_approve_low set default true;

-- 5. Flip the `false` no owner ever chose (see the header). Idempotent: a flipped row no longer
-- matches `= false`.
do $$
declare
  ap record;
  actor uuid;
  flipped integer := 0;
begin
  for ap in
    select workspace_id, updated_by, updated_at
    from agent_policies
    where allow_member_auto_approve_low = false
      and not exists (
        select 1 from audit_records ar
        where ar.workspace_id = agent_policies.workspace_id
          and ar.action = 'set_agent_policy'
          and ar.payload #> '{params,allowMemberAutoApproveLow}' is not null
      )
  loop
    update agent_policies
       set allow_member_auto_approve_low = true
     where workspace_id = ap.workspace_id;

    -- audit_records needs a principal of the same workspace as its actor; the row's own last
    -- writer if any (null when the platform plane wrote it last), else the earliest human owner.
    -- The payload says it was this migration that acted.
    actor := coalesce(
      ap.updated_by,
      (select pr.id from principals pr
        where pr.workspace_id = ap.workspace_id and pr.role = 'owner' and pr.kind = 'human'
        order by pr.created_at, pr.id
        limit 1)
    );
    if actor is not null then
      insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
      values (
        ap.workspace_id,
        actor,
        'agent_policy.auto_approve_low_default_applied',
        'agent_policy',
        ap.workspace_id,
        jsonb_build_object(
          'by', 'migration governance/0016_auto_approval_scope',
          'reason', 'allowMemberAutoApproveLow is now enforced (R-21 / D-16); this row held the old column default false, never submitted by an owner, so it takes the new default true',
          'previous', jsonb_build_object('allowMemberAutoApproveLow', false, 'updatedAt', ap.updated_at)
        )
      );
    end if;
    flipped := flipped + 1;
  end loop;
  raise notice 'governance 0016: applied the new allowMemberAutoApproveLow default to % AgentPolicy row(s)', flipped;
end
$$;
