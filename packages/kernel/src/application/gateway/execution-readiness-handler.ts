import type { Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  InvokeWorkerAttenuationError,
  computeChildHandleScope,
  defaultWorkerCapabilities,
} from '../../application/task/index.js';
import {
  readAgentPolicy,
  readAgentProfile,
  resolveEffectiveAgentProfile,
} from '../../governance/agent-profile/index.js';
import {
  WORKER_CEILING_CAPABILITIES,
  entryScope,
  roleSatisfiesMinRole,
} from '../../governance/capability/index.js';
import {
  listGatekeepers,
  listPublishedOperationsForGatekeepers,
} from '../../governance/gatekeepers/index.js';
import { listWorkerDefinitions } from '../worker/index.js';
import { assertPrincipalExists, resolveAvailableResources } from './agent-profile-handlers.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/execution-readiness-handler: `execution_readiness` (S8 W1-C, F6;
 * ui-audit-2026-09-23 J1/O1/J2 — "让入口 agent 能执行" needs gate-enablement + grant + published
 * `kind=worker` WorkerDefinition to all show up in one place, and none of the three today do).
 *
 * **Invariant this handler exists to guarantee**: `ready`/`workers[].delegable` must never
 * disagree with what a real `invoke_worker` call would do. It achieves this by calling the exact
 * same functions the enforcement path calls, not a re-derived approximation:
 *
 *   - The entry Handle's own gate scope — `application/host-bridge/agent-host-runtime.ts`'s
 *     `ensureEntryHandle` computes it from `listActiveGrantResourceScopes` (via
 *     `resolveAvailableResources`, reused verbatim below — that function's own doc comment) then
 *     narrows by `resolveEffectiveAgentProfile`'s `effective.enabledGatekeepers`, then wraps the
 *     result in `entryScope({role})`. This handler reproduces that exact sequence (never
 *     `'unconstrained'` — an entry agent's own delegation authority is always the Grant-derived
 *     scope, never the separate human-channel owner bypass `application/task/handle-mint.ts`'s
 *     `resolveParentAuthority` grants a *direct* owner call, which is not what "this member's
 *     entry agent" means) to get the same `CapabilityScope` `ensureEntryHandle` would mint right
 *     now.
 *   - Per-WorkerDefinition delegability — `application/task/handle-mint.ts`'s
 *     `computeChildHandleScope`, the same dry run `application/task/service.ts`'s `findWorkers`
 *     already uses for `find_workers`' own "would this caller actually be able to invoke it"
 *     filter, called here exactly as `findWorkers` calls it (same `declaredCapabilities`/
 *     `declaredGates` defaulting, `defaultWorkerCapabilities`). `delegable` is simply whether that
 *     call throws `InvokeWorkerAttenuationError`.
 *
 * `blockedBy`'s per-gate detail is presentational, not a second authorization decision: once
 * `computeChildHandleScope` has already decided `delegable: false`, the specific gate ids named in
 * `blockedBy` are a plain set difference (`declaredGates` not in the resolved scope) — describing
 * *why* the already-made decision came out that way, never re-deciding it.
 */

interface ExecutionReadinessMissing {
  readonly code: 'no_enabled_gate' | 'no_grant' | 'no_published_worker';
  readonly gateId?: string;
  readonly workerDefinitionId?: string;
}

interface WorkerDefinitionContent {
  readonly capabilities?: readonly string[];
  readonly gates?: readonly string[];
  readonly name?: string;
}

async function readPrincipalRole(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<Role> {
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const role = result.rows[0]?.role;
  if (role === undefined) {
    // Unreachable in practice — `assertPrincipalExists` already succeeded against the same
    // predicate just before this is called; a defensive, typed fallback rather than a `!`
    // assertion.
    throw new Error(`execution_readiness: principal ${principalId} vanished mid-read`);
  }
  return role;
}

export const executionReadinessHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error(
      'execution_readiness: no resolved human principal in context (this capability is channel:"human"-only)',
    );
  }
  const caller = ctx.principal;

  const { principalId } = rawParams as { principalId?: string };
  const target = principalId ?? caller.id;

  if (target !== caller.id && !roleSatisfiesMinRole(caller.role, 'operator')) {
    throw new ForbiddenError(
      "execution_readiness: only an operator or owner may read another principal's execution readiness",
    );
  }
  await assertPrincipalExists(client, workspaceId, target);
  const targetRole = await readPrincipalRole(client, workspaceId, target);

  // Same three reads + resolution `agent-host-runtime.ts`'s `ensureEntryHandle`/`resolveAgentProfile`
  // perform, reused verbatim (`resolveAvailableResources` — this file's own module doc comment).
  const profile = await readAgentProfile(client, workspaceId, target);
  const policy = await readAgentPolicy(client, workspaceId);
  const available = await resolveAvailableResources(client, workspaceId, target);
  const effective = resolveEffectiveAgentProfile(profile, policy, available);

  // `effective.enabledGatekeepers` is always a concrete array here (never null/undefined —
  // `resolveEffectiveAgentProfile` resolves a `null` (inherit) profile field to "every currently
  // granted gate", `governance/agent-profile/resolve.ts`'s own `resolveList` — so this filter is a
  // no-op in the common "no explicit restriction" case, exactly mirroring `ensureEntryHandle`'s
  // own `enabledGatekeepers ? filter : grantedGatekeeperIds` shape for the one case that differs
  // there (`agentProfile` itself failing to resolve at all — never possible here, this handler
  // calls `resolveEffectiveAgentProfile` directly rather than through that optional wrapper).
  const gatekeeperIds = available.grantedGatekeeperIds.filter((id) =>
    effective.enabledGatekeepers.includes(id),
  );

  const parentAuthority = entryScope(
    gatekeeperIds.length > 0 ? { resources: { gatekeeper: gatekeeperIds } } : {},
    { role: targetRole },
  );

  // -----------------------------------------------------------------------------------------
  // Gates: every registered Gatekeeper in this workspace (both the gate-instance-link path and
  // the legacy direct-registration path converge on one `Gatekeeper` Object — governance/
  // gatekeepers/registry.ts's own module doc comment), with the raw grant fact
  // (`available.grantedGatekeeperIds`, *before* any AgentProfile narrowing — "holds a grant for
  // it" is a Grant-level fact, distinct from `workers[].delegable`'s narrower, currently-effective
  // scope) and its published Operation count (one batched query, never per gate).
  // -----------------------------------------------------------------------------------------
  const gateEntries = await listGatekeepers(client, workspaceId);
  const grantedGateSet = new Set(available.grantedGatekeeperIds);
  const publishedOps = await listPublishedOperationsForGatekeepers(
    client,
    workspaceId,
    gateEntries.map((entry) => entry.gatekeeperId),
  );
  const opCountByGate = new Map<string, number>();
  for (const op of publishedOps) {
    opCountByGate.set(op.gatekeeperId, (opCountByGate.get(op.gatekeeperId) ?? 0) + 1);
  }
  const gates = gateEntries.map((entry) => ({
    gateId: entry.gatekeeperId,
    name: entry.name,
    granted: grantedGateSet.has(entry.gatekeeperId),
    publishedOperationCount: opCountByGate.get(entry.gatekeeperId) ?? 0,
  }));

  // -----------------------------------------------------------------------------------------
  // Workers: every published kind=worker WorkerDefinition, each with the real
  // `computeChildHandleScope` dry run against `parentAuthority` above.
  // -----------------------------------------------------------------------------------------
  const definitions = await listWorkerDefinitions(client, workspaceId, 'worker');
  const missingByKey = new Map<string, ExecutionReadinessMissing>();
  const addMissing = (item: ExecutionReadinessMissing) => {
    const key = `${item.code}:${item.gateId ?? ''}`;
    if (!missingByKey.has(key)) missingByKey.set(key, item);
  };

  const workers = definitions.map((definition) => {
    const content = definition.definition as WorkerDefinitionContent;
    const declaredCapabilities =
      content.capabilities ?? defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES);
    const declaredGates = content.gates ?? [];

    let delegable: boolean;
    const blockedBy: ExecutionReadinessMissing[] = [];
    try {
      computeChildHandleScope({ parentAuthority, declaredCapabilities, declaredGates });
      delegable = true;
    } catch (err) {
      if (!(err instanceof InvokeWorkerAttenuationError)) throw err;
      delegable = false;
      const parentGateSet = new Set(gatekeeperIds);
      const missingGates = declaredGates.filter((gateId) => !parentGateSet.has(gateId));
      if (missingGates.length > 0) {
        for (const gateId of missingGates) {
          blockedBy.push({ code: 'no_grant', gateId, workerDefinitionId: definition.id });
          addMissing({ code: 'no_grant', gateId });
        }
      } else {
        // The definition itself declares an execute-class need (e.g. `request_action`) that this
        // principal's scope structurally cannot satisfy at all (no gate grant of any kind —
        // `delegatedRequestAction` false, `application/task/handle-mint.ts`'s own doc comment) —
        // not tied to one specific gate.
        blockedBy.push({ code: 'no_grant', workerDefinitionId: definition.id });
        addMissing({ code: 'no_grant' });
      }
    }

    return {
      definitionId: definition.id,
      version: definition.version,
      ...(typeof content.name === 'string' && content.name !== '' ? { name: content.name } : {}),
      delegable,
      blockedBy,
    };
  });

  if (gates.length === 0) addMissing({ code: 'no_enabled_gate' });
  if (definitions.length === 0) addMissing({ code: 'no_published_worker' });

  const ready = workers.some((worker) => worker.delegable);

  return {
    result: {
      principalId: target,
      ready,
      missing: [...missingByKey.values()],
      gates,
      workers,
    },
    resourceType: 'principal',
    resourceId: target,
  };
};
