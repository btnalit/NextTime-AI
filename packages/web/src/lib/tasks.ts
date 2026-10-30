import type {
  ObjectiveOutcomeWire,
  OutputSchema,
  RejectedOutputWire,
  ReworkOfWire,
  RunEnvironmentWire,
  SkillLoadWire,
  TaskPurpose,
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
  /** S11 W1a: what this run ran with — `null` (or absent, from a kernel that predates W1a) means
   *  未记录. Never the system prompt itself, only its digest. */
  readonly environment?: RunEnvironmentWire | null;
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
  /** S11 GO5d-1, for an attempt of a goal step: the output schema its result's `output` is held
   *  to, the last report that contract refused, and the earlier attempt this one redoes (one that
   *  ended without an accepted result). `null` = none; absent from a kernel that predates GO5d-1. */
  readonly outputSchema?: OutputSchema | null;
  readonly rejectedOutput?: RejectedOutputWire | null;
  readonly reworkOf?: ReworkOfWire | null;
  /** S11 GO11: the only gatekeepers this Task's Workers may read through, fixed at creation (`[]` =
   *  none). `null` = the Task sets no scope; absent from a kernel that predates GO11. */
  readonly observeScope?: readonly string[] | null;
  /** S10 E3-2a: what the Task is for when it is not ordinary work — `evaluation`, a trial of an
   *  evaluation case. `null` = ordinary work; absent from a kernel that predates E3-2a. */
  readonly purpose?: TaskPurpose | null;
}

/** `list_worker_definitions` row (`toWireWorkerDefinition`, handlers.ts) — only what the Tasks
 *  page reads: the id/version identity and the optional human `name` inside `definition`. */
export interface WorkerDefinitionSummary {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly status: string;
  readonly definition: Readonly<Record<string, unknown>>;
  /** When it was published (ISO); `null` for a draft. Absent where a caller built the row itself. */
  readonly publishedAt?: string | null;
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

/** What an unnamed definition is called: an entry definition is the entry agent's (legacy 472,
 *  not 「未命名」), any other reads as an unnamed one of its kind. */
export function unnamedDefinitionLabel(kind: string, t: Translate): string {
  return kind === 'entry'
    ? t('入口 agent', 'Entry agent')
    : `${t('未命名', 'Unnamed')} ${workerDefinitionKindLabel(kind, t)}`;
}

/** Ids of the definitions whose name another listed definition (a different id) also has —
 *  unnamed ones sharing their kind's label (legacy 472) count as the same name. */
export function sameNameDefinitionIds(
  definitions: readonly WorkerDefinitionSummary[],
): ReadonlySet<string> {
  const idsByLabel = new Map<string, Set<string>>();
  for (const row of definitions) {
    const label = workerNameOf(row) ?? `\u0000${row.kind}`;
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
        label: unnamedDefinitionLabel(row.kind, t),
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

/** A version picker's option text: the newest of several listed versions says so (legacy 481), so
 *  same-looking `v1`…`v4` read apart without opening each. `versions` is `definitionVersions`'
 *  newest-first list. */
export function versionOptionText(
  row: WorkerDefinitionSummary,
  versions: readonly WorkerDefinitionSummary[],
  t: Translate,
): string {
  return versions.length > 1 && versions[0]?.version === row.version
    ? t(`v${row.version}（最新）`, `v${row.version} (latest)`)
    : `v${row.version}`;
}

/** Legacy 481: the published entry version the entry agent runs with — the kernel's
 *  `getPublishedEntryDefinition` order (the most recently published entry row, then id, then
 *  version, each descending) over `rows`. Every published entry row stays `published` when a later
 *  one is published, so the status alone does not say which one is in use. `null` when no
 *  published entry row carries its publish time. */
export function inUseEntryVersion(
  rows: readonly WorkerDefinitionSummary[],
): { readonly definitionId: string; readonly version: number } | null {
  let best: WorkerDefinitionSummary | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.kind !== 'entry' || row.status !== 'published' || !row.publishedAt) continue;
    const at = Date.parse(row.publishedAt);
    if (Number.isNaN(at)) continue;
    const later =
      best === undefined ||
      at > bestAt ||
      (at === bestAt && (row.id > best.id || (row.id === best.id && row.version > best.version)));
    if (later) {
      best = row;
      bestAt = at;
    }
  }
  return best ? { definitionId: best.id, version: best.version } : null;
}

/** Legacy 481: for each Worker definition with more than one published version listed, its newest
 *  published version (the kernel's family head, `loadPublishedWorkerDefinitionHead`). Earlier
 *  published versions stay invocable by their own version; this only tells them apart. */
export function publishedFamilyHeads(
  rows: readonly WorkerDefinitionSummary[],
): ReadonlyMap<string, number> {
  const published = new Map<string, number[]>();
  for (const row of rows) {
    if (row.status !== 'published') continue;
    const versions = published.get(row.id) ?? [];
    if (!versions.includes(row.version)) versions.push(row.version);
    published.set(row.id, versions);
  }
  const heads = new Map<string, number>();
  for (const [id, versions] of published) {
    if (versions.length > 1) heads.set(id, Math.max(...versions));
  }
  return heads;
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
