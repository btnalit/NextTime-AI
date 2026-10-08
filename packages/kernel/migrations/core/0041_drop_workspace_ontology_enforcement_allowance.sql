-- module: core, version: 0041
--
-- S10 W1 P0 (docs/s10-evolution-plan-2026-10-04.md §7.1, STATUS leftover 123 follow-up): drop the
-- one compatibility allowance 0035 (R-29) kept on `workspaces` — a workspace transaction could
-- still change its own workspace's `ontology_enforcement`. No kernel code ever used it (the
-- administrator's switch is the platform `update_workspace`); it existed only because the v0.38.x
-- integration suite set the column that way and the reversibility probe ran that suite on the new
-- schema. Every release since sets it on the login role, and the probe's base is now the latest
-- release tag, so no rollback target needs the allowance.
--
-- After this, a workspace transaction cannot update any `workspaces` row: with no policy admitting
-- it, RLS hides the row from the UPDATE (0 rows, as for another tenant's row today). The trigger
-- stays as the second wall and loses its column exception, so a policy added later by mistake
-- still cannot open the row to the workspace plane. Platform transactions and the login role are
-- unchanged.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

drop policy if exists workspaces_own_ontology_enforcement on workspaces;

create or replace function workspaces_block_workspace_plane_update() returns trigger
language plpgsql as $$
begin
  if current_user = 'nexttime_app' and not app_platform() then
    raise exception 'workspaces: only a platform transaction may change a workspace (R-29)';
  end if;
  return new;
end;
$$;
