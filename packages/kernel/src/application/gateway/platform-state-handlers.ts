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
import { probePlatformServiceHealth, readRuntimeInventory } from '../platform/runtime.js';
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
 * commits, in a read-only platform transaction as the agent's administrator.
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

function platformStateHandler(
  name: string,
  read: (
    client: PoolClient,
    agent: NonNullable<CapabilityHandlerContext['adminAgent']>,
    checkedAt: string,
  ) => Promise<PlatformStateRead<unknown>>,
): CapabilityHandler {
  return async (_client, workspaceId, _params, ctx): Promise<CapabilityHandlerResult> => {
    const agent = adminAgentOf(name, ctx);
    const principalId = ctx?.principalId ?? '';
    return {
      result: null,
      afterCommit: (pool) =>
        readPlatformStateForAdminAgent(
          pool,
          { workspaceId, principalId, sessionId: agent.sessionId, userId: agent.userId },
          name,
          (client) => read(client, agent, new Date().toISOString()),
        ),
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
  async (client, _agent, checkedAt) => {
    // The inventory's one DB read (the active-image setting) and worker-supervisor's two lists,
    // then the service probes — awaited in turn: `client` runs one query at a time.
    const inventory = await readRuntimeInventory(client);
    const services = await probePlatformServiceHealth();
    const result = projectRuntimeState(inventory, services, checkedAt);
    return { result, returned: result.images.length };
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

export const platformStateInvariantsHandler = platformStateHandler(
  'platform_state_invariants',
  async (_client, _agent, checkedAt) => {
    const result = projectInvariantsState(invariantMetrics?.snapshot(), checkedAt);
    return { result, returned: result.checks.length };
  },
);
