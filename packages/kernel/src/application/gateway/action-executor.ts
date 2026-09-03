import type { PoolClient } from 'pg';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type { ActionExecutor, ActionExecutorResult } from '../../governance/approval/index.js';
import type { ActionRequestRow } from '../../governance/approval/index.js';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { writeObservedFacts } from './observed-facts.js';

/**
 * application/gateway/action-executor: the real `ActionExecutor` port `governance/approval`'s
 * `ApprovalDrainer` calls to actually perform one `executing` ActionRequest's effect (design doc
 * §5.1.4 Gatekeeper `apply`; docs/development-tasks.md S2.4 "ActionExecutor implementation over
 * the gate client"). Lives in `application` (not `governance`, which may not depend on `adapters`,
 * §7.10) because it composes `adapters/gatekeeper-client` with `governance/gatekeepers` and
 * `substrate`.
 *
 * `apply`'s `idempotencyKey` is the ActionRequest's own id — a `drainGatekeeper` retry (e.g. after
 * a crash between `apply` succeeding and `markActionRequestExecuted` committing) replays the same
 * key, so the gate's own idempotency store (design doc §5.1.4 "apply 幂等") returns the stored
 * result instead of re-running the effect. Observed facts from a successful `apply` are written in
 * their own short Activity, opened and closed around the write — separate from whatever Activity
 * (if any) the original `request_action` call ran under, since execution can happen well after and
 * in a different transaction (a human approving asynchronously, or the periodic drain tick).
 */

export type WithTransactionFn = <T>(
  workspaceId: string,
  principalId: string,
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

export interface GatekeeperActionExecutorDeps {
  readonly gatekeeperClient: GatekeeperClient;
  readonly withTransaction: WithTransactionFn;
}

export function createGatekeeperActionExecutor(deps: GatekeeperActionExecutorDeps): ActionExecutor {
  return {
    async execute(actionRequest: ActionRequestRow): Promise<ActionExecutorResult> {
      const gatekeeper = await deps.withTransaction(
        actionRequest.workspaceId,
        actionRequest.onBehalfOf,
        (client) => getGatekeeper(client, actionRequest.workspaceId, actionRequest.gatekeeperId),
      );
      if (!gatekeeper) {
        return {
          ok: false,
          reason: `gatekeeper "${actionRequest.gatekeeperId}" is not registered`,
        };
      }

      let applyResult: Awaited<ReturnType<GatekeeperClient['apply']>>;
      try {
        applyResult = await deps.gatekeeperClient.apply(gatekeeper.endpoint, {
          operation: actionRequest.actionKind,
          params: actionRequest.params,
          onBehalfOf: actionRequest.onBehalfOf,
          idempotencyKey: actionRequest.id,
        });
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }

      await deps.withTransaction(
        actionRequest.workspaceId,
        actionRequest.onBehalfOf,
        async (client) => {
          const activity = await startActivity(client, actionRequest.workspaceId, {
            kind: 'gatekeeper_apply',
            principalId: actionRequest.onBehalfOf,
            metadata: {
              actionRequestId: actionRequest.id,
              gatekeeperId: actionRequest.gatekeeperId,
            },
          });
          await writeObservedFacts(
            client,
            actionRequest.workspaceId,
            actionRequest.gatekeeperId,
            applyResult.observedFacts ?? [],
            activity.id,
          );
          await endActivity(client, actionRequest.workspaceId, activity.id, 'completed');
        },
      );

      return {
        ok: true,
        resultMetadata: { data: applyResult.data, replayed: applyResult.replayed },
      };
    },
  };
}
