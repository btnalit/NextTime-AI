import type { PoolClient } from 'pg';
import type { InvariantMetricsSnapshot } from '../../substrate/audit/index.js';
import {
  type PlatformStateRead,
  projectInvariantsState,
  projectRuntimeState,
  projectUpdatesState,
  readAuditState,
  readConnectorsState,
  readGatesState,
  readPlatformStateForAdminAgent,
} from '../admin-agent/index.js';
import {
  composeRuntimeInventory,
  fetchRuntimeInventorySources,
  probePlatformServiceHealth,
} from '../platform/runtime.js';
import { readPlatformSettings } from '../platform/settings.js';
import { readPlatformUpdates } from '../platform/updates.js';
import type {
  CapabilityHandler,
  CapabilityHandlerContext,
  CapabilityHandlerResult,
} from './capability-handler.js';

/**
 * application/gateway/platform-state-handlers (S11 AA2): the `platform_state_*` capabilities —
 * what an admin agent reads of the platform (`adminAgentOnly`; application/admin-agent
 * platform-state.ts does the reading and the projection). Each is two-phase: the call's own
 * workspace transaction holds only dispatch's checks and audit row, and the read runs after it
 * commits, in a read-only platform transaction as the agent's administrator. What a section asks
 * another service for (`platform_state_runtime`) is fetched before that transaction opens, so it
 * holds no connection while the service answers (S11 AA4-0, legacy 592).
 */

/** Dispatch sets `ctx.adminAgent` for an admin agent's call and refuses every other caller of an
 *  `adminAgentOnly` capability first (`AdminAgentOnlyError`), so a call without it here is a
 *  wiring bug, not a caller to answer. */
function adminAgentOf(
  name: string,
  ctx: CapabilityHandlerContext | undefined,
): NonNullable<CapabilityHandlerContext['adminAgent']> {
  if (!ctx?.adminAgent) {
    throw new Error(`${name}: no admin agent in the call's context (dispatch refuses any other)`);
  }
  return ctx.adminAgent;
}

/** A section's handler: `read` runs in the read-only platform transaction; `fetch`, when given, is
 *  what it asks other services for, fetched before that transaction opens (never the database). */
function platformStateHandler<F = undefined>(
  name: string,
  read: (
    client: PoolClient,
    agent: NonNullable<CapabilityHandlerContext['adminAgent']>,
    checkedAt: string,
    fetched: F,
  ) => Promise<PlatformStateRead<unknown>>,
  fetch?: () => Promise<F>,
): CapabilityHandler {
  return async (_client, workspaceId, _params, ctx): Promise<CapabilityHandlerResult> => {
    const agent = adminAgentOf(name, ctx);
    const principalId = ctx?.principalId ?? '';
    return {
      result: null,
      afterCommit: (pool) => {
        const checkedAt = new Date().toISOString();
        return readPlatformStateForAdminAgent(
          pool,
          { workspaceId, principalId, sessionId: agent.sessionId, userId: agent.userId },
          name,
          (client, fetched: F) => read(client, agent, checkedAt, fetched),
          fetch,
        );
      },
    };
  };
}

export const platformStateGatesHandler = platformStateHandler(
  'platform_state_gates',
  (client, _agent, checkedAt) => readGatesState(client, checkedAt),
);

export const platformStateConnectorsHandler = platformStateHandler(
  'platform_state_connectors',
  (client, _agent, checkedAt) => readConnectorsState(client, checkedAt),
);

export const platformStateAuditHandler = platformStateHandler(
  'platform_state_audit',
  (client, agent, checkedAt) => readAuditState(client, agent.userId, checkedAt),
);

export const platformStateRuntimeHandler = platformStateHandler(
  'platform_state_runtime',
  async (client, _agent, checkedAt, fetched) => {
    // In the transaction: the inventory's one DB read, the active-image setting.
    const { settings } = await readPlatformSettings(client);
    const inventory = composeRuntimeInventory(settings.activeRuntimeImage, fetched.sources);
    const result = projectRuntimeState(inventory, fetched.services, checkedAt);
    return { result, returned: result.images.length };
  },
  // Before it: worker-supervisor's two lists and the two health probes, over HTTP.
  async () => {
    const [sources, services] = await Promise.all([
      fetchRuntimeInventorySources(),
      probePlatformServiceHealth(),
    ]);
    return { sources, services };
  },
);

export const platformStateUpdatesHandler = platformStateHandler(
  'platform_state_updates',
  async (client, _agent, checkedAt) => {
    const result = projectUpdatesState(
      await readPlatformUpdates(client, new Date(checkedAt)),
      checkedAt,
    );
    return { result, returned: result.platform?.newerReleases.length ?? 0 };
  },
);

/** Where the kernel keeps its latest invariant check (`InvariantMetricsStore`, set by
 *  packages/kernel/src/index.ts's `createBackgroundServices` — the same seam as
 *  `setAgentRuntimeForHandlers`). Unset: nothing runs the checks in this process, and
 *  `platform_state_invariants` says `not_run`. */
let invariantMetrics: { snapshot(): InvariantMetricsSnapshot } | undefined;

export function setInvariantMetricsForHandlers(
  store: { snapshot(): InvariantMetricsSnapshot } | undefined,
): void {
  invariantMetrics = store;
}

/** Tests only: the store `setInvariantMetricsForHandlers` last set (index.test.ts checks that
 *  `createBackgroundServices` hands its store over). */
export function invariantMetricsForHandlersForTests():
  | { snapshot(): InvariantMetricsSnapshot }
  | undefined {
  return invariantMetrics;
}

export const platformStateInvariantsHandler = platformStateHandler(
  'platform_state_invariants',
  async (_client, _agent, checkedAt) => {
    const result = projectInvariantsState(invariantMetrics?.snapshot(), checkedAt);
    return { result, returned: result.checks.length };
  },
);
