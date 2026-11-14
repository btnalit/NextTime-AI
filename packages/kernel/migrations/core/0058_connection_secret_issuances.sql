-- module: core, version: 0058
--
-- Legacy 711: a connection secret serves one binding. A self-connected gate's secret
-- (`adapters/gatekeeper-client/connection-secret.ts`) is re-derivable from `gate_token` and a salt
-- the secret carries, so the kernel verifies one (`saltOf`) without storing it — and before this,
-- without remembering that it ever issued it. `saltOf` proves a secret was minted here for this
-- workspace; it cannot prove the salt is fresh. So while `gate_token` stayed the same, a secret
-- rotated away from a gate (perhaps because it leaked) could be bound again: `create_connection`
-- or `propose_gate_address_change` only asked whether a Gatekeeper holds the salt *now*, or a
-- proposal ever named it. And that check was a read before the write, so two calls presenting the
-- same secret at once could both pass it.
--
-- This table is the ledger of the salts issued since: one row per salt, never the secret.
--
--   mint_connection_secret ──▶ issued (consumed_at null), usable until expires_at (24 hours)
--      ├──create_connection / propose_gate_address_change, before expires_at──▶ consumed
--      └──past expires_at──▶ unusable; deleted by the workspace's next mint
--   rotate_connection_secret ──▶ consumed at once (its salt goes straight onto the gate)
--
-- Consuming is one conditional update (`consumed_at is null and expires_at > now()`), so of two
-- calls presenting the same secret exactly one gets the row; the other, waiting on its row lock,
-- finds it consumed. The update runs in the binding call's transaction: when that call fails after
-- it (the gate does not answer, the credential POST fails), the consumption rolls back with
-- everything else and the secret is usable again. A salt with no row — minted before this
-- migration, or expired and deleted — is refused too: a secret minted and not yet used when the
-- platform upgrades must be minted again (release.md).
--
-- Who may write what (RLS, forced; workspace transactions only — nothing on the platform plane
-- issues or binds a connection secret): a workspace reads its own rows, inserts its own, consumes
-- its own unconsumed rows before they expire, and deletes its own rows that expired unconsumed.
-- The trigger keeps the rest: a row is never issued in the future (so its 24 hours count from no
-- later than the write), the row's own fields never change, a consumed row never changes, and a
-- row is consumed only before `expires_at`. The workspace purge runs on the superuser login role
-- and is unaffected.
--
-- Pure addition: code without this migration never reads or writes the table. Rolling back:
-- `drop table connection_secret_issuances`, `drop function connection_secret_issuances_guard()`,
-- then `delete from schema_migrations where module = 'core' and version = 58`.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

create table if not exists connection_secret_issuances (
  workspace_id uuid not null references workspaces (id),
  -- The salt the secret carries (`newConnectionSecretSalt`: 16 random bytes, hex) — not secret.
  salt text not null check (salt ~ '^[0-9a-f]{32}$'),
  issued_via text not null
    check (issued_via in ('mint_connection_secret', 'rotate_connection_secret')),
  issued_by uuid not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  consumed_at timestamptz,
  -- The capability that bound it: a new connection, a proposal to move a gate, or the rotation that
  -- issued it.
  consumed_by text
    check (consumed_by in (
      'create_connection', 'propose_gate_address_change', 'rotate_connection_secret'
    )),
  primary key (workspace_id, salt),
  foreign key (workspace_id, issued_by) references principals (workspace_id, id),
  -- Usable for 24 hours at most, whatever writes the row.
  check (expires_at > issued_at and expires_at <= issued_at + interval '24 hours'),
  check ((consumed_at is null) = (consumed_by is null)),
  -- A rotation's salt is bound by the rotation itself, and only a rotation's is; a minted one is
  -- bound by a connection or a move.
  check (issued_via <> 'rotate_connection_secret'
    or consumed_by is not distinct from 'rotate_connection_secret'),
  check (consumed_by is distinct from 'rotate_connection_secret'
    or issued_via = 'rotate_connection_secret')
);

-- The next mint's clean-up of the workspace's expired, unconsumed rows.
create index if not exists connection_secret_issuances_unconsumed_idx
  on connection_secret_issuances (workspace_id, expires_at) where consumed_at is null;

create or replace function connection_secret_issuances_guard() returns trigger
  language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- The check bounds `expires_at` by `issued_at`; this bounds `issued_at` by the write, so no row
    -- outlives 24 hours from when it was written. Back-dating only shortens a row's life.
    if new.issued_at > now() then
      raise exception 'connection_secret_issuances: salt % cannot be issued in the future (legacy 711)',
        new.salt;
    end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
     or new.salt is distinct from old.salt
     or new.issued_via is distinct from old.issued_via
     or new.issued_by is distinct from old.issued_by
     or new.issued_at is distinct from old.issued_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'connection_secret_issuances: an issued salt''s own fields never change (legacy 711)';
  end if;
  if old.consumed_at is not null then
    raise exception 'connection_secret_issuances: salt % was consumed by % and serves nothing else (legacy 711)',
      old.salt, old.consumed_by;
  end if;
  if new.consumed_at is null then
    raise exception 'connection_secret_issuances: an update consumes salt % (legacy 711)', old.salt;
  end if;
  if now() >= old.expires_at then
    raise exception 'connection_secret_issuances: salt % expired at % and cannot be consumed (legacy 711)',
      old.salt, old.expires_at;
  end if;
  return new;
end;
$$;

drop trigger if exists connection_secret_issuances_guard on connection_secret_issuances;
create trigger connection_secret_issuances_guard
  before insert or update on connection_secret_issuances
  for each row execute function connection_secret_issuances_guard();

alter table connection_secret_issuances enable row level security;
alter table connection_secret_issuances force row level security;

drop policy if exists connection_secret_issuances_workspace_read on connection_secret_issuances;
create policy connection_secret_issuances_workspace_read on connection_secret_issuances
  for select using (workspace_id = app_workspace());
drop policy if exists connection_secret_issuances_workspace_insert on connection_secret_issuances;
create policy connection_secret_issuances_workspace_insert on connection_secret_issuances
  for insert with check (workspace_id = app_workspace());
drop policy if exists connection_secret_issuances_workspace_consume on connection_secret_issuances;
create policy connection_secret_issuances_workspace_consume on connection_secret_issuances
  for update
  using (workspace_id = app_workspace() and consumed_at is null)
  with check (workspace_id = app_workspace() and consumed_at is not null);
drop policy if exists connection_secret_issuances_workspace_expire on connection_secret_issuances;
create policy connection_secret_issuances_workspace_expire on connection_secret_issuances
  for delete using (
    workspace_id = app_workspace() and consumed_at is null and expires_at <= now()
  );

grant select, insert, update, delete on connection_secret_issuances to nexttime_app;
