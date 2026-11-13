-- module: core, version: 0057
--
-- Legacy 701: a gate a workspace connected itself (`create_connection`) can move to a new address
-- without being connected again. Before this, the only way from `http://` to `https://`, or to a
-- new host, was a second connection: its Operations imported and published again, and every Goal,
-- Procedure, Grant and auto-approval that named the old Gatekeeper changed by hand. Every one of
-- those names the Gatekeeper by id, never by address, so changing the address in place keeps all
-- of them — and that is exactly the risk: whatever the workspace trusted "this gate" with follows
-- it to the new host. So a change is a first-class proposal, not an edit
-- (`application/gateway/gate-address-change-handlers.ts` has the flow and why):
--
--   proposed ──approve (platform administrator)──▶ applied
--      │  └──reject (platform administrator)──▶ rejected
--      ├──withdraw (a workspace owner)──▶ withdrawn
--      └──past expires_at (lazily, on the next propose or approve)──▶ expired
--
-- Every state but `proposed` is final. `applied` moves the Gatekeeper Object's `endpoint` and
-- `connectionSecretSalt`, and the `workspace_self_connections` row's `endpoint` / `endpoint_key`, in
-- the platform transaction that marks it — never this table's trigger, so nothing here writes
-- another table.
--
-- `new_salt` is the salt of the connection secret the owner minted for the new host
-- (`mint_connection_secret`; the secret carries it, `saltOf` checks it was minted for this
-- workspace) — never the secret. It is unique per workspace whatever the status: a secret serves
-- one proposal, and after that proposal ends it is used up (a withdrawn or rejected proposal's
-- secret only ever sat in the new host's configuration; the kernel never derives it again).
-- `manifest_digest` is the new host's own description of its Operations as previewed; the approval
-- reads the new host again and requires the same one. `preview_digest` binds the proposal to the
-- preview its owner saw, and the approval to the proposal its administrator saw; `impact` keeps
-- what that preview showed would follow the gate (published Operations, Grants, auto-approvals,
-- WorkerDefinitions, requests in flight), since the platform cannot read the workspace's own.
--
-- Who may write what (RLS, forced):
--   - a workspace transaction reads its own rows, inserts a `proposed` one for one of its own self
--     connections (I-A5: a catalog gate's address is the platform instance's), and moves its own
--     `proposed` row to `withdrawn`, or to `expired` once `expires_at` has passed;
--   - only a platform transaction moves one to `applied` or `rejected` (the administrator's
--     decision, `decided_by_user_id`), or `expired`.
-- The trigger keeps the rest: the proposal's own fields never change, a final state never changes,
-- `applied` only before `expires_at`, `expired` only after it. No delete grant: the workspace purge
-- runs on the superuser login role and is unaffected.
--
-- Pure addition: code without this migration never reads or writes the table. Rolling back:
-- `drop table gate_address_changes`, `drop function gate_address_changes_guard()`, then
-- `delete from schema_migrations where module = 'core' and version = 57`.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

create table if not exists gate_address_changes (
  workspace_id uuid not null references workspaces (id),
  id uuid not null default gen_random_uuid(),
  gatekeeper_object_id uuid not null,
  from_endpoint text not null,
  to_endpoint text not null,
  -- `to_endpoint` in the kernel's one gate-address spelling (`normalizeGateEndpoint`), what
  -- `workspace_self_connections.endpoint_key` becomes when the change is applied.
  to_endpoint_key text not null,
  new_salt text not null,
  manifest_digest text not null,
  preview_digest text not null,
  -- What follows the gate to the new host, as its owner previewed it (`@nexttime/shared`
  -- `GateAddressChangeImpactWireSchema`): the administrator decides on the same picture.
  impact jsonb not null check (jsonb_typeof(impact) = 'object'),
  status text not null default 'proposed'
    check (status in ('proposed', 'applied', 'rejected', 'withdrawn', 'expired')),
  proposed_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  decided_at timestamptz,
  -- The platform user who approved or rejected it (`users.id`); no foreign key, so purging a user
  -- later is not blocked — the decision's audit row is the durable record.
  decided_by_user_id uuid,
  -- The owner who withdrew it.
  withdrawn_by uuid,
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 500),
  primary key (workspace_id, id),
  foreign key (workspace_id, gatekeeper_object_id) references objects (workspace_id, id),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, withdrawn_by) references principals (workspace_id, id),
  check (length(to_endpoint_key) > 0 and length(new_salt) > 0),
  check (expires_at > created_at),
  check ((status = 'proposed') = (decided_at is null)),
  check ((status in ('applied', 'rejected')) = (decided_by_user_id is not null)),
  check ((status = 'withdrawn') = (withdrawn_by is not null)),
  check (status = 'rejected' or rejection_reason is null)
);

-- A secret serves one proposal, whatever became of it.
create unique index if not exists gate_address_changes_new_salt_uniq
  on gate_address_changes (workspace_id, new_salt);
-- I-A2: at most one open proposal per gate.
create unique index if not exists gate_address_changes_one_open_uniq
  on gate_address_changes (workspace_id, gatekeeper_object_id) where status = 'proposed';
create index if not exists gate_address_changes_open_idx
  on gate_address_changes (created_at) where status = 'proposed';

create or replace function gate_address_changes_guard() returns trigger
  language plpgsql
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.id is distinct from old.id
     or new.gatekeeper_object_id is distinct from old.gatekeeper_object_id
     or new.from_endpoint is distinct from old.from_endpoint
     or new.to_endpoint is distinct from old.to_endpoint
     or new.to_endpoint_key is distinct from old.to_endpoint_key
     or new.new_salt is distinct from old.new_salt
     or new.manifest_digest is distinct from old.manifest_digest
     or new.preview_digest is distinct from old.preview_digest
     or new.impact is distinct from old.impact
     or new.proposed_by is distinct from old.proposed_by
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'gate_address_changes: a proposal''s own fields never change (legacy 701)';
  end if;
  if old.status <> 'proposed' then
    raise exception 'gate_address_changes: proposal % is %, a final state (legacy 701)', old.id, old.status;
  end if;
  if new.status = 'proposed' then
    raise exception 'gate_address_changes: an update decides proposal % (legacy 701)', old.id;
  end if;
  if new.status = 'applied' and now() >= old.expires_at then
    raise exception 'gate_address_changes: proposal % expired at % and cannot be applied (legacy 701)',
      old.id, old.expires_at;
  end if;
  if new.status = 'expired' and now() < old.expires_at then
    raise exception 'gate_address_changes: proposal % does not expire until % (legacy 701)',
      old.id, old.expires_at;
  end if;
  return new;
end;
$$;

drop trigger if exists gate_address_changes_guard on gate_address_changes;
create trigger gate_address_changes_guard
  before update on gate_address_changes
  for each row execute function gate_address_changes_guard();

alter table gate_address_changes enable row level security;
alter table gate_address_changes force row level security;

drop policy if exists gate_address_changes_workspace_read on gate_address_changes;
create policy gate_address_changes_workspace_read on gate_address_changes
  for select using (workspace_id = app_workspace());
drop policy if exists gate_address_changes_workspace_insert on gate_address_changes;
create policy gate_address_changes_workspace_insert on gate_address_changes
  for insert with check (
    workspace_id = app_workspace()
    and status = 'proposed'
    and decided_at is null and decided_by_user_id is null and withdrawn_by is null
    and rejection_reason is null
    and exists (
      select 1 from workspace_self_connections s
       where s.workspace_id = gate_address_changes.workspace_id
         and s.gatekeeper_object_id = gate_address_changes.gatekeeper_object_id
    )
  );
drop policy if exists gate_address_changes_workspace_update on gate_address_changes;
create policy gate_address_changes_workspace_update on gate_address_changes
  for update
  using (workspace_id = app_workspace() and status = 'proposed')
  with check (
    workspace_id = app_workspace()
    and status in ('withdrawn', 'expired')
    and decided_by_user_id is null
  );
drop policy if exists gate_address_changes_platform_admin on gate_address_changes;
create policy gate_address_changes_platform_admin on gate_address_changes
  for all using (app_platform()) with check (app_platform());

grant select, insert, update on gate_address_changes to nexttime_app;
