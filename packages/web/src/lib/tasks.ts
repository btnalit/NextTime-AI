import type {
  ObjectiveOutcomeWire,
  SkillLoadWire,
  TaskStatus,
  TurnAttributionWire,
} from '@nexttime/shared';
import { TASK_EDGES, TASK_TRANSITIONS, canTransition } from '@nexttime/shared';
import { shortId } from './format.js';
import type { Translate } from './i18n.js';
import { workerDefinitionKindLabel } from './labels.js';

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
  /** S10 E1: the Skill versions this run loaded — `null` (or absent, from a kernel that predates
   *  E1) means 未记录, `[]` means the run loaded none. */
  readonly skills?: readonly SkillLoadWire[] | null;
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
  /** S10 E1 结果归因 (`wire/attribution.ts`). `turnId` is the generating Turn (`null` for a Task
   *  started outside a Turn, or before Turns were recorded); `turn` is that Turn's attribution when
   *  the caller can see its Chat; `objectiveOutcome` is the Task's own outcome, reported by the
   *  delegating agent's verify step. All three absent from a kernel that predates E1. */
  readonly turnId?: string | null;
  readonly turn?: TurnAttributionWire | null;
  readonly objectiveOutcome?: ObjectiveOutcomeWire | null;
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

/** The routing marker the kernel puts in front of an entry-agent prompt
 *  (`<!--nexttime:turn_id=<id>-->`, see kernel `turn-started-consumer.ts`) — machine data, never
 *  part of what the person asked. */
const TURN_ID_MARKER = /^\s*<!--nexttime:[^>]*-->\s*/;

/** `invoke_worker`'s `input` is opaque JSON; the entry agent conventionally sends `{need}`, but
 *  real runs (audit R7 "行副标题直接显示原始 JSON 输入", #559 acceptance P2-2) have also sent
 *  `{intent}` and `{message}` (the person's own chat message, routing marker included) — all of
 *  them, plus the other conventional shapes below, are tried before falling back to a raw JSON
 *  excerpt (`TasksPage`'s own `taskNeed(...) ?? excerpt(...)`). The marker is stripped. */
export function taskNeed(input: unknown): string | undefined {
  const text = rawTaskNeed(input);
  if (text === undefined) return undefined;
  const stripped = text.replace(TURN_ID_MARKER, '').trim();
  return stripped === '' ? undefined : stripped;
}

function rawTaskNeed(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['need', 'intent', 'message', 'prompt', 'summary', 'task']) {
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
  readonly artifacts: readonly {
    readonly path: string;
    readonly description?: string;
    /** S8 W5-A (leftover 74): the artifact's own inlined text, when the Worker submitted one —
     *  `path` alone stops resolving to anything once the WorkerRun's container exits (see
     *  `packages/shared/src/worker-result.ts`'s own doc comment). `undefined` means "not
     *  retrievable", never "empty file". */
    readonly content?: string;
  }[];
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
    artifacts: arr(record.artifacts)
      .filter(
        (item): item is { path: string; description?: string; content?: string } =>
          typeof item.path === 'string',
      )
      .map((item) => ({
        path: item.path,
        description: typeof item.description === 'string' ? item.description : undefined,
        content: typeof item.content === 'string' ? item.content : undefined,
      })),
    proposedOperations: arr(record.proposedOperations),
    proposedSkill: record.proposedSkill,
  };
}

/** One Worker definition as a choice: its name, its version, and — only when another listed
 *  definition has the same name — its short id, so same-name Workers (a template instantiated
 *  twice gives two `ops-runner v1`) can be told apart (#541 acceptance P2, legacy 245). */
export interface WorkerDefinitionChoice {
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly distinguisher?: string;
}

const workerNameOf = (row: WorkerDefinitionSummary): string | undefined =>
  typeof row.definition.name === 'string' && row.definition.name !== ''
    ? row.definition.name
    : undefined;

/** Ids of the definitions whose name another listed definition (a different id) also has. */
export function sameNameDefinitionIds(
  definitions: readonly WorkerDefinitionSummary[],
): ReadonlySet<string> {
  const idsByLabel = new Map<string, Set<string>>();
  for (const row of definitions) {
    const label = workerNameOf(row);
    if (label === undefined) continue;
    idsByLabel.set(label, (idsByLabel.get(label) ?? new Set()).add(row.id));
  }
  return new Set([...idsByLabel.values()].filter((ids) => ids.size > 1).flatMap((ids) => [...ids]));
}

export function workerDefinitionChoices(
  definitions: readonly WorkerDefinitionSummary[],
  t: Translate,
): WorkerDefinitionChoice[] {
  const sameName = sameNameDefinitionIds(definitions);
  return definitions.map((row) => {
    const name = workerNameOf(row);
    // An unnamed definition (a member's own entry agent) reads as its kind, never as a bare
    // uuid (#559 acceptance P2-3); its short id always tells it apart.
    if (name === undefined) {
      return {
        id: row.id,
        label: `${t('未命名', 'Unnamed')} ${workerDefinitionKindLabel(row.kind, t)}`,
        version: `v${row.version}`,
        distinguisher: shortId(row.id),
      };
    }
    return {
      id: row.id,
      label: name,
      version: `v${row.version}`,
      ...(sameName.has(row.id) ? { distinguisher: shortId(row.id) } : {}),
    };
  });
}

/** Every listed version of one definition, newest first (`list_worker_definitions` returns each
 *  published version as its own row). */
export function definitionVersions(
  definitions: readonly WorkerDefinitionSummary[],
  id: string,
): WorkerDefinitionSummary[] {
  return definitions.filter((row) => row.id === id).sort((a, b) => b.version - a.version);
}

/** One row per definition id — its newest listed version — so a picker offers each Worker once
 *  and the version is chosen separately (field-inventory #26). */
export function latestPerDefinition(
  definitions: readonly WorkerDefinitionSummary[],
): WorkerDefinitionSummary[] {
  const latest = new Map<string, WorkerDefinitionSummary>();
  for (const row of definitions) {
    const seen = latest.get(row.id);
    if (seen === undefined || row.version > seen.version) latest.set(row.id, row);
  }
  return [...latest.values()];
}

/** `definitionName`, plus the short id when another listed definition (a different id) has the
 *  same name, so two `ops-runner` read apart wherever a Worker is named (#554 acceptance P2). */
export function distinctDefinitionName(
  definitions: readonly WorkerDefinitionSummary[] | undefined,
  id: string,
  version: number,
): string | undefined {
  const name = definitionName(definitions, id, version);
  if (name === undefined || definitions === undefined) return name;
  return sameNameDefinitionIds(definitions).has(id) ? `${name} · ${shortId(id)}` : name;
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
