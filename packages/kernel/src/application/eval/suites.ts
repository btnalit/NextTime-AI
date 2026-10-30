import { randomBytes } from 'node:crypto';
import {
  EVAL_CASE_PARTITION_VALUES,
  EVAL_CASE_SPLIT_VALUES,
  type EvalCasePartition,
  type EvalCaseSplit,
  type EvalFixtureGateWire,
  type EvalSuiteChangeKind,
  type EvalSuiteChangeWire,
  type EvalSuiteSummaryWire,
  type EvalSuiteWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { ReviewedVersionChangedError } from '../../governance/capability/index.js';
import {
  refuseCredentialText,
  refuseRedactedText,
  shownFreeText,
} from '../../governance/redaction/index.js';
import { getWorkerDefinition } from '../worker/index.js';
import {
  type LiveGateSnapshots,
  caseSummaryWire,
  fixtureProblemsOf,
  readLiveCases,
} from './case-reads.js';
import {
  EvalFixtureGateInUseError,
  EvalSuiteInputError,
  EvalSuiteNameTakenError,
  EvalSuiteNotFoundError,
  EvalSuiteStateError,
} from './errors.js';
import {
  type FixtureGateSnapshot,
  diffSnapshots,
  fixtureOperationWire,
  liveStateOf,
  readGateSnapshot,
  snapshotDigest,
} from './snapshot.js';

/**
 * application/eval/suites: an evaluation suite's shell (S10 E3-1a) — creating one, the changes
 * that make each later version (repin, a fixture gate added, synced or removed) and the reads the
 * console shows (`list_eval_suites`, `get_eval_suite`, with the cases it holds in brief since
 * E3-1b). Tables: `eval_suites`, `eval_suite_changes`, `eval_fixture_gates` (migrations/worker/
 * 0007, whose guards refuse what this module never writes); the cases are `cases.ts`'s.
 *
 * Every change runs the same steps in the caller's transaction: hold the suite row
 * (`for update`), check it is at the version the person looked at (`ReviewedVersionChangedError`
 * otherwise), move it one version on, write what changed, and record the change at that version.
 * Free text (the name, the description, a reason) carrying a suspected credential or the masked
 * mark a read shows is refused before anything is written, and read back as every read shows free
 * text (`shownFreeText`).
 */

export interface EvalSuiteActor {
  /** The person making the change (`actsForPerson`: the registry refuses anyone else). */
  readonly principalId: string;
}

interface SuiteRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly worker_definition_id: string;
  readonly worker_definition_version: number;
  readonly canary: string;
  readonly version: number;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const SUITE_COLUMNS = `id, name, description, worker_definition_id, worker_definition_version, canary,
  version, created_by, created_at, updated_at`;

interface FixtureGateRow {
  readonly id: string;
  readonly suite_id: string;
  readonly gatekeeper_id: string;
  readonly snapshot: FixtureGateSnapshot;
  readonly snapshot_digest: string;
  readonly added_in_version: number;
  readonly created_by: string;
  readonly created_at: Date;
}

const FIXTURE_GATE_COLUMNS = `id, suite_id, gatekeeper_id, snapshot, snapshot_digest,
  added_in_version, created_by, created_at`;

interface ChangeRow {
  readonly version: number;
  readonly kind: EvalSuiteChangeKind;
  readonly actor_id: string;
  readonly reason: string | null;
  readonly detail: Record<string, unknown>;
  readonly created_at: Date;
}

// -------------------------------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------------------------------

/** Every suite of the workspace, by name. */
export async function listEvalSuites(
  client: PoolClient,
  workspaceId: string,
): Promise<EvalSuiteSummaryWire[]> {
  const suites = await client.query<SuiteRow>(
    `select ${SUITE_COLUMNS} from eval_suites where workspace_id = $1
      order by lower(name), created_at`,
    [workspaceId],
  );
  const gates = await client.query<FixtureGateRow>(
    `select ${FIXTURE_GATE_COLUMNS} from eval_fixture_gates
      where workspace_id = $1 and retired_in_version is null`,
    [workspaceId],
  );
  const cases = await readLiveCases(client, workspaceId);
  const live = liveSnapshots(client, workspaceId);
  const summaries: EvalSuiteSummaryWire[] = [];
  for (const suite of suites.rows) {
    const own = gates.rows.filter((gate) => gate.suite_id === suite.id);
    let needingAttention = 0;
    for (const gate of own) {
      const current = await live(gate.gatekeeper_id);
      if (liveStateOf(gate.snapshot_digest, current) !== 'same') needingAttention += 1;
    }
    const frozen: LiveGateSnapshots = new Map(
      own.map((gate) => [gate.gatekeeper_id, gate.snapshot]),
    );
    const ownCases = cases.filter((row) => row.suite_id === suite.id);
    summaries.push(
      await summaryOf(client, workspaceId, suite, {
        fixtureGateCount: own.length,
        fixtureGatesNeedingAttention: needingAttention,
        caseCount: ownCases.length,
        casesNeedingAttention: ownCases.filter(
          (row) => fixtureProblemsOf(row.fixture_refs, frozen).length > 0,
        ).length,
      }),
    );
  }
  return summaries;
}

/** One suite whole: its fixture gates with their live state, its cases in brief, its canary and
 *  its history. */
export async function getEvalSuite(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
): Promise<EvalSuiteWire> {
  const suite = await readSuite(client, workspaceId, suiteId, false);
  const gates = await client.query<FixtureGateRow>(
    `select ${FIXTURE_GATE_COLUMNS} from eval_fixture_gates
      where workspace_id = $1 and suite_id = $2 and retired_in_version is null
      order by added_in_version, gatekeeper_id`,
    [workspaceId, suiteId],
  );
  const live = liveSnapshots(client, workspaceId);
  const fixtureGates: EvalFixtureGateWire[] = [];
  for (const gate of gates.rows) {
    fixtureGates.push({
      gatekeeperId: gate.gatekeeper_id,
      gateName: gate.snapshot.gateName,
      operations: gate.snapshot.operations.map(fixtureOperationWire),
      snapshotDigest: gate.snapshot_digest,
      addedInVersion: gate.added_in_version,
      addedBy: gate.created_by,
      addedAt: gate.created_at.toISOString(),
      liveState: liveStateOf(gate.snapshot_digest, await live(gate.gatekeeper_id)),
    });
  }
  const frozen: LiveGateSnapshots = new Map(
    gates.rows.map((gate) => [gate.gatekeeper_id, gate.snapshot]),
  );
  const cases = (await readLiveCases(client, workspaceId, suiteId)).map((row) =>
    caseSummaryWire(row, frozen),
  );
  const changes = await client.query<ChangeRow>(
    `select version, kind, actor_id, reason, detail, created_at from eval_suite_changes
      where workspace_id = $1 and suite_id = $2 order by version desc`,
    [workspaceId, suiteId],
  );
  const summary = await summaryOf(client, workspaceId, suite, {
    fixtureGateCount: fixtureGates.length,
    fixtureGatesNeedingAttention: fixtureGates.filter((gate) => gate.liveState !== 'same').length,
    caseCount: cases.length,
    casesNeedingAttention: cases.filter((row) => row.fixtureProblems.length > 0).length,
  });
  return {
    ...summary,
    canary: suite.canary,
    fixtureGates,
    cases,
    history: changes.rows.map(changeWire),
  };
}

// -------------------------------------------------------------------------------------------
// Changes
// -------------------------------------------------------------------------------------------

export interface CreateEvalSuiteInput {
  readonly name: string;
  readonly description?: string;
  readonly workerDefinitionId: string;
  readonly workerDefinitionVersion: number;
}

/** A new suite at version 1, pinning a published worker-kind WorkerDefinition version. */
export async function createEvalSuite(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  input: CreateEvalSuiteInput,
): Promise<EvalSuiteWire> {
  const name = input.name.trim();
  const description = input.description?.trim() ?? '';
  refuseCredentialText('name', name);
  refuseRedactedText('name', name);
  refuseCredentialText('description', description);
  refuseRedactedText('description', description);
  await requirePinnable(
    client,
    workspaceId,
    input.workerDefinitionId,
    input.workerDefinitionVersion,
  );

  const taken = await client.query(
    'select 1 from eval_suites where workspace_id = $1 and lower(btrim(name)) = lower(btrim($2))',
    [workspaceId, name],
  );
  if (taken.rowCount !== 0) throw new EvalSuiteNameTakenError(shownFreeText(name));

  let suiteId: string;
  try {
    const inserted = await client.query<{ id: string }>(
      `insert into eval_suites
         (workspace_id, name, description, worker_definition_id, worker_definition_version, canary,
          created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        workspaceId,
        name,
        description,
        input.workerDefinitionId,
        input.workerDefinitionVersion,
        newCanary(),
        actor.principalId,
      ],
    );
    suiteId = inserted.rows[0]?.id as string;
  } catch (err) {
    if (isUniqueViolation(err, 'eval_suites_name_unique')) {
      throw new EvalSuiteNameTakenError(shownFreeText(name));
    }
    throw err;
  }
  await recordChange(client, workspaceId, suiteId, 1, actor, 'created', null, {
    workerDefinitionVersion: input.workerDefinitionVersion,
  });
  return getEvalSuite(client, workspaceId, suiteId);
}

export interface EvalSuiteChangeTarget {
  readonly suiteId: string;
  /** The suite version the person looked at. */
  readonly suiteVersion: number;
}

/** Pins another published version of the suite's WorkerDefinition. */
export async function repinEvalSuite(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: EvalSuiteChangeTarget & {
    readonly workerDefinitionVersion: number;
    readonly reason?: string;
  },
): Promise<EvalSuiteWire> {
  const reason = checkedReason(target.reason);
  const suite = await holdSuiteAt(client, workspaceId, 'repin_eval_suite', target);
  if (suite.worker_definition_version === target.workerDefinitionVersion) {
    throw new EvalSuiteStateError(
      `the suite already pins version ${target.workerDefinitionVersion} — nothing was changed`,
    );
  }
  await requirePinnable(
    client,
    workspaceId,
    suite.worker_definition_id,
    target.workerDefinitionVersion,
  );
  const version = await nextVersion(client, workspaceId, suite.id, target.workerDefinitionVersion);
  await recordChange(client, workspaceId, suite.id, version, actor, 'repinned', reason, {
    fromVersion: suite.worker_definition_version,
    toVersion: target.workerDefinitionVersion,
  });
  return getEvalSuite(client, workspaceId, suite.id);
}

export interface FixtureGateTarget extends EvalSuiteChangeTarget {
  readonly gatekeeperId: string;
}

/** Freezes one of the workspace's gates into the suite as a fixture gate. */
export async function addEvalFixtureGate(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: FixtureGateTarget,
): Promise<EvalSuiteWire> {
  const suite = await holdSuiteAt(client, workspaceId, 'add_eval_fixture_gate', target);
  if ((await liveFixtureGate(client, workspaceId, suite.id, target.gatekeeperId)) !== null) {
    throw new EvalSuiteStateError(
      `the suite already has gate ${target.gatekeeperId} as a fixture gate — sync it instead`,
    );
  }
  const snapshot = await requireSnapshot(client, workspaceId, target.gatekeeperId);
  const version = await nextVersion(client, workspaceId, suite.id);
  const digest = snapshotDigest(snapshot);
  await insertFixtureGate(client, workspaceId, suite.id, target.gatekeeperId, snapshot, version, {
    actor,
    supersedes: null,
  });
  await recordChange(client, workspaceId, suite.id, version, actor, 'fixture_gate_added', null, {
    gatekeeperId: target.gatekeeperId,
    gateName: snapshot.gateName,
    snapshotDigest: digest,
  });
  return getEvalSuite(client, workspaceId, suite.id);
}

/** Freezes a fixture gate again from the gate's published Operations now. */
export async function syncEvalFixtureGate(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: FixtureGateTarget,
): Promise<EvalSuiteWire> {
  const suite = await holdSuiteAt(client, workspaceId, 'sync_eval_fixture_gate', target);
  const current = await liveFixtureGate(client, workspaceId, suite.id, target.gatekeeperId);
  if (current === null) {
    throw new EvalSuiteStateError(`the suite has no fixture gate ${target.gatekeeperId}`);
  }
  const snapshot = await requireSnapshot(client, workspaceId, target.gatekeeperId);
  const digest = snapshotDigest(snapshot);
  if (digest === current.snapshot_digest) {
    throw new EvalSuiteStateError(
      `fixture gate "${current.snapshot.gateName}" still matches the gate — nothing to sync`,
    );
  }
  const version = await nextVersion(client, workspaceId, suite.id);
  await retireFixtureGate(client, workspaceId, current.id, version);
  await insertFixtureGate(client, workspaceId, suite.id, target.gatekeeperId, snapshot, version, {
    actor,
    supersedes: current.id,
  });
  await recordChange(client, workspaceId, suite.id, version, actor, 'fixture_gate_synced', null, {
    gatekeeperId: target.gatekeeperId,
    gateName: snapshot.gateName,
    fromDigest: current.snapshot_digest,
    toDigest: digest,
    ...diffSnapshots(current.snapshot, snapshot),
  });
  return getEvalSuite(client, workspaceId, suite.id);
}

/** Takes a fixture gate out of the suite from the next version on, with a reason. */
export async function removeEvalFixtureGate(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: FixtureGateTarget & { readonly reason: string },
): Promise<EvalSuiteWire> {
  const reason = checkedReason(target.reason);
  const suite = await holdSuiteAt(client, workspaceId, 'remove_eval_fixture_gate', target);
  const current = await liveFixtureGate(client, workspaceId, suite.id, target.gatekeeperId);
  if (current === null) {
    throw new EvalSuiteStateError(`the suite has no fixture gate ${target.gatekeeperId}`);
  }
  // E3-1b: a case the suite holds answers calls through it — removing it would leave those rules
  // answering nothing. The person edits or retires the cases first (each its own version).
  const using = await client.query<{ id: string; title: string }>(
    `select id, title from eval_cases
      where workspace_id = $1 and suite_id = $2 and retired_in_version is null
        and fixtures @> $3::jsonb
      order by added_in_version, created_at, id`,
    [workspaceId, suite.id, JSON.stringify([{ gatekeeperId: target.gatekeeperId }])],
  );
  if (using.rows.length > 0) {
    throw new EvalFixtureGateInUseError(
      current.snapshot.gateName,
      using.rows.map((row) => ({ id: row.id, title: shownFreeText(row.title) })),
    );
  }
  const version = await nextVersion(client, workspaceId, suite.id);
  await retireFixtureGate(client, workspaceId, current.id, version);
  await recordChange(
    client,
    workspaceId,
    suite.id,
    version,
    actor,
    'fixture_gate_removed',
    reason,
    {
      gatekeeperId: target.gatekeeperId,
      gateName: current.snapshot.gateName,
      snapshotDigest: current.snapshot_digest,
    },
  );
  return getEvalSuite(client, workspaceId, suite.id);
}

// -------------------------------------------------------------------------------------------
// Internals (the ones exported serve `cases.ts`, never `index.ts`)
// -------------------------------------------------------------------------------------------

export async function readSuite(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  forUpdate: boolean,
): Promise<SuiteRow> {
  const result = await client.query<SuiteRow>(
    `select ${SUITE_COLUMNS} from eval_suites where workspace_id = $1 and id = $2${forUpdate ? ' for update' : ''}`,
    [workspaceId, suiteId],
  );
  const suite = result.rows[0];
  if (!suite) throw new EvalSuiteNotFoundError(suiteId);
  return suite;
}

/** The suite row, held for this transaction, at the version the person looked at. */
export async function holdSuiteAt(
  client: PoolClient,
  workspaceId: string,
  action: string,
  target: EvalSuiteChangeTarget,
): Promise<SuiteRow> {
  const suite = await readSuite(client, workspaceId, target.suiteId, true);
  if (suite.version !== target.suiteVersion) {
    throw new ReviewedVersionChangedError(
      action,
      `evaluation suite "${shownFreeText(suite.name)}"`,
      target.suiteVersion,
      suite.version,
    );
  }
  return suite;
}

/** Moves the held suite one version on (and to another pinned version, when given). */
export async function nextVersion(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  workerDefinitionVersion?: number,
): Promise<number> {
  const result = await client.query<{ version: number }>(
    `update eval_suites
        set version = version + 1, updated_at = now(),
            worker_definition_version = coalesce($3, worker_definition_version)
      where workspace_id = $1 and id = $2
      returning version`,
    [workspaceId, suiteId, workerDefinitionVersion ?? null],
  );
  return result.rows[0]?.version as number;
}

export async function recordChange(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  version: number,
  actor: EvalSuiteActor,
  kind: EvalSuiteChangeKind,
  reason: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into eval_suite_changes (workspace_id, suite_id, version, kind, actor_id, reason, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [workspaceId, suiteId, version, kind, actor.principalId, reason, detail],
  );
}

async function liveFixtureGate(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  gatekeeperId: string,
): Promise<FixtureGateRow | null> {
  const result = await client.query<FixtureGateRow>(
    `select ${FIXTURE_GATE_COLUMNS} from eval_fixture_gates
      where workspace_id = $1 and suite_id = $2 and gatekeeper_id = $3
        and retired_in_version is null`,
    [workspaceId, suiteId, gatekeeperId],
  );
  return result.rows[0] ?? null;
}

async function insertFixtureGate(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  gatekeeperId: string,
  snapshot: FixtureGateSnapshot,
  version: number,
  how: { readonly actor: EvalSuiteActor; readonly supersedes: string | null },
): Promise<void> {
  await client.query(
    `insert into eval_fixture_gates
       (workspace_id, suite_id, gatekeeper_id, snapshot, snapshot_digest, added_in_version,
        supersedes, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      workspaceId,
      suiteId,
      gatekeeperId,
      snapshot,
      snapshotDigest(snapshot),
      version,
      how.supersedes,
      how.actor.principalId,
    ],
  );
}

async function retireFixtureGate(
  client: PoolClient,
  workspaceId: string,
  fixtureGateId: string,
  version: number,
): Promise<void> {
  await client.query(
    'update eval_fixture_gates set retired_in_version = $3 where workspace_id = $1 and id = $2',
    [workspaceId, fixtureGateId, version],
  );
}

/** The gate's snapshot now, refused when there is nothing to freeze. */
async function requireSnapshot(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<FixtureGateSnapshot> {
  const snapshot = await readGateSnapshot(client, workspaceId, gatekeeperId);
  if (snapshot === null) {
    throw new EvalSuiteInputError(
      `gate ${gatekeeperId} is not one of this workspace's gates, or publishes no Operation — there is nothing to freeze`,
    );
  }
  return snapshot;
}

/** A suite pins a published worker-kind version (the database checks it too). */
async function requirePinnable(
  client: PoolClient,
  workspaceId: string,
  definitionId: string,
  version: number,
): Promise<void> {
  const row = await getWorkerDefinition(client, workspaceId, { definitionId, version });
  if (row === null || row.kind !== 'worker' || row.status !== 'published') {
    throw new EvalSuiteInputError(
      `WorkerDefinition ${definitionId} version ${version} is not a published worker-kind version — a suite pins one`,
    );
  }
}

/** Gate snapshots read once per gate per call. */
function liveSnapshots(
  client: PoolClient,
  workspaceId: string,
): (gatekeeperId: string) => Promise<FixtureGateSnapshot | null> {
  const cache = new Map<string, FixtureGateSnapshot | null>();
  return async (gatekeeperId) => {
    if (!cache.has(gatekeeperId)) {
      cache.set(gatekeeperId, await readGateSnapshot(client, workspaceId, gatekeeperId));
    }
    return cache.get(gatekeeperId) ?? null;
  };
}

interface SuiteCounts {
  readonly fixtureGateCount: number;
  readonly fixtureGatesNeedingAttention: number;
  readonly caseCount: number;
  readonly casesNeedingAttention: number;
}

async function summaryOf(
  client: PoolClient,
  workspaceId: string,
  suite: SuiteRow,
  counts: SuiteCounts,
): Promise<EvalSuiteSummaryWire> {
  const pinned = await getWorkerDefinition(client, workspaceId, {
    definitionId: suite.worker_definition_id,
    version: suite.worker_definition_version,
  });
  return {
    id: suite.id,
    name: shownFreeText(suite.name),
    description: shownFreeText(suite.description),
    workerDefinition: {
      id: suite.worker_definition_id,
      version: suite.worker_definition_version,
      // The foreign key keeps the row; a pinned version is published or, since, deprecated.
      status: pinned?.status ?? 'published',
    },
    version: suite.version,
    ...counts,
    createdBy: suite.created_by,
    createdAt: suite.created_at.toISOString(),
    updatedAt: suite.updated_at.toISOString(),
  };
}

function changeWire(row: ChangeRow): EvalSuiteChangeWire {
  const base = {
    version: row.version,
    actorId: row.actor_id,
    reason: row.reason === null ? null : shownFreeText(row.reason),
    createdAt: row.created_at.toISOString(),
  };
  const detail = row.detail;
  const text = (key: string): string => (typeof detail[key] === 'string' ? detail[key] : '');
  const count = (key: string): number => (typeof detail[key] === 'number' ? detail[key] : 1);
  const names = (key: string): string[] =>
    Array.isArray(detail[key])
      ? (detail[key] as unknown[]).filter((n) => typeof n === 'string')
      : [];
  switch (row.kind) {
    case 'created':
      return {
        ...base,
        kind: 'created',
        workerDefinitionVersion: count('workerDefinitionVersion'),
      };
    case 'repinned':
      return {
        ...base,
        kind: 'repinned',
        fromVersion: count('fromVersion'),
        toVersion: count('toVersion'),
      };
    case 'fixture_gate_added':
    case 'fixture_gate_removed':
      return {
        ...base,
        kind: row.kind,
        gatekeeperId: text('gatekeeperId'),
        gateName: text('gateName'),
      };
    case 'fixture_gate_synced':
      return {
        ...base,
        kind: 'fixture_gate_synced',
        gatekeeperId: text('gatekeeperId'),
        gateName: text('gateName'),
        addedOperations: names('addedOperations'),
        removedOperations: names('removedOperations'),
        changedOperations: names('changedOperations'),
      };
    case 'case_added':
    case 'case_retired':
      return { ...base, kind: row.kind, ...caseOf(detail) };
    case 'case_edited':
      return { ...base, kind: 'case_edited', ...caseOf(detail), supersedes: text('supersedes') };
  }
}

/** A case change's detail (`cases.ts` writes it): the case row, its title then, its partition and
 *  split. */
function caseOf(detail: Record<string, unknown>): {
  caseId: string;
  title: string;
  partition: EvalCasePartition;
  split: EvalCaseSplit;
} {
  const partition = EVAL_CASE_PARTITION_VALUES.find((value) => value === detail.partition);
  const split = EVAL_CASE_SPLIT_VALUES.find((value) => value === detail.split);
  return {
    caseId: typeof detail.caseId === 'string' ? detail.caseId : '',
    title: typeof detail.title === 'string' ? shownFreeText(detail.title) : '',
    partition: partition ?? 'full',
    split: split ?? 'holdout',
  };
}

export function checkedReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const trimmed = reason.trim();
  refuseCredentialText('reason', trimmed);
  refuseRedactedText('reason', trimmed);
  return trimmed;
}

function newCanary(): string {
  return `NTEVAL-${randomBytes(16).toString('hex')}`;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const candidate = err as { code?: unknown; constraint?: unknown } | null;
  return candidate?.code === '23505' && candidate.constraint === constraint;
}
