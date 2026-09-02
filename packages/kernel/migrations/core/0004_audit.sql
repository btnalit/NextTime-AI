-- module: core, version: 0004
--
-- audit_records (§5.1.4, §5.4 I11, §7.1): append-only record of every governed transition.
-- Written in the same transaction as the write it audits (I11) — that discipline lives in the
-- application write paths (S1.3 onward), not in this migration. What the migration guarantees
-- is that once written, a row cannot be changed or removed by anyone, including the table
-- owner: `nexttime_app` gets INSERT + SELECT only (no UPDATE/DELETE grant), and the trigger
-- below raises on UPDATE/DELETE unconditionally — triggers fire regardless of role or
-- ownership, so this holds even for the superuser login role migrations run as.
create table audit_records (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  actor_principal_id uuid not null,
  action text not null,
  resource_type text,
  resource_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, actor_principal_id) references principals (workspace_id, id)
);

alter table audit_records enable row level security;

create policy audit_records_workspace_isolation on audit_records
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert on audit_records to nexttime_app;

create function audit_records_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_records is append-only: % is not permitted (I11)', tg_op;
end;
$$;

create trigger audit_records_no_update
  before update on audit_records
  for each row execute function audit_records_block_mutation();

create trigger audit_records_no_delete
  before delete on audit_records
  for each row execute function audit_records_block_mutation();
