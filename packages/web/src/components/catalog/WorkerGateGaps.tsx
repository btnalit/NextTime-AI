import type {
  ExecutionReadinessMissingWire,
  ExecutionReadinessWire,
  ExecutionReadinessWorkerWire,
} from '@nexttime/shared';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
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
  /** What to say and link, one line per gap: each gate above, then what `blockedBy` names that is
   *  tied to no gate (the profile unticks the Worker itself; an act it needs no gate grant allows). */
  readonly items: readonly ExecutionReadinessMissingWire[];
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
  const items: ExecutionReadinessMissingWire[] = [...gates].map(([gateId, code]) => ({
    code,
    gateId,
  }));
  if (!entry.delegable) {
    for (const item of entry.blockedBy) {
      if (item.gateId === undefined) items.push({ code: item.code });
    }
  }
  return {
    delegable: entry.delegable,
    gates,
    items,
    gateNames: new Map(data.gates.map((gate) => [gate.gateId, gate.name])),
  };
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
  if (gaps.delegable && gaps.items.length === 0) return null;
  return (
    <Notice tone="warn" testId="worker-detail-gate-gaps">
      <strong>
        {gaps.delegable
          ? t(
              '你的入口 agent 能委派这一版，但委派出去的 Worker 用不了下面的门：',
              'Your entry agent can delegate this version, but the delegated Worker cannot use the gates below:',
            )
          : t(
              '你的入口 agent 现在委派不了这一版：',
              'Your entry agent cannot delegate this version right now:',
            )}
      </strong>
      <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {gaps.items.map((item) => (
          <li key={missingKey(item)} className="row-wrap" data-testid="worker-detail-gate-gap">
            <span>{missingCauseText(item, gaps.gateNames, t)}</span>
            <FixHint
              href={missingLinkHref(item, reader)}
              label={missingLinkLabel(item, t, reader)}
              ask={missingAsk(item, reader, t)}
            />
          </li>
        ))}
      </ul>
    </Notice>
  );
}
