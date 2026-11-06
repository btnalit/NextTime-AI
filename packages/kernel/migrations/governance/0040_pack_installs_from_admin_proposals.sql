-- module: governance, version: 0040
--
-- 0040_pack_installs_from_admin_proposals (S11 AA5g-2: docs/admin-agent-packs-design-2026-11-06.md
-- §2–§4, D2–D4, I-G2 / I-G3). An admin agent may ask a workspace's owner to install a capability
-- pack (`propose_pack_install`): an admin proposal (0032) whose workspace segment holds one item,
-- `{ "kind": "pack_install", "pack": <name>, "version": <n> }`. The owner installs the pack the way
-- every pack is installed (`install_pack`), naming the segment; that install answers it.
--
-- What the record of such an install is, and why it is not an `admin_proposal` source (0033): the
-- content it publishes is the pack's — the deployment's, never drafted by an agent (I-A7 marks what
-- an agent drafted `origin = 'agent'`; a pack's components are not) — and the owner proposed and
-- applied it here, as for any pack. So it stays `source_kind = 'pack'` (its name, version and the
-- pack version's digest), `proposed_by` the owner, and in addition carries 0033's four provenance
-- columns naming the proposal, its segment and the platform user whose admin agent asked for it
-- (by the name they had then): why it was installed, not who wrote it.
--
--   * `change_segments_proposer` (0033's, replaced): a `pack` record has `proposed_by`, and either
--     none of the four columns or all of them — never a part (a part names no proposal it could be
--     checked against). `admin_proposal` records: unchanged.
--   * `change_segments_admin_proposal_guard` (0033's, replaced; insert): a `pack` record naming a
--     proposal segment records one that exists, is addressed to this workspace, is still `proposed`
--     (the installing transaction moves it to `applied` right after, 0033's record guard checking
--     `applied_segment_id`), whose proposal and proposer are the record's, and whose one item is a
--     `pack_install` of exactly this pack (`source_name`) and version (`source_version`), with the
--     segment's content digest the record's `source_digest` (the kernel stores the pack version's
--     digest as a pack install segment's, so an extra pack replaced under the same version number
--     does not answer it) — so an install cannot claim a proposal that asked for something else. `admin_proposal` records:
--     unchanged. A `pack` record naming none: unchanged (passes).
--   * `admin_proposal_segments_item_kinds` (0034's, replaced): a workspace segment holds 0032's
--     intents, as before, or a `pack_install` alone (I-G2) — one install answers it, one record; a
--     platform segment never holds one.
--
-- Unchanged and why it still holds: one record per proposal segment (0033's unique index, over the
-- column, whatever the source); a record rolled back moves its proposal segment to `rolled_back`
-- in the same transaction (the kernel's `rollback.ts` does it for any record naming a segment;
-- 0034's record guard checks the record went first); `admin_proposal_segment_verified` (0039) and
-- `admin_proposal_applied_workspace_changes` (0035) still read `admin_proposal` records only — an
-- install is never exported as a pack (it is one), and a pack install proposal has no platform
-- segment for 0035 to guard.
--
-- Reversibility: a constraint loosened, a guard widened, a check added. Every row an earlier release
-- writes passes all three (a pack record with none of the four columns, as before; no segment holds
-- `pack_install`), and its reads of records do not depend on the four columns being null for a pack
-- (the segment reads take them as provenance whatever the source). Rolling back the code alone
-- corrupts nothing; a `pack_install` segment it then lists shows an item kind it does not know and
-- cannot be applied by it (its apply resolves no `pack_install` — reject or withdraw it). To take the
-- migration out (only with no pack record naming a proposal and no `pack_install` segment left):
-- restore 0033's `change_segments_proposer`, 0033's guard body and 0034's
-- `admin_proposal_segments_item_kinds`, then
-- `delete from schema_migrations where module = 'governance' and version = 40`.
--
-- Cross-process bootstrap lock: same governance-module key as 0001–0039.
select pg_advisory_xact_lock(7241000201);

alter table change_segments drop constraint if exists change_segments_proposer;
alter table change_segments add constraint change_segments_proposer check (
  case source_kind
    when 'admin_proposal' then
      proposed_by is null
      and admin_proposal_id is not null and admin_proposal_segment_id is not null
      and proposed_by_user is not null and proposer_display_name is not null
      and source_version = admin_proposal_id::text
    else
      proposed_by is not null
      and (
        (admin_proposal_id is null and admin_proposal_segment_id is null
         and proposed_by_user is null and proposer_display_name is null)
        or (source_kind = 'pack'
         and admin_proposal_id is not null and admin_proposal_segment_id is not null
         and proposed_by_user is not null and proposer_display_name is not null)
      )
  end
);

create or replace function change_segments_admin_proposal_guard() returns trigger
language plpgsql as $$
declare
  proposed record;
begin
  if new.admin_proposal_segment_id is null then
    -- `change_segments_proposer` already requires the segment of every `admin_proposal` record.
    return new;
  end if;
  -- Read in the applying transaction, as the target workspace: 0032's policies let it read the
  -- segment addressed to it and that segment's proposal head, nothing else.
  select s.status, s.target_workspace_id, s.proposal_id, s.content_digest, s.items,
         p.source_name, p.proposed_by_user, p.proposer_display_name
    into proposed
    from admin_proposal_segments s
    join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
   where s.id = new.admin_proposal_segment_id;
  if not found or proposed.target_workspace_id is distinct from new.workspace_id then
    raise exception 'change_segments: an admin_proposal segment records a proposal segment addressed to this workspace (% is not)',
      new.admin_proposal_segment_id;
  end if;
  if proposed.status <> 'proposed' then
    raise exception 'change_segments: a proposal segment is applied while it is proposed, not %',
      proposed.status;
  end if;
  if new.source_kind = 'admin_proposal' then
    -- 0033's check and words, unchanged.
    if proposed.proposal_id is distinct from new.admin_proposal_id
       or proposed.content_digest is distinct from new.source_digest
       or proposed.source_name is distinct from new.source_name
       or proposed.proposed_by_user is distinct from new.proposed_by_user
       or proposed.proposer_display_name is distinct from new.proposer_display_name then
      raise exception 'change_segments: an admin_proposal segment''s source and proposer are its proposal segment''s proposal, content digest and proposer';
    end if;
    return new;
  end if;
  if proposed.proposal_id is distinct from new.admin_proposal_id
     or proposed.proposed_by_user is distinct from new.proposed_by_user
     or proposed.proposer_display_name is distinct from new.proposer_display_name then
    raise exception 'change_segments: a pack install''s proposal and proposer are its proposal segment''s proposal and proposer';
  end if;
  -- S11 AA5g-2: a pack install answering a proposal segment that asked for exactly it.
  if jsonb_array_length(proposed.items) <> 1
     or proposed.items -> 0 ->> 'kind' is distinct from 'pack_install'
     or proposed.items -> 0 ->> 'pack' is distinct from new.source_name
     or proposed.items -> 0 ->> 'version' is distinct from new.source_version
     or proposed.content_digest is distinct from new.source_digest then
    raise exception 'change_segments: a pack install answers a proposal segment asking for this pack (%) at this version (%) with this content',
      new.source_name, new.source_version;
  end if;
  return new;
end;
$$;

-- 0034's, with `pack_install`: a workspace segment holds 0032's intents, or one `pack_install`
-- alone (I-G2); a platform segment never holds one.
alter table admin_proposal_segments drop constraint if exists admin_proposal_segments_item_kinds;
alter table admin_proposal_segments add constraint admin_proposal_segments_item_kinds check (
  case authority
    when 'platform' then
      jsonb_array_length(items) <= 10
      and jsonb_array_length(jsonb_path_query_array(items,
        'strict $[*] ? (@.kind.type() == "string" && @.kind == "gate_instance")'))
        = jsonb_array_length(items)
    else
      jsonb_array_length(jsonb_path_query_array(items,
        'strict $[*] ? (@.kind.type() == "string" && (@.kind == "skill_version" || @.kind == "worker_definition_version" || @.kind == "ontology_version" || @.kind == "operation_version"))'))
        = jsonb_array_length(items)
      or (
        jsonb_array_length(items) = 1
        and jsonb_array_length(jsonb_path_query_array(items,
          'strict $[*] ? (@.kind.type() == "string" && @.kind == "pack_install")')) = 1
      )
  end
);
