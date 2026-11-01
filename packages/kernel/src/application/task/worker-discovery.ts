import {
  type ObjectiveOutcome,
  type OutputSchema,
  StepOutputSchemaSchema,
  WORKER_HINT_MIN_SAMPLE,
  WORKER_HINT_WINDOW_DAYS,
  type WorkerGateAccessWire,
  type WorkerHintsWire,
  outcomeBasisTier,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type CapabilityScope,
  isExecuteClassCapability,
} from '../../governance/capability/index.js';
import { listGatekeepers } from '../../governance/gatekeepers/index.js';
import {
  type ObserveExclusions,
  observableGatekeeperIds,
  observeGateRefusal,
} from '../gates/index.js';
import { type SubjectOutcome, readSubjectOutcomes } from './stats-read.js';

/**
 * application/task/worker-discovery (S11 GO13; plan §4.12): what `find_workers` and the goal
 * planner's input say about a Worker beside its name — its contract, what it could do on each gate
 * it declares, and the hints read from its own Tasks (`@nexttime/shared` `wire/worker-discovery.ts`
 * states the rules). Reads only; decides nothing: which Worker a caller may delegate to stays
 * `computeChildHandleScope`'s (`handle-mint.ts`) and, for a goal step, `resolveStepAuthority`'s.
 */

/** A WorkerDefinition version. */
export interface WorkerRef {
  readonly definitionId: string;
  readonly version: number;
}

export function workerRefKey(ref: WorkerRef): string {
  return `${ref.definitionId}@${ref.version}`;
}

/** What a `worker` WorkerDefinition version declares as its contract. Its content was checked
 *  when proposed (`validateWorkerDefinitionContent`); a field that does not parse now (a stored
 *  value from before the field existed cannot, but the read does not assume it) is left out, never
 *  shown as if it were a contract. */
export interface WorkerContract {
  readonly inputSchema?: OutputSchema;
  readonly outputSchema?: OutputSchema;
}

export function workerContractOf(content: Readonly<Record<string, unknown>>): WorkerContract {
  const read = (value: unknown): OutputSchema | undefined => {
    if (value === undefined) return undefined;
    const parsed = StepOutputSchemaSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  const inputSchema = read(content.inputSchema);
  const outputSchema = read(content.outputSchema);
  return {
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

// ----- gate access ----------------------------------------------------------------------------

/** What deciding a Worker's gate access reads once per call: the workspace's gates and which of
 *  them have something anyone may observe, and the caller's observation exclusions. */
export interface GateAccessContext {
  readonly gateNames: ReadonlyMap<string, string>;
  readonly observable: ReadonlySet<string>;
  readonly exclusions: ObserveExclusions;
}

export async function readGateAccessContext(
  client: PoolClient,
  workspaceId: string,
  exclusions: ObserveExclusions,
): Promise<GateAccessContext> {
  // One client, one query at a time (pg rejects concurrent queries on a client).
  const gates = await listGatekeepers(client, workspaceId);
  const gateNames = new Map(gates.map((gate) => [gate.gatekeeperId, gate.name]));
  const observable = await observableGatekeeperIds(client, workspaceId, [...gateNames.keys()]);
  return { gateNames, observable, exclusions };
}

/**
 * Per gate a Worker declares, what a Worker of it delegated with `childScope` could do there:
 * `act` when its Handle carries the gate and an execute-class capability (it may request actions
 * there — the scope `computeChildHandleScope` worked out, never re-derived); otherwise `observe` or
 * `none` by the predicates enforcement uses — the gate is not here (`gate_not_enabled`), the
 * caller's exclusions leave it out (`observeGateRefusal`: a Task's observation scope, the
 * workspace's AgentPolicy cap, the member's AgentProfile), or nothing on it may be observed by
 * anyone (`observableGatekeeperIds`: no published observe-class Operation the platform lets
 * through — `no_observable_operation`).
 */
export function workerGateAccess(
  context: GateAccessContext,
  declaredGates: readonly string[],
  childScope: CapabilityScope,
): WorkerGateAccessWire[] {
  const carried = new Set(childScope.resources.gatekeeper ?? []);
  const executes = childScope.capabilities.some((name) => isExecuteClassCapability(name));
  return [...new Set(declaredGates)].map((gatekeeperId): WorkerGateAccessWire => {
    const name = context.gateNames.get(gatekeeperId) ?? null;
    if (name === null) {
      return { gatekeeperId, name, access: 'none', reason: 'gate_not_enabled' };
    }
    if (executes && carried.has(gatekeeperId)) return { gatekeeperId, name, access: 'act' };
    const refusal = observeGateRefusal(context.exclusions, gatekeeperId);
    if (refusal) return { gatekeeperId, name, access: 'none', reason: refusal.reason };
    if (!context.observable.has(gatekeeperId)) {
      return { gatekeeperId, name, access: 'none', reason: 'no_observable_operation' };
    }
    return { gatekeeperId, name, access: 'observe' };
  });
}

// ----- hints ------------------------------------------------------------------------------------

interface HintTaskRow {
  readonly id: string;
  readonly worker_definition_id: string;
  readonly worker_definition_version: number;
  readonly tokens_used: string | number;
  readonly created_by_activity_id: string | null;
  readonly goal_run_id: string | null;
  readonly step_run_id: string | null;
  readonly objective_outcome: ObjectiveOutcome | null;
  readonly outcome_given_at: Date | null;
}

/** The median of `values` (not empty). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Hints over no Task: nothing known. */
export function emptyWorkerHints(): WorkerHintsWire {
  return {
    windowDays: WORKER_HINT_WINDOW_DAYS,
    minSample: WORKER_HINT_MIN_SAMPLE,
    cost: { medianTokens: null, tasks: 0, sufficient: false },
    outcomes: { achieved: 0, total: 0, sufficient: false },
  };
}

/**
 * Each of `refs`' hints, keyed {@link workerRefKey} (the shared module comment): over the version's
 * own Tasks of ordinary work (`purpose` null) that completed or failed within the last
 * {@link WORKER_HINT_WINDOW_DAYS} days, the median of `tokens_used` and the primary outcomes given
 * on their work, each outcome subject once (`readSubjectOutcomes`, the rule `get_skill_stats`
 * counts by). Two queries for the Tasks and their outcomes whatever the number of refs. Every table
 * read is workspace-isolated only: numbers over the whole workspace's work, no id or text.
 */
export async function readWorkerHints(
  client: PoolClient,
  workspaceId: string,
  refs: readonly WorkerRef[],
  now: Date = new Date(),
): Promise<Map<string, WorkerHintsWire>> {
  const hints = new Map<string, WorkerHintsWire>();
  if (refs.length === 0) return hints;
  const since = new Date(now.getTime() - WORKER_HINT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const tasks = await client.query<HintTaskRow>(
    `select t.id, t.worker_definition_id, t.worker_definition_version, t.tokens_used,
            t.created_by_activity_id, t.goal_run_id, t.step_run_id, t.objective_outcome,
            t.outcome_given_at
       from tasks t
       join unnest($2::uuid[], $3::int[]) as ref(id, version)
         on t.worker_definition_id = ref.id and t.worker_definition_version = ref.version
      where t.workspace_id = $1 and t.purpose is null
        and t.status in ('completed', 'failed')
        and coalesce(t.completed_at, t.failed_at) >= $4`,
    [workspaceId, refs.map((ref) => ref.definitionId), refs.map((ref) => ref.version), since],
  );
  const subjectsByTask = await readSubjectOutcomes(client, workspaceId, tasks.rows);
  for (const ref of refs) {
    const key = workerRefKey(ref);
    if (hints.has(key)) continue;
    const own = tasks.rows.filter(
      (task) =>
        task.worker_definition_id === ref.definitionId &&
        task.worker_definition_version === ref.version,
    );
    const subjects = new Map<string, SubjectOutcome>();
    for (const task of own) {
      for (const [subject, outcome] of subjectsByTask.get(task.id) ?? []) {
        if (outcomeBasisTier(outcome.basis) === 'primary') subjects.set(subject, outcome);
      }
    }
    const given = [...subjects.values()];
    const costSufficient = own.length >= WORKER_HINT_MIN_SAMPLE;
    hints.set(key, {
      windowDays: WORKER_HINT_WINDOW_DAYS,
      minSample: WORKER_HINT_MIN_SAMPLE,
      cost: {
        medianTokens: costSufficient ? median(own.map((task) => Number(task.tokens_used))) : null,
        tasks: own.length,
        sufficient: costSufficient,
      },
      outcomes: {
        achieved: given.filter((outcome) => outcome.outcome === 'achieved').length,
        total: given.length,
        sufficient: given.length >= WORKER_HINT_MIN_SAMPLE,
      },
    });
  }
  return hints;
}
