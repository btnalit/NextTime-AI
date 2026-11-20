import type {
  ExecutionReadinessMissingWire,
  ExecutionReadinessWire,
  ExecutionReadinessWorkerWire,
} from '@nexttime/shared';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Notice } from '../kit/notice.js';
import { FixHint, useReadinessReader } from '../readiness/FixHint.js';
import {
  missingAsk,
  missingCauseText,
  missingKey,
  missingLinkHref,
  missingLinkLabel,
} from '../readiness/readiness-copy.js';
import { useExecutionReadiness } from '../readiness/useExecutionReadiness.js';

type GapCode = 'no_grant' | 'excluded_by_policy' | 'excluded_by_profile';

/** Legacy 633: how one published Worker version stands for the reader's own entry agent. */
export interface WorkerGateGaps {
  /** Whether `invoke_worker` on this version would go through for the reader's entry agent. */
  readonly delegable: boolean;
  /** Each declared gate outside the entry agent's gate scope, by why: never granted, granted but
   *  left out by the workspace policy's cap, or unticked on 我的智能体 — the same three causes the
   *  kernel's `execution_readiness` names (`gateGap`). Such a gate is dropped from the Worker's
   *  Handle when it is delegated, or, for a Worker that needs to act, refuses the delegation. */
  readonly gates: ReadonlyMap<string, GapCode>;
  /** What stops the delegation, from `blockedBy` (empty when `delegable`): the Worker itself
   *  unticked on 我的智能体, a gate it needs to act on, or an act no gate grant allows. UX
   *  acceptance of #1523 P2-1: listed first, apart from the gates that only go missing. */
  readonly blocking: readonly ExecutionReadinessMissingWire[];
  /** The declared gates the delegated Worker would go without, one line each — every gap above
   *  that is not already in `blocking`. */
  readonly unusable: readonly ExecutionReadinessMissingWire[];
  readonly gateNames: ReadonlyMap<string, string>;
}

/** Legacy 633: the declared gates of a published Worker version its reader's entry agent cannot
 *  hand on, read off `execution_readiness` (the reader's own — a member reads theirs). `null` while
 *  unknown, for a role that may not read readiness, and for a version readiness does not list. */
export function useWorkerGateGaps(
  http: CapabilityCaller,
  worker: {
    readonly definitionId: string;
    readonly version: number;
    readonly gates: readonly string[];
  } | null,
): WorkerGateGaps | null {
  const can = useRoleCan(http);
  const readiness = useExecutionReadiness(http, {
    enabled: worker !== null && can('execution_readiness') === true,
  });
  if (worker === null || readiness.state.status !== 'ready') return null;
  return workerGateGaps(readiness.state.data, worker);
}

export function workerGateGaps(
  data: ExecutionReadinessWire,
  worker: {
    readonly definitionId: string;
    readonly version: number;
    readonly gates: readonly string[];
  },
): WorkerGateGaps | null {
  const entry: ExecutionReadinessWorkerWire | undefined = data.workers.find(
    (item) => item.definitionId === worker.definitionId && item.version === worker.version,
  );
  if (entry === undefined) return null;
  const byId = new Map(data.gates.map((gate) => [gate.gateId, gate]));
  const gates = new Map<string, GapCode>();
  for (const gateId of worker.gates) {
    const gate = byId.get(gateId);
    // A gate this workspace no longer has enabled is not one readiness reads; nothing to say here.
    if (gate === undefined || gate.inEntryScope) continue;
    gates.set(
      gateId,
      !gate.granted
        ? 'no_grant'
        : gate.excludedByPolicy
          ? 'excluded_by_policy'
          : 'excluded_by_profile',
    );
  }
  const blocking: ExecutionReadinessMissingWire[] = entry.delegable
    ? []
    : // The Worker's own lines (unticked; an act no grant allows) first, then the gates.
      [...entry.blockedBy]
        .sort((a, b) => Number(a.gateId !== undefined) - Number(b.gateId !== undefined))
        .map((item) => ({ ...item, workerDefinitionId: worker.definitionId }));
  const blockingGates = new Set(blocking.flatMap((item) => (item.gateId ? [item.gateId] : [])));
  const unusable: ExecutionReadinessMissingWire[] = [...gates]
    .filter(([gateId]) => !blockingGates.has(gateId))
    .map(([gateId, code]) => ({ code, gateId }));
  return {
    delegable: entry.delegable,
    gates,
    blocking,
    unusable,
    gateNames: new Map(data.gates.map((gate) => [gate.gateId, gate.name])),
  };
}

/** What stops the delegation, said of this Worker: the two `blockedBy` entries tied to no gate
 *  read, in `missingCauseText`, as a workspace-wide gap ("a system or Worker is unticked"); here
 *  the reader is looking at the Worker in question, so they name it. */
function blockingText(
  item: ExecutionReadinessMissingWire,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string {
  if (item.gateId === undefined && item.code === 'excluded_by_profile') {
    return t(
      '这个 Worker 在「我的智能体」里被取消了勾选，入口 agent 不会委派它。',
      'This Worker is unticked on My Agent, so your entry agent does not delegate to it.',
    );
  }
  if (item.gateId === undefined && item.code === 'no_grant') {
    return t(
      '这个 Worker 要执行操作，但你的入口 agent 还没有任何门的写操作授权。',
      'This Worker needs to act on a system, but your entry agent holds no write grant on any gate.',
    );
  }
  const name = item.gateId !== undefined ? gateNames.get(item.gateId) : undefined;
  if (name !== undefined) {
    switch (item.code) {
      case 'no_grant':
        return t(
          `它要在门「${name}」上执行操作，但这个门还没有授权给你的入口 agent。`,
          `It acts on the “${name}” gate, which your entry agent has not been granted.`,
        );
      case 'excluded_by_policy':
        return t(
          `它要在门「${name}」上执行操作，但工作区策略的门上限没有包含这个门。`,
          `It acts on the “${name}” gate, which the workspace policy’s gate limit leaves out.`,
        );
      case 'excluded_by_profile':
        return t(
          `它要在门「${name}」上执行操作，但这个门在「我的智能体」里被取消了勾选。`,
          `It acts on the “${name}” gate, which is unticked on My Agent.`,
        );
      default:
        break;
    }
  }
  return missingCauseText(item, gateNames, t);
}

/** Legacy 633: under a published Worker's 「可作用的门」, why the reader's entry agent cannot hand
 *  this version some of them — or cannot delegate it at all — each with its fix. Nothing when every
 *  declared gate goes through. */
export function WorkerGateGapsNotice({
  http,
  gaps,
}: {
  readonly http: CapabilityCaller;
  readonly gaps: WorkerGateGaps;
}) {
  const t = useT();
  const reader = useReadinessReader(http);
  const { blocking, unusable } = gaps;
  if (blocking.length === 0 && unusable.length === 0) return null;
  const fixOf = (item: ExecutionReadinessMissingWire) => ({
    href: missingLinkHref(item, reader),
    label: missingLinkLabel(item, t, reader),
    ask: missingAsk(item, reader, t),
  });
  const all = [...blocking, ...unusable].map(fixOf);
  // UX acceptance of #1523 P3-1: when the reader can fix none of it and every line would say the
  // same "ask the owner", say it once under the list instead of on each line.
  const firstAsk = all[0]?.ask;
  const sharedAsk =
    firstAsk !== undefined && all.every((fix) => fix.href === undefined && fix.ask === firstAsk)
      ? firstAsk
      : undefined;
  const line = (item: ExecutionReadinessMissingWire, text: string) => {
    const fix = fixOf(item);
    return (
      <li key={missingKey(item)} className="row-wrap" data-testid="worker-detail-gate-gap">
        <span>{text}</span>
        <FixHint
          href={fix.href}
          label={fix.label}
          ask={sharedAsk === undefined ? fix.ask : undefined}
        />
      </li>
    );
  };
  const list = { listStyle: 'none', margin: 0, padding: 0 } as const;
  return (
    <Notice tone="warn" testId="worker-detail-gate-gaps">
      {!gaps.delegable ? (
        <>
          <strong>
            {t(
              '你的入口 agent 现在委派不了这一版：',
              'Your entry agent cannot delegate this version right now:',
            )}
          </strong>
          <ul className="stack-s" style={list} data-testid="worker-detail-gate-gaps-blocking">
            {blocking.map((item) => line(item, blockingText(item, gaps.gateNames, t)))}
          </ul>
        </>
      ) : null}
      {unusable.length > 0 ? (
        <>
          <strong>
            {gaps.delegable
              ? t(
                  '你的入口 agent 能委派这一版，但委派出去的 Worker 用不了下面的门：',
                  'Your entry agent can delegate this version, but the delegated Worker cannot use the gates below:',
                )
              : t(
                  '另外，委派出去后它也用不了这些门：',
                  'Besides, once delegated it could not use these gates either:',
                )}
          </strong>
          <ul className="stack-s" style={list} data-testid="worker-detail-gate-gaps-unusable">
            {unusable.map((item) => line(item, missingCauseText(item, gaps.gateNames, t)))}
          </ul>
        </>
      ) : null}
      {sharedAsk !== undefined ? (
        <p className="text-3" data-testid="worker-detail-gate-gaps-ask">
          {sharedAsk}
        </p>
      ) : null}
    </Notice>
  );
}
