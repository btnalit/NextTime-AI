import type { DecisionStatus, EpistemicStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type ExplainResult, explain } from './explain.js';

/**
 * substrate/epistemic/decisions: the four read-only S3.2 epistemic capabilities that walk
 * `decisions` and its provenance — `query_decisions`, `find_precedents`, `causal_chain`,
 * `decision_impact` (docs/development-tasks.md S3.2, design doc §9.3's reference-tool-name
 * contract: `get_causal_chain`=`causal_chain`, `analyze_decision_impact`=`decision_impact` —
 * see `packages/shared/src/capabilities.ts`, the content layer, for which prior tool named each).
 *
 * **Cross-table reads (same precedent as `explain.ts` — see that file's own module doc comment)**:
 * `decisions` is this module's own table, but answering these four capabilities also needs to read
 * `links` (`query_decisions`'s `objectId` filter, `causal_chain`'s supersede-history walk,
 * `decision_impact`'s "Facts produced alongside this Decision") and `action_requests`/`tasks`
 * (`decision_impact`'s "downstream" set). `links` is `substrate/graph`'s table; `action_requests`
 * is `governance`'s; `tasks` is `application/task`'s — none of their owning modules is reachable
 * from here (`.dependency-cruiser.cjs`: substrate may depend only on domain, never on governance or
 * application), and this module must not import their internal types regardless (§7.10 module
 * contract). Every read below is therefore a direct, read-only SQL SELECT with its own local row
 * shape (no write, ever) — exactly `explain.ts`'s own "explain's job is inherently this
 * cross-cutting provenance read" reasoning, extended to these four sibling capabilities. RLS
 * (`nexttime_app`'s ordinary session role, no `security definer` involved here) already scopes
 * every one of these SELECTs to what the calling principal may see.
 *
 * **`relatedFactIds`/`relatedTaskId` (`record_decision`, handlers.ts) and `factAId`/`factBId`
 * (`resolve_conflict`, epistemic-handlers.ts) are the only structured cross-references a Decision's
 * free-form `rationale` jsonb carries** — `record_decision`'s own doc comment in handlers.ts
 * already flags this as a known gap ("关联语义...本任务不代为决定"). `query_decisions`'s `objectId`
 * filter and `causal_chain`/`decision_impact`'s Fact-side results are therefore only as complete as
 * what `rationale` happens to carry for a given Decision's origin — a Decision written by
 * `governance/approval/decide.ts` (whose `rationale` carries `actionRequestId`/`actionKind`, no
 * Fact ids) will correctly show no related Facts here, not an error.
 */

// -------------------------------------------------------------------------------------------
// Row shapes
// -------------------------------------------------------------------------------------------

export interface DecisionRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly status: DecisionStatus;
  readonly activityId: string;
  readonly sourceId: string | null;
  readonly summary: string | null;
  readonly rationale: Record<string, unknown> | null;
  readonly decidedBy: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
}

interface DecisionDbRow {
  workspace_id: string;
  id: string;
  status: DecisionStatus;
  activity_id: string;
  source_id: string | null;
  summary: string | null;
  rationale: Record<string, unknown> | null;
  decided_by: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const DECISION_COLUMNS =
  'workspace_id, id, status, activity_id, source_id, summary, rationale, decided_by, created_at, decided_at';

function mapDecisionRow(row: DecisionDbRow): DecisionRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    status: row.status,
    activityId: row.activity_id,
    sourceId: row.source_id,
    summary: row.summary,
    rationale: row.rationale,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export class DecisionNotFoundError extends Error {
  constructor(workspaceId: string, decisionId: string) {
    super(`Decision not found: workspace ${workspaceId}, id ${decisionId}`);
    this.name = 'DecisionNotFoundError';
  }
}

/** Local `links` projection — deliberately re-declared rather than imported from
 *  `substrate/graph/sql-store.ts` (its `FactRow`/`mapFactRow` are that module's own internals, not
 *  part of `GraphStore`'s exported surface) — same "own local row shape per reading module" pattern
 *  `explain.ts`'s `FactDbRow` already established. */
export interface FactRef {
  readonly workspaceId: string;
  readonly id: string;
  readonly linkType: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly properties: Record<string, unknown>;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly recordedAt: Date;
  readonly supersededAt: Date | null;
  readonly invalidatedAt: Date | null;
  readonly invalidationReason: string | null;
  readonly supersedesId: string | null;
  readonly epistemicStatus: EpistemicStatus;
  readonly confidence: number | null;
  readonly activityId: string;
  readonly assertedBy: string;
  readonly verifiedBy: string | null;
}

interface FactDbRow {
  workspace_id: string;
  id: string;
  link_type: string;
  source_object_id: string;
  target_object_id: string;
  properties: Record<string, unknown>;
  valid_from: Date;
  valid_until: Date | null;
  recorded_at: Date;
  superseded_at: Date | null;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  supersedes_id: string | null;
  epistemic_status: EpistemicStatus;
  confidence: number | null;
  activity_id: string;
  asserted_by: string;
  verified_by: string | null;
}

const FACT_REF_COLUMNS = `workspace_id, id, link_type, source_object_id, target_object_id, properties,
  valid_from, valid_until, recorded_at, superseded_at, invalidated_at, invalidation_reason,
  supersedes_id, epistemic_status, confidence, activity_id, asserted_by, verified_by`;

function mapFactRefRow(row: FactDbRow): FactRef {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    linkType: row.link_type,
    sourceObjectId: row.source_object_id,
    targetObjectId: row.target_object_id,
    properties: row.properties,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    recordedAt: row.recorded_at,
    supersededAt: row.superseded_at,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
    supersedesId: row.supersedes_id,
    epistemicStatus: row.epistemic_status,
    confidence: row.confidence,
    activityId: row.activity_id,
    assertedBy: row.asserted_by,
    verifiedBy: row.verified_by,
  };
}

/** Every distinct Fact id `rationale` names, from whichever of `record_decision`'s
 *  `relatedFactIds` or `resolve_conflict`'s `factAId`/`factBId` it carries (module doc comment). */
function extractFactIdsFromRationale(rationale: Record<string, unknown> | null): readonly string[] {
  if (!rationale) return [];
  const ids = new Set<string>();
  const related = rationale.relatedFactIds;
  if (Array.isArray(related)) {
    for (const value of related) if (typeof value === 'string') ids.add(value);
  }
  if (typeof rationale.factAId === 'string') ids.add(rationale.factAId);
  if (typeof rationale.factBId === 'string') ids.add(rationale.factBId);
  return [...ids];
}

async function getDecisionRow(
  client: PoolClient,
  workspaceId: string,
  decisionId: string,
): Promise<DecisionRow> {
  const result = await client.query<DecisionDbRow>(
    `select ${DECISION_COLUMNS} from decisions where workspace_id = $1 and id = $2`,
    [workspaceId, decisionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new DecisionNotFoundError(workspaceId, decisionId);
  return mapDecisionRow(row);
}

// -------------------------------------------------------------------------------------------
// query_decisions
// -------------------------------------------------------------------------------------------

export const DEFAULT_QUERY_DECISIONS_LIMIT = 20;
export const MAX_QUERY_DECISIONS_LIMIT = 100;

export interface QueryDecisionsInput {
  /** Matches a Decision whose `rationale` names a Fact touching this Object (module doc comment's
   *  "only as complete as what `rationale` carries" caveat applies). */
  readonly objectId?: string;
  /** ISO 8601 — Decisions `created_at >= since`. */
  readonly since?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DecisionsPage {
  readonly items: readonly DecisionRow[];
  readonly nextCursor?: string;
}

function encodeKeysetCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Same "never throws on a malformed cursor" convention as `conflicts.ts`'s own decoder /
 *  `application/chat/service.ts`'s `parseCursor`. */
function decodeKeysetCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const at = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (!at || !id || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function queryDecisions(
  client: PoolClient,
  workspaceId: string,
  input: QueryDecisionsInput,
): Promise<DecisionsPage> {
  const limit = Math.min(input.limit ?? DEFAULT_QUERY_DECISIONS_LIMIT, MAX_QUERY_DECISIONS_LIMIT);
  const cursor = decodeKeysetCursor(input.cursor);
  const since = input.since ? new Date(input.since) : null;

  const result = await client.query<DecisionDbRow>(
    `select ${DECISION_COLUMNS} from decisions d
     where d.workspace_id = $1
       and ($2::timestamptz is null or d.created_at >= $2)
       and (
         $3::uuid is null
         or exists (
           select 1
           from jsonb_array_elements_text(coalesce(d.rationale -> 'relatedFactIds', '[]'::jsonb)) fid
           join links l on l.workspace_id = d.workspace_id and l.id = fid::uuid
           where l.source_object_id = $3 or l.target_object_id = $3
         )
       )
       and ($4::timestamptz is null or (d.created_at, d.id) < ($4::timestamptz, $5::uuid))
     order by d.created_at desc, d.id desc
     limit $6`,
    [workspaceId, since, input.objectId ?? null, cursor?.at ?? null, cursor?.id ?? null, limit],
  );

  const items = result.rows.map(mapDecisionRow);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === limit && last ? encodeKeysetCursor(last.createdAt, last.id) : undefined;
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

// -------------------------------------------------------------------------------------------
// find_precedents
// -------------------------------------------------------------------------------------------

export const DEFAULT_FIND_PRECEDENTS_LIMIT = 10;
export const MAX_FIND_PRECEDENTS_LIMIT = 50;

export interface FindPrecedentsInput {
  readonly objectId?: string;
  /** = `rationale.actionKind` — the only place an approval Decision (`governance/approval/
   *  decide.ts`'s `writeApprovalDecision`) records the ActionRequest's `actionKindTag`. */
  readonly actionKindTag?: string;
  readonly limit?: number;
}

/** Neither `objectId` nor `actionKindTag` given → empty result (module doc comment: this file
 *  follows the codebase's existing "no `.refine()` in `paramsSchema`" convention rather than
 *  inventing a new validation shape for this one capability — an empty, valid answer is
 *  indistinguishable in practice from "no precedent found"). */
export async function findPrecedents(
  client: PoolClient,
  workspaceId: string,
  input: FindPrecedentsInput,
): Promise<{ readonly items: readonly DecisionRow[] }> {
  if (!input.objectId && !input.actionKindTag) return { items: [] };
  const limit = Math.min(input.limit ?? DEFAULT_FIND_PRECEDENTS_LIMIT, MAX_FIND_PRECEDENTS_LIMIT);

  const result = await client.query<DecisionDbRow>(
    `select ${DECISION_COLUMNS} from decisions d
     where d.workspace_id = $1
       and (
         (
           $2::uuid is not null
           and exists (
             select 1
             from jsonb_array_elements_text(coalesce(d.rationale -> 'relatedFactIds', '[]'::jsonb)) fid
             join links l on l.workspace_id = d.workspace_id and l.id = fid::uuid
             where l.source_object_id = $2 or l.target_object_id = $2
           )
         )
         or ($3::text is not null and d.rationale ->> 'actionKind' = $3)
       )
     order by d.created_at desc, d.id desc
     limit $4`,
    [workspaceId, input.objectId ?? null, input.actionKindTag ?? null, limit],
  );
  return { items: result.rows.map(mapDecisionRow) };
}

// -------------------------------------------------------------------------------------------
// causal_chain
// -------------------------------------------------------------------------------------------

export const DEFAULT_CAUSAL_CHAIN_DEPTH = 3;
export const MAX_CAUSAL_CHAIN_DEPTH = 5;

export interface CausalChainInput {
  readonly factId?: string;
  readonly decisionId?: string;
  readonly depth?: number;
}

export interface CausalChainResult {
  readonly rootType: 'fact' | 'decision';
  readonly rootId: string;
  /** `explain()`'d, one entry per hop — see module doc comment ("via explain's data"). */
  readonly chain: readonly ExplainResult[];
  /** `true` when the walk stopped because `depth` was reached, not because there was nothing more
   *  upstream. */
  readonly truncated: boolean;
}

async function getFactSupersedesId(
  client: PoolClient,
  workspaceId: string,
  factId: string,
): Promise<string | null> {
  const result = await client.query<{ supersedes_id: string | null }>(
    'select supersedes_id from links where workspace_id = $1 and id = $2',
    [workspaceId, factId],
  );
  return result.rows[0]?.supersedes_id ?? null;
}

function clampDepth(depth: number | undefined): number {
  const resolved = depth ?? DEFAULT_CAUSAL_CHAIN_DEPTH;
  return Math.max(1, Math.min(resolved, MAX_CAUSAL_CHAIN_DEPTH));
}

/** Walks a Fact's `supersedes_id` history (I4/I5 — the closest thing to "upstream Facts consumed" a
 *  single Fact identity has on file) up to `depth` hops, `explain()`-ing each one. */
async function walkFactChain(
  client: PoolClient,
  workspaceId: string,
  factId: string,
  depth: number,
): Promise<{ chain: ExplainResult[]; truncated: boolean }> {
  const chain: ExplainResult[] = [];
  let currentId: string | null = factId;
  let truncated = false;
  for (let hop = 0; hop < depth && currentId; hop += 1) {
    const step = await explain(client, workspaceId, { factId: currentId });
    chain.push(step);
    const supersedesId = await getFactSupersedesId(client, workspaceId, currentId);
    if (supersedesId && hop === depth - 1) truncated = true;
    currentId = supersedesId;
  }
  return { chain, truncated };
}

/**
 * `factId` root: the Fact's own `supersedes_id` history. `decisionId` root: the Decision itself,
 * plus one `explain()` per Fact id its `rationale` names (each Fact's own single-hop identity, not
 * recursively expanded — see module doc comment on `rationale`'s limited structure) — `truncated`
 * is `true` there only if `rationale` names more Facts than fit in the remaining `depth` budget.
 */
export async function causalChain(
  client: PoolClient,
  workspaceId: string,
  input: CausalChainInput,
): Promise<CausalChainResult> {
  const depth = clampDepth(input.depth);

  if (input.factId) {
    const { chain, truncated } = await walkFactChain(client, workspaceId, input.factId, depth);
    return { rootType: 'fact', rootId: input.factId, chain, truncated };
  }

  const decisionId = input.decisionId;
  if (!decisionId) throw new Error('causal_chain: exactly one of factId/decisionId is required');

  const rootStep = await explain(client, workspaceId, { decisionId });
  const decisionRow = await getDecisionRow(client, workspaceId, decisionId);
  const relatedFactIds = extractFactIdsFromRationale(decisionRow.rationale);
  const budget = Math.max(0, depth - 1);
  const includedFactIds = relatedFactIds.slice(0, budget);

  const factSteps = await Promise.all(
    includedFactIds.map((factId) => explain(client, workspaceId, { factId })),
  );

  return {
    rootType: 'decision',
    rootId: decisionId,
    chain: [rootStep, ...factSteps],
    truncated: relatedFactIds.length > includedFactIds.length,
  };
}

// -------------------------------------------------------------------------------------------
// decision_impact
// -------------------------------------------------------------------------------------------

export interface ActionRequestRef {
  readonly id: string;
  readonly status: string;
  readonly actionKindTag: string;
  readonly gatekeeperId: string;
}

interface ActionRequestDbRow {
  id: string;
  status: string;
  action_kind: string;
  gatekeeper_id: string;
}

export interface DecisionImpactResult {
  readonly decisionId: string;
  /** Facts produced by the same Activity as this Decision, union'd with whatever Fact ids
   *  `rationale` names directly (module doc comment). */
  readonly facts: readonly FactRef[];
  /** `action_requests.approval_decision_id = decisionId` — the one real structural downstream FK a
   *  Decision has (`governance/approval/decide.ts`'s `writeApprovalDecision`,
   *  migrations/governance/0003_action_requests.sql). */
  readonly actionRequests: readonly ActionRequestRef[];
  /** `tasks.created_by_activity_id = decision.activityId`, union'd with `rationale.relatedTaskId`
   *  (`record_decision`) — ids only, not full Task objects: a caller that wants full Task detail
   *  already has `get_task` for that (keeps this capability's own footprint to what it uniquely
   *  provides — provenance linkage, not a Task projection this module does not own). */
  readonly taskIds: readonly string[];
}

/** Downstream impact of a Decision (design doc §9.3's `analyze_decision_impact` name mapping — see
 *  module doc comment). */
export async function decisionImpact(
  client: PoolClient,
  workspaceId: string,
  input: { readonly decisionId: string },
): Promise<DecisionImpactResult> {
  const decisionRow = await getDecisionRow(client, workspaceId, input.decisionId);
  const rationaleFactIds = extractFactIdsFromRationale(decisionRow.rationale);

  const [byActivityResult, byIdResult, actionRequestsResult, tasksByActivityResult] =
    await Promise.all([
      client.query<FactDbRow>(
        `select ${FACT_REF_COLUMNS} from links where workspace_id = $1 and activity_id = $2`,
        [workspaceId, decisionRow.activityId],
      ),
      rationaleFactIds.length > 0
        ? client.query<FactDbRow>(
            `select ${FACT_REF_COLUMNS} from links where workspace_id = $1 and id = any($2::uuid[])`,
            [workspaceId, rationaleFactIds],
          )
        : Promise.resolve({ rows: [] as FactDbRow[] }),
      client.query<ActionRequestDbRow>(
        `select id, status, action_kind, gatekeeper_id from action_requests
         where workspace_id = $1 and approval_decision_id = $2`,
        [workspaceId, input.decisionId],
      ),
      client.query<{ id: string }>(
        'select id from tasks where workspace_id = $1 and created_by_activity_id = $2',
        [workspaceId, decisionRow.activityId],
      ),
    ]);

  const factsById = new Map<string, FactRef>();
  for (const row of [...byActivityResult.rows, ...byIdResult.rows]) {
    factsById.set(row.id, mapFactRefRow(row));
  }

  const taskIds = new Set<string>(tasksByActivityResult.rows.map((row) => row.id));
  const rationale = decisionRow.rationale;
  if (rationale && typeof rationale.relatedTaskId === 'string')
    taskIds.add(rationale.relatedTaskId);

  return {
    decisionId: input.decisionId,
    facts: [...factsById.values()],
    actionRequests: actionRequestsResult.rows.map((row) => ({
      id: row.id,
      status: row.status,
      actionKindTag: row.action_kind,
      gatekeeperId: row.gatekeeper_id,
    })),
    taskIds: [...taskIds],
  };
}
