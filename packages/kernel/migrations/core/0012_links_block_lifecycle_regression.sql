-- module: core, version: 0012
--
-- links (=Fact) lifecycle/epistemic regression lock (I4; lane-1 P3 fix): 0002_substrate.sql's
-- `links_block_content_update()` trigger already made every *content* column immutable once
-- recorded, and deliberately left `superseded_at`/`invalidated_at`/`epistemic_status`/`confidence`/
-- `verified_by` open for "legitimate follow-on writes" (that file's own comment) — but it never
-- actually constrained *which* follow-on writes are legitimate, so nothing stopped an UPDATE from
-- unsetting `superseded_at`/`invalidated_at` once set, setting both, or walking `epistemic_status`
-- backwards/sideways outside the one-way promotion `EPISTEMIC_PROMOTION_TRANSITIONS`
-- (packages/shared/src/transitions.ts) actually allows. This migration redefines the same trigger
-- function (`create or replace function` — the existing `before update` trigger already dispatches
-- by name) to add both checks.
--
-- Fact lifecycle (FACT_LIFECYCLE_TRANSITIONS): `recorded -> superseded | invalidated`, both
-- terminal — once either timestamp is set, neither may change (including being unset) and the
-- other may never subsequently be set.
--
-- Epistemic promotion (EPISTEMIC_PROMOTION_TRANSITIONS): `{observed,extracted,inferred,asserted}
-- -> verified | contradicted`; `verified -> contradicted`; `contradicted` terminal. No edge allows
-- moving *among* the four non-terminal statuses (there is no "reclassify" event, only `verify`/
-- `contradict`), so any change starting from one of them must land on `verified` or `contradicted`.
select pg_advisory_xact_lock(7241000101);

create or replace function links_block_content_update() returns trigger
language plpgsql as $$
begin
  if new.link_type is distinct from old.link_type
    or new.source_object_id is distinct from old.source_object_id
    or new.target_object_id is distinct from old.target_object_id
    or new.properties is distinct from old.properties
    or new.valid_from is distinct from old.valid_from
    or new.valid_until is distinct from old.valid_until
    or new.activity_id is distinct from old.activity_id
    or new.asserted_by is distinct from old.asserted_by
    or new.recorded_at is distinct from old.recorded_at
  then
    raise exception 'links: content columns are immutable once recorded (I4) — use supersede/invalidate instead';
  end if;

  if (old.superseded_at is not null or old.invalidated_at is not null)
    and (
      new.superseded_at is distinct from old.superseded_at
      or new.invalidated_at is distinct from old.invalidated_at
    )
  then
    raise exception
      'links: superseded_at/invalidated_at are immutable once a Fact is superseded or invalidated (I4)';
  end if;

  if new.epistemic_status is distinct from old.epistemic_status then
    if old.epistemic_status = 'contradicted' then
      raise exception 'links: epistemic_status is terminal once contradicted (I4)';
    elsif old.epistemic_status = 'verified' and new.epistemic_status <> 'contradicted' then
      raise exception 'links: a verified Fact may only be promoted to contradicted (I4)';
    elsif old.epistemic_status not in ('verified', 'contradicted')
      and new.epistemic_status not in ('verified', 'contradicted') then
      raise exception
        'links: epistemic_status may only be promoted to verified or contradicted, never changed sideways (I4)';
    end if;
  end if;

  return new;
end;
$$;
