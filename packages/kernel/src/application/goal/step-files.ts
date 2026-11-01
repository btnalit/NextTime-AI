import type { PlanStep, StepFilesState } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type {
  TaskDirsKeepInput,
  TaskDirsKeepResult,
  TaskUpstreamFilesInput,
} from '../../adapters/supervisor-client/index.js';
import { readStepAttemptTask } from '../task/index.js';
import type { StepRunRow } from './types.js';

/**
 * application/goal/step-files (S11 GO14; s11-w2/go14-default-plan.md): the
 * files an attempt of a step reads — the handoff directories (`/workspace/out`) the Workers of the
 * steps its plan entry names in `filesFrom` left, mounted read-only at `/upstream/<step>`.
 *
 * Which directories (I-F1): for each named step, the Task of the accepted attempt of its live
 * StepRun in this goal run — the run's StepRuns read from the database at the start of every
 * attempt, the key resolved within this run only, never from a Worker's message. The plan checked
 * the names when it was accepted (`plan.ts` `filesFromProblems`): each is a step this one depends
 * on, so it has ended before this one is ready. One that was skipped, or did not succeed, left no
 * accepted files, and the attempt does not start (I-F6).
 *
 * Whether they are there: the kernel never touches a file (I-F4), so it asks the worker-supervisor
 * (`POST /task-dirs/keep`, the same call the retention lease makes), inside the advance — the
 * `modelCatalog` precedent: an answer it cannot get throws, and the advance with it. The
 * supervisor checks each directory against the reading Task's own workspace and goal run (its
 * `owner.json`) and the bind-source rules, and checks them again when it spawns (409
 * `upstream_unavailable`, a backstop: `spawn_failed`, transient). The advancer then (§2.3):
 *   - `kept` for every one — starts the attempt with them;
 *   - `running` for any — an upstream container that has not exited yet (seconds after its
 *     result): looks again shortly;
 *   - anything else — pauses the run for a person (`needs_decision`), naming the step, its attempt
 *     and why, without spending an attempt.
 */

/** What the advancer asks the worker-supervisor about a step's upstream directories (its
 *  `TaskSupervisorClientPort.keepTaskDirs`; absent: not known, and a step that reads files cannot
 *  start). */
export interface StepFilesPort {
  readonly keepTaskDirs?: (
    tasks: readonly TaskDirsKeepInput[],
  ) => Promise<readonly TaskDirsKeepResult[]>;
}

/** One upstream directory an attempt reads: the step, and its accepted attempt's Task. */
export interface StepFilesSource {
  readonly stepKey: string;
  readonly taskId: string;
  readonly attempt: number;
}

export type StepFilesSources =
  /** The step reads no files. */
  | { readonly kind: 'none' }
  | { readonly kind: 'sources'; readonly sources: readonly StepFilesSource[] }
  /** Why the attempt cannot start — the pause's detail. */
  | { readonly kind: 'blocked'; readonly detail: string };

/** What a person can do about a step whose files cannot be had: an ended step does not run
 *  again, so a revision adds one that makes the files anew and has the reader read that one's
 *  (`filesFrom` is a minor change, and the console's plan editor ticks it), or reads none. */
function remedy(readerKey: string): string {
  return `revise the plan: add a step that makes the files again and have step ${readerKey} read that step's instead (or none), or cancel`;
}

/** The directories `entry`'s attempt reads — see the module comment. `steps` are the run's
 *  StepRuns (superseded ones included); the one a name reads from is the live StepRun of its key. */
export async function resolveStepFilesSources(
  client: PoolClient,
  workspaceId: string,
  entry: PlanStep,
  steps: readonly StepRunRow[],
): Promise<StepFilesSources> {
  const filesFrom = entry.filesFrom ?? [];
  if (filesFrom.length === 0) return { kind: 'none' };
  const sources: StepFilesSource[] = [];
  for (const key of filesFrom) {
    const where = `step ${entry.key}: the files of step ${key}`;
    const from = steps.find((step) => step.stepKey === key && step.status !== 'superseded');
    if (!from || from.status !== 'succeeded') {
      return {
        kind: 'blocked',
        detail: `${where}: step ${key} ${from?.status === 'skipped' ? 'was skipped' : 'has not succeeded'}, so it left no files to read — ${remedy(entry.key)}`,
      };
    }
    const task = await readStepAttemptTask(client, workspaceId, from.id, from.attemptCount);
    if (!task || task.status !== 'completed') {
      return {
        kind: 'blocked',
        detail: `${where}: attempt ${from.attemptCount} of step ${key} has no completed Task — ${remedy(entry.key)}`,
      };
    }
    sources.push({ stepKey: key, taskId: task.id, attempt: from.attemptCount });
  }
  return { kind: 'sources', sources };
}

export type StepFilesCheck =
  /** Every directory is there: the attempt mounts these. */
  | { readonly kind: 'ready'; readonly upstream: readonly TaskUpstreamFilesInput[] }
  /** An upstream container has not exited yet: look again shortly. */
  | { readonly kind: 'wait' }
  | { readonly kind: 'blocked'; readonly detail: string; readonly state: StepFilesState };

/** Why a directory in `state` cannot be read, as a pause names it. */
function unavailableDetail(
  readerKey: string,
  source: StepFilesSource,
  state: Exclude<StepFilesState, 'kept' | 'running'>,
): string {
  const where = `step ${readerKey}: the files of step ${source.stepKey} (attempt ${source.attempt})`;
  switch (state) {
    case 'missing':
      return `${where} are no longer there — ${remedy(readerKey)}`;
    case 'not_owned':
      return `${where} are not marked as this goal run's, so they are not handed on — ${remedy(readerKey)}`;
    case 'not_a_directory':
      return `${where} cannot be handed on: its Worker replaced its handoff directory with something else — ${remedy(readerKey)}`;
  }
}

/**
 * Asks the worker-supervisor whether `sources`' directories can be mounted for an attempt of
 * `readerKey` in `goalRunId` (renewing them against the retention sweep). Throws when it cannot be
 * asked (no port, an unreachable supervisor, an answer that leaves one out): the advance fails and
 * is tried again, as when the model catalog cannot be read.
 */
export async function checkStepFiles(
  port: StepFilesPort | undefined,
  workspaceId: string,
  goalRunId: string,
  readerKey: string,
  sources: readonly StepFilesSource[],
): Promise<StepFilesCheck> {
  if (!port?.keepTaskDirs) {
    throw new Error(
      `step ${readerKey} reads the files of earlier steps, and the worker-supervisor cannot be asked whether they are there`,
    );
  }
  const answers = await port.keepTaskDirs(
    sources.map((source) => ({ taskId: source.taskId, workspaceId, goalRunId })),
  );
  const states = new Map(answers.map((answer) => [answer.taskId, answer.state]));
  let wait = false;
  for (const source of sources) {
    const state = states.get(source.taskId);
    if (state === undefined) {
      throw new Error(
        `the worker-supervisor did not answer for the files of step ${source.stepKey} (task ${source.taskId})`,
      );
    }
    if (state === 'kept') continue;
    if (state === 'running') {
      wait = true;
      continue;
    }
    return { kind: 'blocked', detail: unavailableDetail(readerKey, source, state), state };
  }
  if (wait) return { kind: 'wait' };
  return {
    kind: 'ready',
    upstream: sources.map((source) => ({ stepKey: source.stepKey, taskId: source.taskId })),
  };
}
