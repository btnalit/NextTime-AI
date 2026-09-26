import { roleSatisfiesMinRole } from '../../governance/capability/index.js';
import { assertPrincipalExists } from './agent-profile-handlers.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { computeCapabilityReachability } from './capability-reachability.js';

/**
 * application/gateway/execution-readiness-handler: `execution_readiness` (S8 W1-C, F6;
 * ui-audit-2026-09-23 J1/O1/J2 — "让入口 agent 能执行" needs gate-enablement + grant + published
 * `kind=worker` WorkerDefinition to all show up in one place, and none of the three today do).
 *
 * **Invariant this handler exists to guarantee**: `workers[].delegable` (and each Worker's
 * `reachableGateCount`) must never disagree with what a real `invoke_worker` call would do. It achieves this by calling the exact
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
 * `ready` is stricter than "some Worker is delegable": it also needs that Worker's child scope — the
 * same `computeChildHandleScope` result — to contain at least one Gatekeeper. A Worker with no
 * execute-class need has every declared-but-ungranted gate silently dropped rather than refused
 * (handle-mint.ts's own comment), so "delegable" alone would read as ready while the delegated
 * Worker reaches no system at all; "让入口 agent 能执行" is about reaching a system.
 *
 * `blockedBy`'s per-gate detail is presentational, not a second authorization decision: once
 * `computeChildHandleScope` has already decided `delegable: false`, the specific gate ids named in
 * `blockedBy` are a plain set difference (`declaredGates` not in the resolved scope) — describing
 * *why* the already-made decision came out that way, never re-deciding it.
 *
 * Console redesign M2 (2026-09-25): the computation now lives in `capability-reachability.ts`,
 * shared with `find_operations`' per-Operation annotation, and adds per-gate reachability
 * (`gates[].status` / `reason`: can the entry agent call it directly, only by delegating, or not
 * at all and why). `workers[].delegable` now also honours the member's AgentProfile exclusions,
 * which `invoke_worker` itself enforces — the invariant above was not quite true before.
 */

interface ExecutionReadinessMissing {
  readonly code:
    | 'no_enabled_gate'
    | 'no_grant'
    | 'no_published_worker'
    | 'no_worker_gate'
    | 'excluded_by_policy'
    | 'excluded_by_profile';
  readonly gateId?: string;
  readonly workerDefinitionId?: string;
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

  // One shared computation with `find_operations` (capability-reachability.ts's own doc comment).
  const reach = await computeCapabilityReachability(client, workspaceId, target);

  const missingByKey = new Map<string, ExecutionReadinessMissing>();
  const addMissing = (item: ExecutionReadinessMissing) => {
    const key = `${item.code}:${item.gateId ?? ''}:${item.workerDefinitionId ?? ''}`;
    if (!missingByKey.has(key)) missingByKey.set(key, item);
  };

  const gates = reach.gates.map((gate) => ({
    gateId: gate.gateId,
    name: gate.name,
    granted: gate.granted,
    publishedOperationCount: gate.observeOperationCount + gate.executeOperationCount,
    observeOperationCount: gate.observeOperationCount,
    executeOperationCount: gate.executeOperationCount,
    excludedByPolicy: gate.excludedByPolicy,
    excludedByProfile: gate.excludedByProfile,
    inEntryScope: gate.inEntryScope,
    workerDefinitionIds: [...gate.workerDefinitionIds],
    status: gate.status,
    ...(gate.reason !== undefined ? { reason: gate.reason } : {}),
  }));
  for (const gate of reach.gates) {
    if (gate.excludedByProfile) addMissing({ code: 'excluded_by_profile', gateId: gate.gateId });
  }

  const entryGateSet = new Set(reach.entryGatekeeperIds);
  const gateById = new Map(reach.gates.map((gate) => [gate.gateId, gate]));
  // Why a declared gate is outside the entry scope: never granted, or granted but left out by the
  // workspace policy cap / the member's own AgentProfile — three different fixes.
  const gateGap = (gateId: string): ExecutionReadinessMissing['code'] => {
    const gate = gateById.get(gateId);
    if (!gate?.granted) return 'no_grant';
    return gate.excludedByPolicy ? 'excluded_by_policy' : 'excluded_by_profile';
  };
  const workers = reach.workers.map((worker) => {
    const blockedBy: ExecutionReadinessMissing[] = [];
    if (worker.excludedByProfile) {
      blockedBy.push({ code: 'excluded_by_profile', workerDefinitionId: worker.definitionId });
    }
    if (worker.attenuationDenied) {
      const missingGates = worker.declaredGates.filter((gateId) => !entryGateSet.has(gateId));
      if (missingGates.length > 0) {
        for (const gateId of missingGates) {
          const code = gateGap(gateId);
          blockedBy.push({ code, gateId, workerDefinitionId: worker.definitionId });
          addMissing({ code, gateId });
        }
      } else {
        // The definition itself declares an execute-class need (e.g. `request_action`) that this
        // principal's scope structurally cannot satisfy at all (no gate grant of any kind —
        // `delegatedRequestAction` false, `application/task/handle-mint.ts`'s own doc comment) —
        // not tied to one specific gate.
        blockedBy.push({ code: 'no_grant', workerDefinitionId: worker.definitionId });
        addMissing({ code: 'no_grant' });
      }
    } else {
      // Delegable (or only profile-excluded), but declared gates the principal holds no grant for
      // are silently dropped from the child scope — each is still a gap worth naming.
      for (const gateId of worker.declaredGates) {
        if (!entryGateSet.has(gateId)) addMissing({ code: gateGap(gateId), gateId });
      }
    }
    return {
      definitionId: worker.definitionId,
      version: worker.version,
      ...(worker.name !== undefined ? { name: worker.name } : {}),
      delegable: worker.delegable,
      reachableGateCount: worker.childGateIds.length,
      blockedBy,
    };
  });

  if (gates.length === 0) addMissing({ code: 'no_enabled_gate' });
  // Gates exist but this principal holds a grant for none of them: a workspace-wide gap of its own.
  // The per-Worker loop above only reports `no_grant` for gates some published Worker declares, so
  // with no Worker (or none that declares a gate) "nothing is granted" would otherwise go unsaid
  // while `gates[].granted` is false everywhere. Skipped when a `no_grant` item is already present.
  if (
    gates.length > 0 &&
    !gates.some((gate) => gate.granted) &&
    ![...missingByKey.values()].some((item) => item.code === 'no_grant')
  ) {
    addMissing({ code: 'no_grant' });
  }
  if (reach.workers.length === 0) addMissing({ code: 'no_published_worker' });
  // Published Workers exist but none declares any gate: delegating reaches no system whatever is
  // granted — fixed in the Worker definition itself, not by a grant.
  if (
    reach.workers.length > 0 &&
    reach.workers.every((worker) => worker.declaredGates.length === 0)
  ) {
    addMissing({ code: 'no_worker_gate' });
  }

  const ready = workers.some((worker) => worker.delegable && worker.reachableGateCount > 0);

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
