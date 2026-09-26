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
import type { CapabilityScope } from '../../governance/capability/index.js';
import { WORKER_CEILING_CAPABILITIES, entryScope } from '../../governance/capability/index.js';
import {
  listGatekeepers,
  listPublishedOperationsForGatekeepers,
} from '../../governance/gatekeepers/index.js';
import { listWorkerDefinitions } from '../worker/index.js';
import { resolveAvailableResources } from './agent-profile-handlers.js';

/**
 * application/gateway/capability-reachability: "what can this member's entry agent actually reach,
 * system by system, and if not, which condition is missing" (docs/console-redesign-plan-2026-09-25.md
 * §3 M2 / M3). One computation shared by `execution_readiness` (the console's per-gate status) and
 * `find_operations` (the agent's own per-Operation annotation), so the console and the agent can
 * never disagree about the same gate.
 *
 * It reproduces the enforcement path rather than approximating it — the same sequence
 * `application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle` runs at Turn start:
 * active gate Grants (`resolveAvailableResources`) narrowed by `effective.enabledGatekeepers`
 * (AgentProfile exclusions and the AgentPolicy cap), wrapped in `entryScope({role})`; and, per
 * published `kind=worker` WorkerDefinition, the same `computeChildHandleScope` dry run
 * `find_workers` / `invoke_worker` use. A gate whose observe-class Operations the entry Handle
 * carries is callable directly (the pi extension projects one tool per such Operation); anything
 * else needs a delegable Worker whose child scope carries the gate (and, for an execute-class
 * Operation, one that declares `request_action`).
 *
 * The reason code names the *first* unmet condition in the order a person fixes them: nothing
 * published → not granted → excluded by the workspace AgentPolicy cap → excluded by the member's
 * own AgentProfile → no Worker covers it. Read-only; decides nothing itself.
 */

export type ReachabilityStatus = 'direct' | 'via_worker' | 'unreachable';

export type UnreachableReason =
  | 'no_published_operation'
  | 'not_granted'
  | 'excluded_by_policy'
  | 'excluded_by_profile'
  | 'no_worker';

export interface GateReachability {
  readonly gateId: string;
  readonly name: string;
  /** The member holds an active gate Grant for it (before any AgentProfile / policy narrowing). */
  readonly granted: boolean;
  readonly excludedByPolicy: boolean;
  readonly excludedByProfile: boolean;
  /** In the entry Handle's `resources.gatekeeper` — its observe Operations are callable directly. */
  readonly inEntryScope: boolean;
  readonly observeOperationCount: number;
  readonly executeOperationCount: number;
  /** Delegable, not-excluded Workers whose child scope carries this gate. */
  readonly workerDefinitionIds: readonly string[];
  /** The subset of `workerDefinitionIds` that declares `request_action` (can propose actions). */
  readonly executeWorkerDefinitionIds: readonly string[];
  readonly status: ReachabilityStatus;
  readonly reason?: UnreachableReason;
}

export interface WorkerReachability {
  readonly definitionId: string;
  readonly version: number;
  readonly name?: string;
  readonly declaredGates: readonly string[];
  /** `invoke_worker` would accept it for this member right now (attenuation dry run passes and
   *  the member's AgentProfile does not exclude it). */
  readonly delegable: boolean;
  readonly excludedByProfile: boolean;
  /** `true` when `computeChildHandleScope` itself refused (as opposed to a profile exclusion). */
  readonly attenuationDenied: boolean;
  /** Gatekeepers the child Handle would carry (empty unless `delegable`). */
  readonly childGateIds: readonly string[];
}

export interface CapabilityReachability {
  readonly role: Role;
  readonly parentAuthority: CapabilityScope;
  /** The entry Handle's gate scope (Grants ∩ effective AgentProfile / policy). */
  readonly entryGatekeeperIds: readonly string[];
  readonly grantedGatekeeperIds: readonly string[];
  readonly gates: readonly GateReachability[];
  readonly workers: readonly WorkerReachability[];
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
    throw new Error(`capability reachability: principal ${principalId} not found`);
  }
  return role;
}

export async function computeCapabilityReachability(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<CapabilityReachability> {
  const role = await readPrincipalRole(client, workspaceId, principalId);
  const profile = await readAgentProfile(client, workspaceId, principalId);
  const policy = await readAgentPolicy(client, workspaceId);
  const available = await resolveAvailableResources(client, workspaceId, principalId);
  const effective = resolveEffectiveAgentProfile(profile, policy, available);

  const entryGatekeeperIds = available.grantedGatekeeperIds.filter((id) =>
    effective.enabledGatekeepers.includes(id),
  );
  const parentAuthority = entryScope(
    entryGatekeeperIds.length > 0 ? { resources: { gatekeeper: entryGatekeeperIds } } : {},
    { role },
  );

  // Workers: the `find_workers` / `invoke_worker` dry run, plus the AgentProfile exclusion
  // `invoke_worker` also enforces (`InvokeWorkerDefinitionNotEnabledError`).
  const enabledWorkers = new Set(effective.enabledWorkerDefinitions);
  const definitions = await listWorkerDefinitions(client, workspaceId, 'worker');
  const workers: WorkerReachability[] = definitions.map((definition) => {
    const content = definition.definition as WorkerDefinitionContent;
    const declaredCapabilities =
      content.capabilities ?? defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES);
    const declaredGates = content.gates ?? [];
    const excludedByProfile = !enabledWorkers.has(definition.id);
    let childGateIds: readonly string[] = [];
    let attenuationDenied = false;
    try {
      const childScope = computeChildHandleScope({
        parentAuthority,
        declaredCapabilities,
        declaredGates,
      });
      childGateIds = childScope.resources.gatekeeper ?? [];
    } catch (err) {
      if (!(err instanceof InvokeWorkerAttenuationError)) throw err;
      attenuationDenied = true;
    }
    const delegable = !attenuationDenied && !excludedByProfile;
    return {
      definitionId: definition.id,
      version: definition.version,
      ...(typeof content.name === 'string' && content.name !== '' ? { name: content.name } : {}),
      declaredGates,
      delegable,
      excludedByProfile,
      attenuationDenied,
      childGateIds: delegable ? childGateIds : [],
    };
  });
  const requestActionWorkers = new Set(
    definitions
      .filter((definition) =>
        (
          (definition.definition as WorkerDefinitionContent).capabilities ??
          defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES)
        ).includes('request_action'),
      )
      .map((definition) => definition.id),
  );

  // Gates: every registered Gatekeeper in this workspace, with its published Operations split by
  // mode (one batched query).
  const gateEntries = await listGatekeepers(client, workspaceId);
  const publishedOps = await listPublishedOperationsForGatekeepers(
    client,
    workspaceId,
    gateEntries.map((entry) => entry.gatekeeperId),
  );
  const observeCount = new Map<string, number>();
  const executeCount = new Map<string, number>();
  for (const op of publishedOps) {
    const counts = op.operation.mode === 'execute' ? executeCount : observeCount;
    counts.set(op.gatekeeperId, (counts.get(op.gatekeeperId) ?? 0) + 1);
  }

  const granted = new Set(available.grantedGatekeeperIds);
  const inEntry = new Set(entryGatekeeperIds);
  const policyCap = new Set(policy.allowedGatekeepers);

  const gates: GateReachability[] = gateEntries.map((entry) => {
    const gateId = entry.gatekeeperId;
    const isGranted = granted.has(gateId);
    const excludedByPolicy = isGranted && policyCap.size > 0 && !policyCap.has(gateId);
    const excludedByProfile = isGranted && !excludedByPolicy && !inEntry.has(gateId);
    const observe = observeCount.get(gateId) ?? 0;
    const execute = executeCount.get(gateId) ?? 0;
    const workerDefinitionIds = workers
      .filter((worker) => worker.childGateIds.includes(gateId))
      .map((worker) => worker.definitionId);
    const executeWorkerDefinitionIds = workerDefinitionIds.filter((id) =>
      requestActionWorkers.has(id),
    );
    const base = {
      gateId,
      name: entry.name,
      granted: isGranted,
      excludedByPolicy,
      excludedByProfile,
      inEntryScope: inEntry.has(gateId),
      observeOperationCount: observe,
      executeOperationCount: execute,
      workerDefinitionIds,
      executeWorkerDefinitionIds,
    };
    const reason = firstGap(base);
    if (reason !== undefined) return { ...base, status: 'unreachable' as const, reason };
    if (base.inEntryScope && observe > 0) return { ...base, status: 'direct' as const };
    const covering = observe > 0 ? workerDefinitionIds : executeWorkerDefinitionIds;
    return covering.length > 0
      ? { ...base, status: 'via_worker' as const }
      : { ...base, status: 'unreachable' as const, reason: 'no_worker' as const };
  });

  return {
    role,
    parentAuthority,
    entryGatekeeperIds,
    grantedGatekeeperIds: available.grantedGatekeeperIds,
    gates,
    workers,
  };
}

function firstGap(gate: {
  readonly granted: boolean;
  readonly excludedByPolicy: boolean;
  readonly excludedByProfile: boolean;
  readonly observeOperationCount: number;
  readonly executeOperationCount: number;
}): UnreachableReason | undefined {
  if (gate.observeOperationCount + gate.executeOperationCount === 0) {
    return 'no_published_operation';
  }
  if (!gate.granted) return 'not_granted';
  if (gate.excludedByPolicy) return 'excluded_by_policy';
  if (gate.excludedByProfile) return 'excluded_by_profile';
  return undefined;
}

/**
 * One published Operation's reachability for this member's entry agent: an observe-class
 * Operation on a gate in the entry scope is `direct`; otherwise a covering delegable Worker makes
 * it `via_worker` (for an execute-class Operation, only a Worker that declares `request_action`);
 * otherwise `unreachable` with the gate's own first gap, or `no_worker`.
 */
export function operationReachability(
  reachability: CapabilityReachability,
  gatekeeperId: string,
  mode: string,
): { readonly status: ReachabilityStatus; readonly reason?: UnreachableReason } {
  const gate = reachability.gates.find((entry) => entry.gateId === gatekeeperId);
  if (!gate) return { status: 'unreachable', reason: 'not_granted' };
  const gap = firstGap(gate);
  if (gap !== undefined && gap !== 'no_published_operation') {
    return { status: 'unreachable', reason: gap };
  }
  if (mode !== 'execute' && gate.inEntryScope) return { status: 'direct' };
  const covering = mode === 'execute' ? gate.executeWorkerDefinitionIds : gate.workerDefinitionIds;
  return covering.length > 0
    ? { status: 'via_worker' }
    : { status: 'unreachable', reason: 'no_worker' };
}
