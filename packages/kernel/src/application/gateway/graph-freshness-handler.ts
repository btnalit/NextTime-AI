import { DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS } from '../../substrate/audit/invariant-checks.js';
import { listSourceFreshness } from '../../substrate/epistemic/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/graph-freshness-handler: `graph_freshness` (S8 W4-A; ui-audit-2026-09-23 G1;
 * STATUS leftover 70/62; convergence-plan-2026-09-25.md §6 W4). A minimal, workspace-scoped,
 * human-channel read model over `substrate/epistemic/sources.ts`'s `listSourceFreshness` — the
 * same `ops.collector_silent` predicate `substrate/audit/invariant-checks.ts` already runs
 * cross-workspace on a timer, restated here so a member can see it from the console instead of
 * only from `/internal/metrics` (which no workspace-scoped principal can reach). Read-only (F6
 * allows a read model over existing data without a new domain concept); no new write path.
 *
 * `staleThresholdMs` is always the same `DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS` the invariant
 * checker uses (2 hours) — this capability takes no parameter to override it, so the console's own
 * `lib/graph-freshness.ts` `OBSERVATION_WINDOW_MS` (which mirrors the same constant, restated
 * client-side for the same reason that file's own doc comment gives) and this read never disagree.
 */
export const graphFreshnessHandler: CapabilityHandler = async (client, workspaceId) => {
  const staleThresholdMs = DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS;
  const sources = await listSourceFreshness(client, workspaceId, staleThresholdMs);

  let workspaceLastObservedAt: string | null = null;
  for (const source of sources) {
    if (source.lastObservedAt === null) continue;
    const iso = source.lastObservedAt.toISOString();
    if (workspaceLastObservedAt === null || iso > workspaceLastObservedAt) {
      workspaceLastObservedAt = iso;
    }
  }

  return {
    result: {
      staleThresholdMs,
      workspaceLastObservedAt,
      sources: sources.map((source) => ({
        sourceId: source.sourceId,
        kind: source.kind,
        name: source.name,
        lastObservedAt: source.lastObservedAt ? source.lastObservedAt.toISOString() : null,
        silent: source.silent,
      })),
    },
  };
};
