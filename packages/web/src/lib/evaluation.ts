import {
  type EvalFixtureGateLiveState,
  type EvalFixtureOperationWire,
  type EvalSuiteChangeWire,
  type EvalSuiteSummaryWire,
  type EvalSuiteWire,
  visibleText,
} from '@nexttime/shared';
import { actionKindTagText } from './format.js';
import type { Translate } from './i18n.js';
import { type WorkerDefinitionSummary, distinctDefinitionName } from './tasks.js';

/**
 * lib/evaluation (S10 E3-1a): the data shaping behind 治理 → 评测's 用例集 pages — which Workers a
 * suite can pin (picked, never typed), what each change in a suite's history says, what a fixture
 * gate's live state asks of the reader, and what syncing one would change.
 *
 * A gate's, an Operation's and a Worker's name come from definitions a connector or an agent may
 * have written; every place these pages show one makes what a reader cannot see (a bidi override,
 * a zero-width or control character) visible as `\u{XXXX}` (legacy 232, #802 UX P2-1), so an
 * execute Operation never reads as another name.
 */

/** A gate's or a Worker's name as these pages show it (legacy 232). */
export function shownName(name: string): string {
  return visibleText(name);
}

export interface WorkerChoice {
  readonly id: string;
  /** Told apart from a same-named definition by its short id (`distinctDefinitionName`). */
  readonly name: string;
  /** Its published versions, newest first. */
  readonly versions: readonly number[];
}

/** The published worker-kind definitions a suite can pin, one per definition, by name. `rows` is
 *  `list_worker_definitions{kind:'worker'}` — published rows only, every version its own row. */
export function workerChoices(rows: readonly WorkerDefinitionSummary[]): readonly WorkerChoice[] {
  const published = rows.filter((row) => row.kind === 'worker' && row.status === 'published');
  const byId = new Map<string, number[]>();
  for (const row of published) byId.set(row.id, [...(byId.get(row.id) ?? []), row.version]);
  return [...byId.entries()]
    .map(([id, versions]) => {
      const newest = Math.max(...versions);
      return {
        id,
        name: shownName(distinctDefinitionName(published, id, newest) ?? id),
        versions: [...versions].sort((a, b) => b - a),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A suite's pinned Worker as one line: its name (when the directory has it) and version. */
export function pinnedWorkerName(
  rows: readonly WorkerDefinitionSummary[] | undefined,
  pin: EvalSuiteSummaryWire['workerDefinition'],
): string | undefined {
  const name = distinctDefinitionName(rows, pin.id, pin.version);
  return name === undefined ? undefined : shownName(name);
}

/** What `get_eval_suite` returns, as a list row (`list_eval_suites`' shape). */
export function suiteSummaryOf(suite: EvalSuiteWire): EvalSuiteSummaryWire {
  const { canary: _canary, fixtureGates: _gates, history: _history, ...summary } = suite;
  return summary;
}

/** One change in a suite's history, in a sentence (the version and who made it are shown beside
 *  it, the reason under it). */
export function suiteChangeText(change: EvalSuiteChangeWire, t: Translate): string {
  switch (change.kind) {
    case 'created': {
      const v = change.workerDefinitionVersion;
      return t(`新建用例集，钉住 Worker v${v}`, `Created the suite, pinning Worker v${v}`);
    }
    case 'repinned': {
      const [from, to] = [change.fromVersion, change.toVersion];
      return t(`钉住的 Worker 版本 v${from} → v${to}`, `Pinned Worker version v${from} → v${to}`);
    }
    case 'fixture_gate_added': {
      const gate = shownName(change.gateName);
      return t(`添加夹具门 ${gate}`, `Added fixture gate ${gate}`);
    }
    case 'fixture_gate_removed': {
      const gate = shownName(change.gateName);
      return t(`移除夹具门 ${gate}`, `Removed fixture gate ${gate}`);
    }
    case 'fixture_gate_synced': {
      const gate = shownName(change.gateName);
      const parts = operationDiffParts(change, t);
      return t(
        `同步夹具门 ${gate}${parts.length > 0 ? `：${parts.join('；')}` : ''}`,
        `Synced fixture gate ${gate}${parts.length > 0 ? `: ${parts.join('; ')}` : ''}`,
      );
    }
  }
}

export interface OperationDiff {
  readonly addedOperations: readonly string[];
  readonly removedOperations: readonly string[];
  readonly changedOperations: readonly string[];
}

/** 「新增 a、b」「移除 c」「变更 d」, the empty ones left out; each name as `actionKindTagText`
 *  shows it. */
export function operationDiffParts(diff: OperationDiff, t: Translate): readonly string[] {
  const list = (names: readonly string[]) => names.map(actionKindTagText).join(t('、', ', '));
  return [
    diff.addedOperations.length > 0
      ? t(`新增 ${list(diff.addedOperations)}`, `added ${list(diff.addedOperations)}`)
      : null,
    diff.removedOperations.length > 0
      ? t(`移除 ${list(diff.removedOperations)}`, `removed ${list(diff.removedOperations)}`)
      : null,
    diff.changedOperations.length > 0
      ? t(`变更 ${list(diff.changedOperations)}`, `changed ${list(diff.changedOperations)}`)
      : null,
  ].filter((part): part is string => part !== null);
}

/** What a sync would change, as far as the reader's `list_operations` shows the gate now: by name,
 *  another published version counts as changed (a published version's definition never changes,
 *  #765). The kernel computes the recorded diff itself when it syncs. */
export function syncPreview(
  frozen: readonly Pick<EvalFixtureOperationWire, 'name' | 'version'>[],
  publishedNow: readonly { readonly name: string; readonly version: number }[],
): OperationDiff {
  const before = new Map(frozen.map((op) => [op.name, op.version]));
  const after = new Map(publishedNow.map((op) => [op.name, op.version]));
  return {
    addedOperations: [...after.keys()].filter((name) => !before.has(name)).sort(),
    removedOperations: [...before.keys()].filter((name) => !after.has(name)).sort(),
    changedOperations: [...after.entries()]
      .filter(([name, version]) => before.has(name) && before.get(name) !== version)
      .map(([name]) => name)
      .sort(),
  };
}

/** What a fixture gate's live state asks of the reader; `null` when it still matches its gate. */
export function liveStateNotice(state: EvalFixtureGateLiveState, t: Translate): string | null {
  switch (state) {
    case 'same':
      return null;
    case 'changed':
      return t(
        '门的已发布操作在冻结之后变了。评测仍按冻结的定义作答；要按门现在的定义评测，点「同步」。',
        'The gate’s published operations changed after they were frozen. Evaluation still answers from the frozen definitions; to evaluate against the gate as it is now, sync it.',
      );
    case 'unavailable':
      return t(
        '这个门现在没有已发布的操作（或已不在工作区里），无法同步。评测仍按冻结的定义作答；不再需要它时可以移除。',
        'This gate has no published operation now (or is gone from the workspace), so it cannot be synced. Evaluation still answers from the frozen definitions; remove it when it is no longer needed.',
      );
  }
}
