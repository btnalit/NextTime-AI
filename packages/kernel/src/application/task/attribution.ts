import type { ObjectiveOutcome, TurnStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { LoadedSkillRef } from './definition-content.js';
import { readTaskRow } from './lifecycle.js';

/**
 * application/task/attribution: S10 E1 结果归因 (docs/s10-evolution-plan-2026-10-04.md §3.1–§3.4,
 * §5.3) — "which Skill / Procedure version did this work use, and did it achieve its goal".
 *
 * Three records, three kinds of knowledge (they are never merged into one status):
 *   - `worker_run_skills` (migrations/worker/0004) — a WorkerRun loaded these Skill versions.
 *     Authoritative: the kernel wrote it while creating the run (`spawn.ts`). Read here.
 *   - `turn_procedure_claims` (worker/0004) — the Turn's entry agent says it followed this
 *     Procedure version. A claim (`basis: 'claimed'`): the kernel cannot see what a model followed.
 *   - the objective outcome (task/0006) — `achieved` / `not_achieved`, apart from the execution
 *     status. On a Turn it is the requester's judgement (`turn_outcomes`, human channel); on a
 *     Task it is reported from a Procedure's `verify` step by the entry agent (`tasks.objective_*`).
 *
 * Outcome lifecycle (§3.4): `unknown → achieved | not_achieved`, then at most one correction by the
 * same giver, to the other value. Both writers below take the row lock first and decide from the
 * locked row, so two concurrent marks serialize; the CHECKs in task/0006 reject every shape this
 * module never writes.
 *
 * Every read here runs under the caller's own RLS: a Turn whose Chat the caller cannot see is
 * simply absent (`activities_visibility`), never reported as existing.
 */

// -------------------------------------------------------------------------------------------
// Records
// -------------------------------------------------------------------------------------------

/** Who the outcome is the judgement of — derived from the subject, never stored: a Turn's outcome
 *  has one write path, the requester's own `mark_turn_outcome` (human channel); a Task's has one,
 *  the delegating entry agent's `report_task_outcome` (Handle channel). `givenBy` is a principal
 *  either way — for `agent_reported` the human the agent acts on behalf of, not the human's
 *  own judgement. */
export type ObjectiveOutcomeBasis = 'requester' | 'agent_reported';

export interface ObjectiveOutcomeRecord {
  readonly basis: ObjectiveOutcomeBasis;
  readonly outcome: ObjectiveOutcome;
  readonly givenBy: string;
  readonly givenAt: Date;
  readonly revision: number;
  readonly previousOutcome: ObjectiveOutcome | null;
}

export interface SkillLoadRecord extends LoadedSkillRef {
  readonly name: string;
}

export interface ProcedureClaimRecord {
  readonly procedureId: string;
  readonly version: number;
  readonly name: string;
  readonly claimedAt: Date;
}

export interface TurnAttributionRecord {
  readonly id: string;
  readonly chatId: string | null;
  readonly status: TurnStatus;
  readonly startedBy: string | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly procedure: ProcedureClaimRecord | null;
  readonly outcome: ObjectiveOutcomeRecord | null;
}

// -------------------------------------------------------------------------------------------
// Errors — task-module classes, mapped by `instanceof` in the interfaces layer (the same
// convention `types.ts`'s `InvokeWorkerDefinitionNotEnabledError` documents for not importing
// `application/gateway`'s `ForbiddenError`).
// -------------------------------------------------------------------------------------------

/** The caller may see the Turn / Task but is not the one who may give its outcome (403). */
export class ObjectiveOutcomeForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectiveOutcomeForbiddenError';
  }
}

/** The subject's current state forbids the mark: the Turn / Task has not finished, or its one
 *  correction is already used (409). */
export class ObjectiveOutcomeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectiveOutcomeConflictError';
  }
}

// -------------------------------------------------------------------------------------------
// The one outcome transition, shared by Turn and Task
// -------------------------------------------------------------------------------------------

type OutcomeStep =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'first' }
  | { readonly kind: 'correct'; readonly previous: ObjectiveOutcome };

/** §3.4 as a pure decision over the locked current record: first mark, the one correction by the
 *  same giver, a repeat of the current value (no-op), or a refusal. */
export function decideOutcomeStep(
  current: ObjectiveOutcomeRecord | null,
  giver: string,
  next: ObjectiveOutcome,
  subject: string,
): OutcomeStep {
  if (current === null) return { kind: 'first' };
  if (current.outcome === next) return { kind: 'unchanged' };
  if (current.givenBy !== giver) {
    throw new ObjectiveOutcomeForbiddenError(
      `${subject}: its outcome was given by someone else; only they may correct it`,
    );
  }
  if (current.revision >= 2) {
    throw new ObjectiveOutcomeConflictError(
      `${subject}: its outcome was already corrected once; it cannot change again`,
    );
  }
  return { kind: 'correct', previous: current.outcome };
}

interface OutcomeDbRow {
  outcome: ObjectiveOutcome | null;
  given_by: string | null;
  given_at: Date | null;
  revision: number | null;
  previous_outcome: ObjectiveOutcome | null;
}

function mapOutcome(
  row: OutcomeDbRow,
  basis: ObjectiveOutcomeBasis,
): ObjectiveOutcomeRecord | null {
  if (row.outcome === null || row.given_by === null || row.given_at === null) return null;
  return {
    basis,
    outcome: row.outcome,
    givenBy: row.given_by,
    givenAt: row.given_at,
    revision: row.revision ?? 1,
    previousOutcome: row.previous_outcome,
  };
}

// -------------------------------------------------------------------------------------------
// Turn: read
// -------------------------------------------------------------------------------------------

interface TurnDbRow extends OutcomeDbRow {
  id: string;
  chat_id: string | null;
  status: TurnStatus;
  started_by: string | null;
  created_at: Date;
  ended_at: Date | null;
  procedure_id: string | null;
  procedure_version: number | null;
  procedure_name: string | null;
  claimed_at: Date | null;
}

const TURN_ATTRIBUTION_SELECT = `
  select a.id, a.chat_id, a.status, a.started_by, a.created_at, a.ended_at,
         c.procedure_id, c.procedure_version, c.claimed_at, p.name as procedure_name,
         o.outcome, o.given_by, o.given_at, o.revision, o.previous_outcome
  from activities a
  left join turn_procedure_claims c on c.workspace_id = a.workspace_id and c.turn_id = a.id
  left join procedures p
    on p.workspace_id = c.workspace_id and p.id = c.procedure_id and p.version = c.procedure_version
  left join turn_outcomes o on o.workspace_id = a.workspace_id and o.turn_id = a.id`;

function mapTurn(row: TurnDbRow): TurnAttributionRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    status: row.status,
    startedBy: row.started_by,
    startedAt: row.created_at,
    endedAt: row.ended_at,
    procedure:
      row.procedure_id !== null && row.procedure_version !== null && row.claimed_at !== null
        ? {
            procedureId: row.procedure_id,
            version: row.procedure_version,
            name: row.procedure_name ?? row.procedure_id,
            claimedAt: row.claimed_at,
          }
        : null,
    outcome: mapOutcome(row, 'requester'),
  };
}

/** The visible Turns among `turnIds`, keyed by id — an id the caller cannot see (another person's
 *  private Chat) or that is not a Turn is simply missing from the map. */
export async function readTurnAttributions(
  client: PoolClient,
  workspaceId: string,
  turnIds: readonly string[],
): Promise<ReadonlyMap<string, TurnAttributionRecord>> {
  if (turnIds.length === 0) return new Map();
  const result = await client.query<TurnDbRow>(
    `${TURN_ATTRIBUTION_SELECT}
     where a.workspace_id = $1 and a.kind = 'agent_turn' and a.id = any($2::uuid[])`,
    [workspaceId, [...new Set(turnIds)]],
  );
  return new Map(result.rows.map((row) => [row.id, mapTurn(row)]));
}

export const DEFAULT_LIST_CHAT_TURNS_LIMIT = 100;
export const MAX_LIST_CHAT_TURNS_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeTurnCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeTurnCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) return null;
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !UUID_PATTERN.test(id)) return null;
  return { createdAt, id };
}

export interface ChatTurnsPage {
  readonly items: readonly TurnAttributionRecord[];
  readonly nextCursor?: string;
}

/** `list_chat_turns`: one Chat's Turns, newest first, keyset-paginated on `(created_at, id)` — the
 *  same cursor shape `list_tasks` uses. The caller (gateway handler) checks the Chat is visible
 *  first (`requireChatAccess`); the Turns then follow the same RLS. */
export async function listChatTurns(
  client: PoolClient,
  workspaceId: string,
  chatId: string,
  filter: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<ChatTurnsPage> {
  const limit = Math.min(
    Math.max(filter.limit ?? DEFAULT_LIST_CHAT_TURNS_LIMIT, 1),
    MAX_LIST_CHAT_TURNS_LIMIT,
  );
  const cursor = decodeTurnCursor(filter.cursor);
  const result = await client.query<TurnDbRow>(
    `${TURN_ATTRIBUTION_SELECT}
     where a.workspace_id = $1 and a.chat_id = $2 and a.kind = 'agent_turn'
       and ($3::timestamptz is null
            or (date_trunc('milliseconds', a.created_at), a.id) < ($3::timestamptz, $4::uuid))
     order by date_trunc('milliseconds', a.created_at) desc, a.id desc
     limit $5`,
    [workspaceId, chatId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const rows = result.rows.map(mapTurn);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return rows.length > limit && last
    ? { items, nextCursor: encodeTurnCursor(last.startedAt, last.id) }
    : { items };
}

// -------------------------------------------------------------------------------------------
// Turn: mark_turn_outcome (human channel)
// -------------------------------------------------------------------------------------------

/**
 * The requester marks a finished Turn `achieved` / `not_achieved`. "Requester" = the principal
 * who sent the Turn's message (`activities.started_by`): in a workspace-visible Chat another member
 * can read the Turn but not judge it. A running Turn has no reply to judge yet (409). Returns
 * `undefined` when the Turn does not exist or is not visible — the handler turns that into the
 * same 404 an unknown id gets.
 */
export async function markTurnOutcome(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  turnId: string,
  outcome: ObjectiveOutcome,
): Promise<TurnAttributionRecord | undefined> {
  // Lock the Turn row (visible under RLS or not found) — serializes two marks of one Turn, and the
  // Turn's own status read below is the one the decision uses.
  const turn = await client.query<{ status: TurnStatus; started_by: string | null }>(
    `select status, started_by from activities
     where workspace_id = $1 and id = $2 and kind = 'agent_turn'
     for update`,
    [workspaceId, turnId],
  );
  const turnRow = turn.rows[0];
  if (!turnRow) return undefined;
  if (turnRow.started_by !== principalId) {
    throw new ObjectiveOutcomeForbiddenError(
      `Turn ${turnId}: only the person who sent its message may mark its outcome`,
    );
  }
  if (turnRow.status === 'running') {
    throw new ObjectiveOutcomeConflictError(
      `Turn ${turnId}: still running — mark its outcome once the reply has finished`,
    );
  }

  const existing = await client.query<OutcomeDbRow>(
    `select outcome, given_by, given_at, revision, previous_outcome
     from turn_outcomes where workspace_id = $1 and turn_id = $2`,
    [workspaceId, turnId],
  );
  const current = existing.rows[0] ? mapOutcome(existing.rows[0], 'requester') : null;
  const step = decideOutcomeStep(current, principalId, outcome, `Turn ${turnId}`);
  if (step.kind === 'first') {
    await client.query(
      `insert into turn_outcomes (workspace_id, turn_id, outcome, given_by)
       values ($1, $2, $3, $4)`,
      [workspaceId, turnId, outcome, principalId],
    );
  } else if (step.kind === 'correct') {
    await client.query(
      `update turn_outcomes
       set outcome = $3, previous_outcome = $4, revision = 2, given_at = now()
       where workspace_id = $1 and turn_id = $2`,
      [workspaceId, turnId, outcome, step.previous],
    );
  }

  const after = await readTurnAttributions(client, workspaceId, [turnId]);
  return after.get(turnId);
}

// -------------------------------------------------------------------------------------------
// Turn: record_procedure_followed (entry Handle)
// -------------------------------------------------------------------------------------------

/**
 * Records that `turnId` follows `procedureId@version` — only a **published** version (a draft is
 * its proposer's private object, I16, and `find_procedures` never returns one): `false` when there
 * is no such published version, which the handler reports as not found. The first claim of a Turn
 * stands (`on conflict do nothing`); the claim on record is returned either way.
 */
export async function recordProcedureFollowed(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  turnId: string,
  ref: { readonly procedureId: string; readonly version: number },
): Promise<ProcedureClaimRecord | false> {
  const published = await client.query(
    `select 1 from procedures
     where workspace_id = $1 and id = $2 and version = $3 and status = 'published'`,
    [workspaceId, ref.procedureId, ref.version],
  );
  if (published.rowCount === 0) return false;

  await client.query(
    `insert into turn_procedure_claims
       (workspace_id, turn_id, procedure_id, procedure_version, claimed_by)
     values ($1, $2, $3, $4, $5)
     on conflict (workspace_id, turn_id) do nothing`,
    [workspaceId, turnId, ref.procedureId, ref.version, principalId],
  );
  const claim = await client.query<{
    procedure_id: string;
    procedure_version: number;
    claimed_at: Date;
    name: string | null;
  }>(
    `select c.procedure_id, c.procedure_version, c.claimed_at, p.name
     from turn_procedure_claims c
     left join procedures p
       on p.workspace_id = c.workspace_id and p.id = c.procedure_id
      and p.version = c.procedure_version
     where c.workspace_id = $1 and c.turn_id = $2`,
    [workspaceId, turnId],
  );
  const row = claim.rows[0];
  if (!row) throw new Error('recordProcedureFollowed: claim row missing after insert');
  return {
    procedureId: row.procedure_id,
    version: row.procedure_version,
    name: row.name ?? row.procedure_id,
    claimedAt: row.claimed_at,
  };
}

// -------------------------------------------------------------------------------------------
// Task: report_task_outcome (entry Handle) and the Task read model
// -------------------------------------------------------------------------------------------

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * A Procedure's `verify` step reports whether a Task achieved its goal. Only for a Task acting for
 * the caller's own principal (I13: an entry Handle's `obo` is its user) — any other Task is
 * `undefined` (the handler's 404, exactly like an unknown id). Only once the Task has finished:
 * there is nothing to verify before that (409).
 */
export async function reportTaskOutcome(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  taskId: string,
  outcome: ObjectiveOutcome,
): Promise<ObjectiveOutcomeRecord | undefined> {
  const task = await readTaskRow(client, workspaceId, taskId);
  if (!task || task.onBehalfOf !== principalId) return undefined;

  const locked = await client.query<OutcomeDbRow & { status: string }>(
    `select status, objective_outcome as outcome, outcome_given_by as given_by,
            outcome_given_at as given_at, outcome_revision as revision,
            outcome_previous as previous_outcome
     from tasks where workspace_id = $1 and id = $2
     for update`,
    [workspaceId, taskId],
  );
  const row = locked.rows[0];
  if (!row) return undefined;
  if (!TERMINAL_TASK_STATUSES.has(row.status)) {
    throw new ObjectiveOutcomeConflictError(
      `Task ${taskId}: still ${row.status} — report its outcome once it has finished`,
    );
  }
  const current = mapOutcome(row, 'agent_reported');
  const step = decideOutcomeStep(current, principalId, outcome, `Task ${taskId}`);
  if (step.kind === 'unchanged' && current) return current;

  const updated = await client.query<OutcomeDbRow>(
    `update tasks
     set objective_outcome = $3,
         outcome_given_by = $4,
         outcome_given_at = now(),
         outcome_revision = $5,
         outcome_previous = $6,
         updated_at = now()
     where workspace_id = $1 and id = $2
     returning objective_outcome as outcome, outcome_given_by as given_by,
               outcome_given_at as given_at, outcome_revision as revision,
               outcome_previous as previous_outcome`,
    [
      workspaceId,
      taskId,
      outcome,
      principalId,
      step.kind === 'correct' ? 2 : 1,
      step.kind === 'correct' ? step.previous : null,
    ],
  );
  const written = updated.rows[0] ? mapOutcome(updated.rows[0], 'agent_reported') : null;
  if (!written) throw new Error('reportTaskOutcome: UPDATE ... RETURNING produced no row');
  return written;
}

/** Everything the Task read model adds for E1, batched over a page of Tasks. */
export interface TaskAttributions {
  /** Per WorkerRun: the Skills it loaded, or `null` when the run predates E1 (not recorded). */
  readonly skillsByRun: ReadonlyMap<string, readonly SkillLoadRecord[] | null>;
  readonly outcomeByTask: ReadonlyMap<string, ObjectiveOutcomeRecord | null>;
  /** The generating Turns visible to the caller. */
  readonly turns: ReadonlyMap<string, TurnAttributionRecord>;
}

export async function readTaskAttributions(
  client: PoolClient,
  workspaceId: string,
  tasks: readonly { readonly id: string; readonly createdByActivityId: string | null }[],
  workerRunIds: readonly string[],
): Promise<TaskAttributions> {
  const skillsByRun = new Map<string, SkillLoadRecord[] | null>();
  if (workerRunIds.length > 0) {
    const runs = await client.query<{ id: string; skills_recorded: boolean }>(
      'select id, skills_recorded from worker_runs where workspace_id = $1 and id = any($2::uuid[])',
      [workspaceId, workerRunIds],
    );
    for (const run of runs.rows) skillsByRun.set(run.id, run.skills_recorded ? [] : null);
    const loads = await client.query<{
      worker_run_id: string;
      skill_id: string;
      skill_version: number;
      name: string | null;
    }>(
      `select w.worker_run_id, w.skill_id, w.skill_version, s.name
       from worker_run_skills w
       left join skills s
         on s.workspace_id = w.workspace_id and s.id = w.skill_id and s.version = w.skill_version
       where w.workspace_id = $1 and w.worker_run_id = any($2::uuid[])
       order by s.name, w.skill_id`,
      [workspaceId, workerRunIds],
    );
    for (const load of loads.rows) {
      const bucket = skillsByRun.get(load.worker_run_id) ?? [];
      bucket.push({
        skillId: load.skill_id,
        version: load.skill_version,
        name: load.name ?? load.skill_id,
      });
      skillsByRun.set(load.worker_run_id, bucket);
    }
  }

  const outcomeByTask = new Map<string, ObjectiveOutcomeRecord | null>();
  if (tasks.length > 0) {
    const outcomes = await client.query<OutcomeDbRow & { id: string }>(
      `select id, objective_outcome as outcome, outcome_given_by as given_by,
              outcome_given_at as given_at, outcome_revision as revision,
              outcome_previous as previous_outcome
       from tasks where workspace_id = $1 and id = any($2::uuid[])`,
      [workspaceId, tasks.map((task) => task.id)],
    );
    for (const row of outcomes.rows) outcomeByTask.set(row.id, mapOutcome(row, 'agent_reported'));
  }

  const turnIds = tasks
    .map((task) => task.createdByActivityId)
    .filter((id): id is string => id !== null);
  const turns = await readTurnAttributions(client, workspaceId, turnIds);

  return { skillsByRun, outcomeByTask, turns };
}
