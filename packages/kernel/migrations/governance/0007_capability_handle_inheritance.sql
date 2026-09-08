-- module: governance, version: 0007
--
-- capability_handles inheritance lock (I13; lane-1 P2 fix): 0001_capability_handles.sql's own
-- trigger only ever blocked `on_behalf_of` from being *updated* after insertion — the inheritance
-- rules themselves ("`on_behalf_of` is copied from `sessions.on_behalf_of` at issuance time"; a
-- child Handle's scope/ttl/`on_behalf_of` must narrow from its parent, §5.4 I13, §5.3 item 8) were
-- enforced only in application code (`governance/capability/handles.ts`'s `issueHandle`/
-- `attenuate`/`assertScopeIsSubset`, `application/task/handle-mint.ts`'s `mintWorkerRunHandle`) —
-- never at the data layer, so a future write path (a bug, a bypass of those functions, an admin
-- script) could insert a `capability_handles` row whose `on_behalf_of` disagrees with its own
-- session, or whose `expires_at` outlives its parent, with nothing in the schema to stop it. This
-- migration adds a `before insert` trigger enforcing the two invariants the data layer *can* check
-- without re-verifying a Handle's JWT signature:
--
--   1. `on_behalf_of` must equal the row's own `session_id`'s `sessions.on_behalf_of` — true for
--      every Handle, root or child alike (both `issueHandle` and `mintWorkerRunHandle` already
--      read `on_behalf_of` from the session row itself, never from a caller-supplied parameter).
--   2. When `parent_jti` is set, `on_behalf_of` must equal the parent Handle's own `on_behalf_of`,
--      and `expires_at` must not exceed the parent's `expires_at` — a child Handle attenuates its
--      parent, it never inherits a different identity or a longer lifetime.
--
-- Deliberately `before insert` only (not `before update`) — `on_behalf_of`'s own immutability
-- after insertion is already the separate `capability_handles_immutable_on_behalf_of` trigger from
-- 0001; `expires_at`/`parent_jti` are otherwise plain, unconstrained columns post-insert (nothing
-- in this codebase ever updates them — `revokeHandle`/`revokeSession` only ever set `revoked_at`).
select pg_advisory_xact_lock(7241000201);

create or replace function capability_handles_enforce_inheritance() returns trigger
language plpgsql as $$
declare
  session_on_behalf_of uuid;
  parent_on_behalf_of uuid;
  parent_expires_at timestamptz;
begin
  select on_behalf_of into session_on_behalf_of
  from sessions
  where workspace_id = new.workspace_id and id = new.session_id;

  if session_on_behalf_of is null then
    raise exception
      'capability_handles: no session % found in workspace % (I13)', new.session_id, new.workspace_id;
  end if;

  if new.on_behalf_of is distinct from session_on_behalf_of then
    raise exception
      'capability_handles: on_behalf_of must match the issuing session''s own on_behalf_of (I13)';
  end if;

  if new.parent_jti is not null then
    select on_behalf_of, expires_at into parent_on_behalf_of, parent_expires_at
    from capability_handles
    where workspace_id = new.workspace_id and jti = new.parent_jti;

    if parent_on_behalf_of is null then
      raise exception
        'capability_handles: no parent handle % found in workspace % (I13)', new.parent_jti, new.workspace_id;
    end if;

    if new.on_behalf_of is distinct from parent_on_behalf_of then
      raise exception
        'capability_handles: a child handle''s on_behalf_of must match its parent''s (I13)';
    end if;

    if new.expires_at > parent_expires_at then
      raise exception
        'capability_handles: a child handle''s expires_at cannot exceed its parent''s (I13)';
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger capability_handles_inheritance
  before insert on capability_handles
  for each row execute function capability_handles_enforce_inheritance();
