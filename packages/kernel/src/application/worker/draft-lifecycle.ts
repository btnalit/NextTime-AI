import type { DraftKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { WorkerDefinitionNotFoundError } from './definitions.js';
import { ProcedureNotFoundError } from './procedures.js';
import { SkillNotFoundError } from './skills.js';

/**
 * application/worker/draft-lifecycle: the S8 W3 K2 (leftover 82) draft terminal states —
 * `draft -> discarded` (manual, one caller's own draft, `discard_draft`) and
 * `draft -> expired` (periodic kernel sweep, every workspace, every kind) — for the three
 * proposer-private (I16) registries this module's siblings own: `worker_definitions`
 * (definitions.ts), `skills` (skills.ts), `procedures` (procedures.ts). Both paths delete the row
 * outright (migrations/worker/0003_draft_discard.sql: no fourth `PublishableStatus` value, and a
 * database trigger blocks deleting anything but a `draft` row regardless of what this file gets
 * right) and write an AuditRecord in the same transaction as the delete (I11) — the durable
 * evidence that a draft once existed and was removed, why, and by whom.
 *
 * Direct SQL against `worker_definitions`/`skills`/`procedures` here, not calls back into
 * `definitions.ts`/`skills.ts`/`procedures.ts`, is the same "same module, sibling files share the
 * tables" convention `skills.ts`'s own module doc comment already establishes for
 * `linkPublishedWorkerDefinitionsUsingSkill`.
 *
 * I16 read-privacy for the manual path (`discardDraft`): a caller naming a draft they did not
 * propose gets the exact same `*NotFoundError` a caller naming an id that does not exist at all
 * gets — never a 403 — reusing `getSkill`/`listSkills`'s own "not visible = not found" convention
 * (skills.ts's own doc comment) rather than confirming a draft's existence to a non-owner. Do not
 * add an owner/admin override here: I16 already establishes that nobody but the proposer can even
 * see a draft, so there is no "owner" concept for this table to defer to.
 */

// -------------------------------------------------------------------------------------------
// discard_draft (manual, one caller's own draft)
// -------------------------------------------------------------------------------------------

export interface DraftRef {
  readonly kind: DraftKind;
  readonly id: string;
  readonly version: number;
}

export interface DiscardedDraft {
  readonly kind: DraftKind;
  readonly id: string;
  readonly version: number;
  /** The draft's own display name at the time it was deleted (`definition.name` for a
   *  WorkerDefinition, `name` for a Skill/Procedure) — `null` when the field was never set
   *  (WorkerDefinition's `name` is optional). Carried in the AuditRecord payload, not on the wire
   *  result (`DiscardDraftResultWireSchema` only echoes `{kind, id, version}` — the row no longer
   *  exists to describe further). */
  readonly name: string | null;
}

/** Thrown by `discardDraft` when the addressed row exists and belongs to the caller, but is not
 *  currently `draft` (already `published` or `deprecated`) — a published/deprecated version is
 *  never deletable through this capability (I12: it may be referenced by a Task or another
 *  WorkerDefinition/Procedure by now). Same 409 "well-formed request, the row's state forbids it"
 *  family as `WorkerDefinitionNotPublishedError`. */
export class DraftNotDiscardableError extends Error {
  readonly kind: DraftKind;
  readonly id: string;
  readonly version: number;
  readonly status: string;

  constructor(kind: DraftKind, id: string, version: number, status: string) {
    super(
      `${kind} ${id}@${version} is not a draft (status: ${status}) — only a draft version may be discarded`,
    );
    this.name = 'DraftNotDiscardableError';
    this.kind = kind;
    this.id = id;
    this.version = version;
    this.status = status;
  }
}

interface DraftLookupRow {
  readonly status: string;
  readonly proposed_by: string;
  readonly name: string | null;
}

async function lookupDraftForUpdate(
  client: PoolClient,
  workspaceId: string,
  ref: DraftRef,
): Promise<DraftLookupRow | null> {
  if (ref.kind === 'worker_definition') {
    const result = await client.query<DraftLookupRow>(
      `select status, proposed_by, definition ->> 'name' as name from worker_definitions
       where workspace_id = $1 and id = $2 and version = $3
       for update`,
      [workspaceId, ref.id, ref.version],
    );
    return result.rows[0] ?? null;
  }
  if (ref.kind === 'skill') {
    const result = await client.query<DraftLookupRow>(
      `select status, proposed_by, name from skills
       where workspace_id = $1 and id = $2 and version = $3
       for update`,
      [workspaceId, ref.id, ref.version],
    );
    return result.rows[0] ?? null;
  }
  const result = await client.query<DraftLookupRow>(
    `select status, proposed_by, name from procedures
     where workspace_id = $1 and id = $2 and version = $3
     for update`,
    [workspaceId, ref.id, ref.version],
  );
  return result.rows[0] ?? null;
}

async function deleteDraftRow(
  client: PoolClient,
  workspaceId: string,
  ref: DraftRef,
): Promise<boolean> {
  if (ref.kind === 'worker_definition') {
    const result = await client.query(
      `delete from worker_definitions
       where workspace_id = $1 and id = $2 and version = $3 and status = 'draft'`,
      [workspaceId, ref.id, ref.version],
    );
    return (result.rowCount ?? 0) > 0;
  }
  if (ref.kind === 'skill') {
    const result = await client.query(
      `delete from skills where workspace_id = $1 and id = $2 and version = $3 and status = 'draft'`,
      [workspaceId, ref.id, ref.version],
    );
    return (result.rowCount ?? 0) > 0;
  }
  const result = await client.query(
    `delete from procedures
     where workspace_id = $1 and id = $2 and version = $3 and status = 'draft'`,
    [workspaceId, ref.id, ref.version],
  );
  return (result.rowCount ?? 0) > 0;
}

function notFoundErrorFor(ref: DraftRef, workspaceId: string): Error {
  if (ref.kind === 'worker_definition') {
    return new WorkerDefinitionNotFoundError(workspaceId, ref.id, ref.version);
  }
  if (ref.kind === 'skill') {
    return new SkillNotFoundError(workspaceId, ref.id);
  }
  return new ProcedureNotFoundError(workspaceId, ref.id);
}

/** Discards `ref` (`discard_draft{kind, id, version}`, human channel — I16) on behalf of
 *  `callerPrincipalId`. Throws the kind-specific `*NotFoundError` when the row does not exist *or*
 *  belongs to a different proposer (I16: the two are indistinguishable to anyone but the
 *  proposer — this module's own doc comment); throws `DraftNotDiscardableError` when the row
 *  exists, is the caller's own, but is not currently `draft`. Deletes the row and returns what was
 *  deleted; the caller (the `discard_draft` gateway handler) is responsible for the AuditRecord —
 *  `application/gateway/dispatch.ts` writes one for every capability call in the same transaction
 *  (I11), so this function does not duplicate it. */
export async function discardDraft(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
  ref: DraftRef,
): Promise<DiscardedDraft> {
  const row = await lookupDraftForUpdate(client, workspaceId, ref);
  if (!row || row.proposed_by !== callerPrincipalId) {
    throw notFoundErrorFor(ref, workspaceId);
  }
  if (row.status !== 'draft') {
    throw new DraftNotDiscardableError(ref.kind, ref.id, ref.version, row.status);
  }
  await deleteDraftRow(client, workspaceId, ref);
  return { kind: ref.kind, id: ref.id, version: ref.version, name: row.name };
}

// -------------------------------------------------------------------------------------------
// periodic expiry sweep (all workspaces, all three kinds)
// -------------------------------------------------------------------------------------------

/** Default staleness threshold for the periodic expiry sweep — maintainer decision (S8 W3 K2,
 *  docs/convergence-plan-2026-09-25.md §10 item 2: "推荐 30 天"). `packages/kernel/src/index.ts`
 *  reads `DRAFT_EXPIRY_DAYS` and falls back to this; `0` disables the sweep entirely (same
 *  deliberate-opt-out convention `DEFAULT_OUTBOX_PRUNE_DAYS`'s own call site already established
 *  for `OUTBOX_PRUNE_DAYS=0`). */
export const DEFAULT_DRAFT_EXPIRY_DAYS = 30;

const DRAFT_REAPER_SERVICE_PRINCIPAL_DISPLAY_NAME = '__draft_reaper__';

interface PrincipalIdRow {
  readonly id: string;
}

/** The workspace's shared `service`-kind Principal for automated draft-lifecycle actions (the
 *  periodic expiry sweep), lazily created on first use — same pattern as
 *  `governance/gatekeepers/service-principal.ts`'s `getOrCreateGatekeeperServicePrincipal` (that
 *  one's own doc comment: looked up by a fixed `display_name`, a concurrent race creates at most a
 *  small number of harmless duplicate rows, no unique constraint needed). A distinct Principal
 *  from the Gatekeeper one — attributing an expired-draft AuditRecord to "the Gatekeeper service"
 *  would be a misleading audit trail; this one's `display_name` names what it actually is. Not
 *  `SYSTEM_ACTOR_PLACEHOLDER` (`governance/gatekeepers/system-actor.ts`): that fixed uuid is never
 *  backed by a real `principals` row (it only exists to satisfy `withWorkspace`'s session-variable
 *  precondition under `skipRoleSwitch: true`) and would fail `audit_records`'s own
 *  `(workspace_id, actor_principal_id)` foreign key the moment this sweep tried to write an audit
 *  row with it. */
async function getOrCreateDraftReaperServicePrincipal(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const existing = await client.query<PrincipalIdRow>(
    "select id from principals where workspace_id = $1 and kind = 'service' and display_name = $2 limit 1",
    [workspaceId, DRAFT_REAPER_SERVICE_PRINCIPAL_DISPLAY_NAME],
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const inserted = await client.query<PrincipalIdRow>(
    `insert into principals (workspace_id, kind, role, display_name)
     values ($1, 'service', 'member', $2)
     returning id`,
    [workspaceId, DRAFT_REAPER_SERVICE_PRINCIPAL_DISPLAY_NAME],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error('getOrCreateDraftReaperServicePrincipal: INSERT ... RETURNING produced no row');
  }
  return row.id;
}

interface ExpiredDraftCandidateRow {
  readonly workspace_id: string;
  readonly id: string;
  readonly version: number;
  readonly kind: DraftKind;
  readonly proposed_by: string;
  readonly name: string | null;
}

export interface ExpireDraftsOnceOptions {
  /** Drafts whose `created_at` is older than this many days are expired. A draft row is never
   *  mutated in place after `propose*` inserts it (no capability edits a draft's content — see
   *  this module's own doc comment and each sibling registry's "propose is intentionally
   *  permissive, publish is the gate" comment) — these tables have no `updated_at` column because
   *  there is nothing that would ever update one; `created_at` is therefore the correct, and only,
   *  "how long has this draft sat untouched" proxy, not a fallback chosen for lack of a better
   *  option. */
  readonly thresholdDays: number;
  /** Injectable clock, for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface ExpireDraftsOnceResult {
  readonly expired: number;
}

/**
 * Sweeps every workspace for `draft` WorkerDefinition/Skill/Procedure rows older than
 * `options.thresholdDays` and deletes them, one AuditRecord per deleted draft
 * (`action: 'draft.expired'`), attributed to that workspace's draft-reaper service Principal
 * (`getOrCreateDraftReaperServicePrincipal` above). Same cross-workspace scan shape every other
 * periodic sweep in this codebase uses (`application/task/reaper.ts`'s `reapLostQueuedTasks`/
 * `runTaskReaper`: one raw, admin-mode `SELECT` across every workspace, then one governed
 * `withWorkspace` transaction per candidate) — "exactly one kernel process, not one per
 * workspace". A candidate no longer `draft` by the time its own transaction runs (published,
 * deprecated, or discarded concurrently — a benign race, not a failure) is silently skipped, same
 * "well-formed but state changed underneath us" tolerance `runTaskReaper`'s own guarded
 * UPDATE + `rowCount` check already establishes for its sibling sweeps.
 */
export async function expireDraftsOnce(
  pool: PoolLike,
  options: ExpireDraftsOnceOptions,
): Promise<ExpireDraftsOnceResult> {
  const now = options.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - options.thresholdDays * 24 * 60 * 60 * 1000);

  const scanClient = await pool.connect();
  let candidates: readonly ExpiredDraftCandidateRow[];
  try {
    const result = await scanClient.query<ExpiredDraftCandidateRow>(
      `select workspace_id, id, version, kind, proposed_by, name from (
         select workspace_id, id, version, 'worker_definition'::text as kind, proposed_by,
                definition ->> 'name' as name, created_at
         from worker_definitions
         where status = 'draft'
         union all
         select workspace_id, id, version, 'skill'::text as kind, proposed_by, name, created_at
         from skills
         where status = 'draft'
         union all
         select workspace_id, id, version, 'procedure'::text as kind, proposed_by, name, created_at
         from procedures
         where status = 'draft'
       ) drafts
       where created_at < $1::timestamptz`,
      [cutoff.toISOString()],
    );
    candidates = result.rows;
  } finally {
    scanClient.release();
  }

  let expired = 0;
  for (const candidate of candidates) {
    const ref: DraftRef = { kind: candidate.kind, id: candidate.id, version: candidate.version };
    await withWorkspace(
      pool,
      { workspaceId: candidate.workspace_id, principalId: candidate.proposed_by },
      async (client) => {
        const systemPrincipalId = await getOrCreateDraftReaperServicePrincipal(
          client,
          candidate.workspace_id,
        );
        const deleted = await deleteDraftRow(client, candidate.workspace_id, ref);
        if (!deleted) return;
        await writeAudit(client, {
          workspaceId: candidate.workspace_id,
          actorPrincipalId: systemPrincipalId,
          action: 'draft.expired',
          resourceType: candidate.kind,
          resourceId: candidate.id,
          payload: {
            kind: candidate.kind,
            id: candidate.id,
            version: candidate.version,
            name: candidate.name,
            proposedBy: candidate.proposed_by,
            reason: 'expired',
            thresholdDays: options.thresholdDays,
          },
        });
        expired += 1;
      },
    );
  }
  return { expired };
}
