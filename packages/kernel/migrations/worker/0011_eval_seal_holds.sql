-- module: worker, version: 0011
--
-- 0011_eval_seal_holds (S10 E3-2c, legacy 514). The evaluation seal (E3-1c, application/eval-seal)
-- refuses what would hand an agent a suite's canary or a verbatim run of a holdout case's text, and
-- lets everything else through — so each refusal tells whoever is trying one bit, and an agent that
-- keeps varying a candidate text can read a held-out case back one character at a time. The seal
-- now counts its refusals per Principal (who the refused call or Worker acted for: a Handle's
-- `on_behalf_of`, the evaluation Principal included) and, at a fixed threshold, pauses every agent
-- acting for that Principal until the workspace owner releases it (coordinator 2026-10-30: 5 in
-- 24 hours, not configurable; held until released — the system never resumes one by itself).
--
--   * `eval_seal_hits` — one row per refusal an agent could have provoked: a capability's result or
--     error on its way to a Handle, or what a Worker would start with (its Task input comes from
--     whoever invoked it). Not a person's chat message or what the entry agent starts a Turn with:
--     only people write those, and every person may read the cases anyway. Says where and for
--     whom, never what (the seal's own audit row says the same). Append-only.
--   * `eval_seal_holds` — one row per pause: whose, how many refusals opened it and where they
--     were (`places`: counts by place — people read this; no agent does), when; once released, by
--     whom, when and why. One active pause per Principal. A refusal counts towards the threshold
--     only within the last 24 hours and after the Principal's last release.
--
-- Guards (what the database refuses whoever writes):
--   * a hit is never changed or deleted;
--   * a pause opens active, with no release; it goes from active to released once, with who and
--     why; nothing else of it changes, and a released one never changes; none is deleted.
-- No DELETE grant. The workspace purge cascade (application/platform/purge-workspace.ts) runs as
-- the owning role with triggers off and finds the new tables by their `workspace_id`.
--
-- Reversible: two new tables nothing earlier reads or writes; the previous release runs on this
-- schema unchanged (its refusals then leave no hit and nothing is paused).
--
-- Advisory lock: same module key as 0001–0010.
select pg_advisory_xact_lock(7241000501);

-- ---------------------------------------------------------------------------------------------
-- eval_seal_hits
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_seal_hits (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  principal_id uuid not null,
  place text not null,
  at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint eval_seal_hits_place check (
    place in ('capability_result', 'capability_error', 'worker_start')
  ),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);

-- The count: a Principal's hits since a point in time.
create index if not exists eval_seal_hits_principal
  on eval_seal_hits (workspace_id, principal_id, at);

alter table eval_seal_hits enable row level security;
drop policy if exists eval_seal_hits_workspace_isolation on eval_seal_hits;
create policy eval_seal_hits_workspace_isolation on eval_seal_hits
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Append-only.
grant select, insert on eval_seal_hits to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- eval_seal_holds
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_seal_holds (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  principal_id uuid not null,
  status text not null default 'active',
  hits int not null,
  places jsonb not null,
  opened_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  primary key (workspace_id, id),
  constraint eval_seal_holds_status check (status in ('active', 'released')),
  constraint eval_seal_holds_hits check (hits >= 1),
  constraint eval_seal_holds_places check (jsonb_typeof(places) = 'object'),
  constraint eval_seal_holds_released check (
    (status = 'released') = (released_at is not null)
    and (status = 'released') = (released_by is not null)
    and (status = 'released') = (release_reason is not null)
  ),
  constraint eval_seal_holds_reason check (
    release_reason is null or char_length(btrim(release_reason)) between 1 and 1000
  ),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id),
  foreign key (workspace_id, released_by) references principals (workspace_id, id)
);

-- One active pause per Principal: the seal opens it with `on conflict do nothing`.
create unique index if not exists eval_seal_holds_one_active
  on eval_seal_holds (workspace_id, principal_id)
  where status = 'active';
-- The list, newest first; and a Principal's last release (where its count starts again).
create index if not exists eval_seal_holds_opened
  on eval_seal_holds (workspace_id, opened_at desc);
create index if not exists eval_seal_holds_principal
  on eval_seal_holds (workspace_id, principal_id, released_at);

alter table eval_seal_holds enable row level security;
drop policy if exists eval_seal_holds_workspace_isolation on eval_seal_holds;
create policy eval_seal_holds_workspace_isolation on eval_seal_holds
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on eval_seal_holds to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- guards
-- ---------------------------------------------------------------------------------------------

create or replace function eval_seal_hits_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'eval_seal_hits: a refusal once counted is kept as it is';
end;
$$;

create or replace trigger eval_seal_hits_guard
  before update or delete on eval_seal_hits
  for each row execute function eval_seal_hits_guard();

create or replace function eval_seal_holds_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'eval_seal_holds: a pause is kept, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'active' or new.released_at is not null or new.released_by is not null
      or new.release_reason is not null then
      raise exception 'eval_seal_holds: a pause opens active, not yet released';
    end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
    or new.id is distinct from old.id
    or new.principal_id is distinct from old.principal_id
    or new.hits is distinct from old.hits
    or new.places is distinct from old.places
    or new.opened_at is distinct from old.opened_at then
    raise exception 'eval_seal_holds: what opened a pause never changes';
  end if;
  if old.status <> 'active' or new.status <> 'released' then
    raise exception 'eval_seal_holds: a pause goes from active to released, once';
  end if;
  return new;
end;
$$;

create or replace trigger eval_seal_holds_guard
  before insert or update or delete on eval_seal_holds
  for each row execute function eval_seal_holds_guard();
