import type { TaskStatus } from '@nexttime/shared';
import { TASK_EDGES, TASK_TRANSITIONS, canTransition } from '@nexttime/shared';

/**
 * lib/tasks: the wire shapes `list_tasks`/`get_task` return (`toWireTask`/`toWireWorkerRun`,
 * packages/kernel/src/application/gateway/handlers.ts) and the small pure helpers the Tasks page
 * derives from `@nexttime/shared`'s Task transition table — never from hand-typed status lists.
 */
export interface WorkerRunSummary {
  readonly id: string;
  readonly status: string;
  readonly containerId: string | null;
  readonly depth: number;
  readonly attempt: number;
  readonly startedAt: string;
  readonly terminatedAt: string | null;
}

export interface TaskSummary {
  readonly id: string;
  readonly status: string;
  readonly onBehalfOf: string;
  readonly workerDefinitionId: string;
  readonly workerDefinitionVersion: number;
  readonly input: unknown;
  readonly result: unknown;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly durationLimitSec: number | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly cancelledAt: string | null;
  readonly workerRuns: readonly WorkerRunSummary[];
}

/** `list_worker_definitions` row (`toWireWorkerDefinition`, handlers.ts) — only what the Tasks
 *  page reads: the id/version identity and the optional human `name` inside `definition`. */
export interface WorkerDefinitionSummary {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly status: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

/** A Task can be cancelled iff `TASK_TRANSITIONS` has a `cancel` edge out of its status. The
 *  kernel's `terminateTask` is idempotent on terminal statuses, but the UI follows the shared
 *  table so the button only appears where the domain says the transition exists. */
export function isCancellable(status: string): boolean {
  return canTransition(TASK_TRANSITIONS, status as TaskStatus, 'cancel');
}

/** Terminal = no outgoing edge in the shared table. */
export function isTerminalTaskStatus(status: string): boolean {
  return !TASK_EDGES.some((edge) => edge.from === status);
}

/** The instant a Task stopped, whichever way it stopped. */
export function taskFinishedAt(task: TaskSummary): string | null {
  return task.completedAt ?? task.failedAt ?? task.cancelledAt;
}

/** `invoke_worker`'s `input` is opaque JSON; the entry agent conventionally sends `{need}`. */
export function taskNeed(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['need', 'prompt', 'summary', 'task']) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return undefined;
}

/** The S2.9 result contract (`packages/shared/src/worker-result.ts` `WorkerResultContract`) as
 *  far as the page can tell without the Zod schema at runtime: an object with a string `summary`. */
export interface ResultContractView {
  readonly summary: string;
  readonly findings: readonly string[];
  readonly factsToAssert: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly artifacts: readonly { readonly path: string; readonly description?: string }[];
  readonly proposedOperations: readonly Record<string, unknown>[];
  readonly proposedSkill: unknown;
}

export function asResultContract(result: unknown): ResultContractView | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.summary !== 'string') return undefined;
  const arr = (value: unknown): readonly Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      : [];
  return {
    summary: record.summary,
    findings: Array.isArray(record.findings)
      ? record.findings.filter((item): item is string => typeof item === 'string')
      : [],
    factsToAssert: arr(record.factsToAssert),
    evidence: arr(record.evidence),
    artifacts: arr(record.artifacts).filter(
      (item): item is { path: string; description?: string } => typeof item.path === 'string',
    ),
    proposedOperations: arr(record.proposedOperations),
    proposedSkill: record.proposedSkill,
  };
}

export function definitionName(
  definitions: readonly WorkerDefinitionSummary[] | undefined,
  id: string,
  version: number,
): string | undefined {
  const match =
    definitions?.find((row) => row.id === id && row.version === version) ??
    definitions?.find((row) => row.id === id);
  const name = match?.definition.name;
  return typeof name === 'string' ? name : undefined;
}
