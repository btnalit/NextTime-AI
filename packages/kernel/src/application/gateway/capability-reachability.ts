import type { DefinitionMismatchWire, Role } from '@nexttime/shared';
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
  operationRecordDigestOrNull,
} from '../../governance/gatekeepers/index.js';
import {
  definitionRefusal,
  observeExclusionsOf,
  observeGateExclusion,
  observeRefusal,
  operationPlatformStatus,
  readGateDefinitionsForWorkspace,
  readGateLinkPoliciesForWorkspace,
} from '../gates/index.js';
import { listWorkerDefinitions } from '../worker/index.js';
import { resolveAvailableResources } from './agent-profile-handlers.js';

/**
 * application/gateway/capability-reachability: "what can this member's entry agent actually reach,
 * system by system, and if not, which condition is missing" (docs/console-redesign-plan-2026-09-25.md
 * §3 M2 / M3). One computation shared by `execution_readiness` (the console's per-gate status) and
 * `find_operations` (the agent's own per-Operation annotation), so the console and the agent can
 * never disagree about the same gate.
 *
 * It calls the enforcement predicates rather than approximating them:
 *
 *   - **Observe** (design doc §11 "门上的观察"; decision D4 revoked 2026-09-27 — "只读调用不需要
 *     授权"): an observe-class Operation is `direct` exactly when `observeRefusal`
 *     (application/gates/observe-access.ts) — the predicate `observe_operation`,
 *     `request_action`'s observe branch and `list_allowed_operations` all call — accepts it for
 *     this member: gate registered here, Operation published and not on the platform connector
 *     deny list, gate not left out by the AgentPolicy cap or the member's own AgentProfile. No
 *     Grant is involved, so an ungranted gate is observable (and an ungranted gate can still be
 *     excluded).
 *   - **Execute** (unchanged): an execute-class Operation is never direct; it needs a gate Grant
 *     and a delegable Worker whose child Handle carries the gate and declares `request_action`.
 *     This reproduces `application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle`:
 *     active gate Grants (`resolveAvailableResources`) narrowed by `effective.enabledGatekeepers`
 *     (AgentProfile exclusions and the AgentPolicy cap), wrapped in `entryScope({role})`; and, per
 *     published `kind=worker` WorkerDefinition, the same `computeChildHandleScope` dry run
 *     `find_workers` / `invoke_worker` use.
 *
 * A gate's own `status` is `direct` when at least one of its observe-class Operations is; otherwise
 * `reason` names the first unmet condition, in the order a person fixes them: nothing published →
 * disabled by the platform's connector deny list → the gate runs another definition than every
 * remaining one (legacy K) → (only for a gate with nothing left to observe) not granted → excluded by the workspace AgentPolicy cap → excluded by the member's own
 * AgentProfile → no Worker covers it. `not_granted` is therefore an execute-path reason only: a
 * gate with an observable Operation is never `not_granted`. Read-only; decides nothing itself.
 *
 * Production incident 2026-09-26 (console redesign follow-up): a platform admin can deny individual
 * Operations of a connector (`connectors.disabled_operations`, platform integrations page) —
 * enforcement refuses a disabled Operation on every call regardless of Grant/AgentProfile/
 * AgentPolicy, but this file never consulted that deny list before that fix: a gate could read
 * `direct` here while every one of its Operations was refused in practice. `disabled_by_platform`
 * and each gate's own `disabledOperations` go through the same shared predicate enforcement uses
 * (`operationPlatformStatus`, application/gates/store.ts — also inside `observeRefusal`).
 *
 * Legacy K (UX acceptance of #538): a platform gate refuses every call made under a definition it
 * does not run, and the kernel cannot overrule that. `definitionMismatch` names those Operations
 * (`definitionRefusal`, application/gates/definition-drift.ts — the comparison the gate makes,
 * from what the gate last announced), they are never `direct`, and a gate with nothing else left
 * reads `definition_mismatch`, ranked right after the platform deny list.
 */

export type ReachabilityStatus = 'direct' | 'via_worker' | 'unreachable';

export type UnreachableReason =
  | 'no_published_operation'
  | 'disabled_by_platform'
  | 'definition_mismatch'
  | 'not_granted'
  | 'excluded_by_policy'
  | 'excluded_by_profile'
  | 'no_worker';

export interface GateReachability {
  readonly gateId: string;
  readonly name: string;
  /** The member holds an active gate Grant for it (before any AgentProfile / policy narrowing) —
   *  execute authority only; observation needs no Grant. */
  readonly granted: boolean;
  /** The workspace AgentPolicy gate cap leaves this gate out (`observeGateExclusion`) — blocks
   *  both observation and execution, granted or not. */
  readonly excludedByPolicy: boolean;
  /** The member's own AgentProfile excludes this gate (and the policy cap does not already) —
   *  blocks both observation and execution, granted or not. */
  readonly excludedByProfile: boolean;
  /** In the entry Handle's `resources.gatekeeper` (Grants ∩ AgentProfile / policy) — the gates a
   *  Worker it delegates to may carry execute authority for. Not what decides observation. */
  readonly inEntryScope: boolean;
  /** Total published Operations on this gate, whatever the platform's connector deny list says —
   *  `disabledOperations` below names the platform-disabled subset; a consumer that wants a
   *  "callable" count subtracts it. Kept as the plain published total (not narrowed) so
   *  `no_published_operation` keeps meaning exactly that, ranked ahead of `disabled_by_platform`. */
  readonly observeOperationCount: number;
  readonly executeOperationCount: number;
  /** Published Operation names on this gate the platform's connector deny list currently refuses
   *  (`operationPlatformStatus`) — always a subset of the gate's own published Operations. Non-empty
   *  even when the gate's own `status` is not `disabled_by_platform` (some, not all, published
   *  Operations disabled) — `operationReachability` below flags exactly those by name. */
  readonly disabledOperations: readonly string[];
  /** Legacy K: published Operations (not platform-disabled) the gate refuses because it runs
   *  another definition, with whose step ends it (`definitionRefusal`). Empty for a gate the
   *  workspace connected itself. */
  readonly definitionMismatch: readonly DefinitionMismatchWire[];
  /** The observe-class Operations `observeRefusal` accepts for this member and the gate runs as
   *  published — the ones a real `observe_operation` call would run. */
  readonly directOperations: readonly string[];
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
  /** Gatekeepers the child Handle would carry execute authority for (empty unless `delegable`). */
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
  const exclusions = observeExclusionsOf(profile, policy);

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

  // Gates: every registered Gatekeeper in this workspace, with its published Operations (one
  // batched query) and the platform's connector deny list (also one batched query —
  // `readGateLinkPoliciesForWorkspace`, joining workspace_gate_links → gate_instances → connectors
  // once for the whole workspace rather than once per gate).
  const gateEntries = await listGatekeepers(client, workspaceId);
  const publishedOps = await listPublishedOperationsForGatekeepers(
    client,
    workspaceId,
    gateEntries.map((entry) => entry.gatekeeperId),
  );
  const gateLinkPolicies = await readGateLinkPoliciesForWorkspace(client, workspaceId);
  const gateDefinitions = await readGateDefinitionsForWorkspace(client, workspaceId);
  const publishedByGate = new Map<
    string,
    { name: string; mode: string; digest: string | null }[]
  >();
  for (const op of publishedOps) {
    const list = publishedByGate.get(op.gatekeeperId);
    const entry = {
      name: op.name,
      mode: op.operation.mode,
      digest: operationRecordDigestOrNull(op),
    };
    if (list) list.push(entry);
    else publishedByGate.set(op.gatekeeperId, [entry]);
  }

  const granted = new Set(available.grantedGatekeeperIds);
  const inEntry = new Set(entryGatekeeperIds);

  const gates: GateReachability[] = gateEntries.map((entry) => {
    const gateId = entry.gatekeeperId;
    const gateLink = gateLinkPolicies.get(gateId);
    const published = publishedByGate.get(gateId) ?? [];
    const exclusion = observeGateExclusion(exclusions, gateId);
    const disabledOperations = published
      .filter((op) => operationPlatformStatus(gateLink, op.name).disabled)
      .map((op) => op.name);
    const definitions = gateDefinitions.get(gateId);
    const definitionMismatch: DefinitionMismatchWire[] = [];
    if (definitions) {
      for (const op of published) {
        if (disabledOperations.includes(op.name)) continue;
        const awaiting = definitionRefusal(definitions, op.name, op.digest);
        if (awaiting !== null) definitionMismatch.push({ operation: op.name, awaiting });
      }
    }
    const refused = new Set(definitionMismatch.map((entry) => entry.operation));
    const directOperations = published
      .filter(
        (op) =>
          !refused.has(op.name) &&
          observeRefusal(exclusions, {
            gatekeeperId: gateId,
            gateEnabled: true,
            operationName: op.name,
            publishedMode: op.mode,
            gateLink,
          }) === undefined,
      )
      .map((op) => op.name);
    const executeCount = published.filter((op) => op.mode === 'execute').length;
    const enabledObserveCount = published.filter(
      (op) =>
        op.mode !== 'execute' && !disabledOperations.includes(op.name) && !refused.has(op.name),
    ).length;
    const workerDefinitionIds = workers
      .filter((worker) => worker.childGateIds.includes(gateId))
      .map((worker) => worker.definitionId);
    const executeWorkerDefinitionIds = workerDefinitionIds.filter((id) =>
      requestActionWorkers.has(id),
    );
    const base = {
      gateId,
      name: entry.name,
      granted: granted.has(gateId),
      excludedByPolicy: exclusion === 'excluded_by_policy',
      excludedByProfile: exclusion === 'excluded_by_profile',
      inEntryScope: inEntry.has(gateId),
      observeOperationCount: published.length - executeCount,
      executeOperationCount: executeCount,
      disabledOperations,
      definitionMismatch,
      directOperations,
      workerDefinitionIds,
      executeWorkerDefinitionIds,
    };
    if (directOperations.length > 0) return { ...base, status: 'direct' as const };
    const reason = firstGap(base, enabledObserveCount);
    if (reason !== undefined) return { ...base, status: 'unreachable' as const, reason };
    return executeWorkerDefinitionIds.length > 0
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

/** Why a gate with no directly observable Operation is not reachable yet, before the Worker check.
 *  `not_granted` applies only when nothing observable is left on the gate (`enabledObserveCount`
 *  — observe-class Operations not on the platform deny list — is 0, so only the execute path
 *  remains): a gate that still has an enabled observe-class Operation and is not direct was refused
 *  by `observeRefusal` for an exclusion, never for a missing Grant. */
function firstGap(
  gate: {
    readonly granted: boolean;
    readonly excludedByPolicy: boolean;
    readonly excludedByProfile: boolean;
    readonly observeOperationCount: number;
    readonly executeOperationCount: number;
    readonly disabledOperations: readonly string[];
    readonly definitionMismatch: readonly DefinitionMismatchWire[];
  },
  enabledObserveCount: number,
): UnreachableReason | undefined {
  const publishedCount = gate.observeOperationCount + gate.executeOperationCount;
  if (publishedCount === 0) return 'no_published_operation';
  // Every published Operation this gate has is platform-disabled — `disabledOperations` is always a
  // subset of the gate's own published names, so equality with the total published count means none
  // of them survive.
  if (gate.disabledOperations.length === publishedCount) return 'disabled_by_platform';
  // Legacy K: the gate refuses every one that is left — `definitionMismatch` never names a
  // platform-disabled Operation, so the two lists are disjoint.
  if (gate.disabledOperations.length + gate.definitionMismatch.length === publishedCount) {
    return 'definition_mismatch';
  }
  if (!gate.granted && enabledObserveCount === 0) return 'not_granted';
  if (gate.excludedByPolicy) return 'excluded_by_policy';
  if (gate.excludedByProfile) return 'excluded_by_profile';
  return undefined;
}

/**
 * One published Operation's reachability for this member's entry agent:
 *
 *   - observe-class: `direct` exactly when `observeRefusal` accepted it (`directOperations`);
 *     otherwise the refusal — the platform deny list for this Operation, else the gate's
 *     AgentPolicy / AgentProfile exclusion. Never `not_granted`: observation needs no Grant.
 *   - execute-class: never direct — `via_worker` through a covering delegable Worker that declares
 *     `request_action`; otherwise `unreachable` with the first gap (platform deny list, not
 *     granted, policy cap, profile exclusion) or `no_worker`.
 *
 * `operationName` is checked against the gate's own `disabledOperations` first — a platform-disabled
 * Operation is `unreachable`/`disabled_by_platform` even when the gate itself still reads `direct`/
 * `via_worker` because one of its *other* Operations is still enabled (production incident
 * 2026-09-26: `find_operations` must flag exactly the Operation a real `request_action`/
 * `observe_operation` call would refuse, not just the gate it lives on). Then against its
 * `definitionMismatch` (legacy K), for the same reason: the gate refuses that one Operation.
 */
export function operationReachability(
  reachability: CapabilityReachability,
  gatekeeperId: string,
  mode: string,
  operationName: string,
): { readonly status: ReachabilityStatus; readonly reason?: UnreachableReason } {
  const gate = reachability.gates.find((entry) => entry.gateId === gatekeeperId);
  if (!gate) return { status: 'unreachable', reason: 'not_granted' };
  if (gate.disabledOperations.includes(operationName)) {
    return { status: 'unreachable', reason: 'disabled_by_platform' };
  }
  if (gate.definitionMismatch.some((entry) => entry.operation === operationName)) {
    return { status: 'unreachable', reason: 'definition_mismatch' };
  }
  if (mode !== 'execute') {
    if (gate.directOperations.includes(operationName)) return { status: 'direct' };
    if (gate.excludedByPolicy) return { status: 'unreachable', reason: 'excluded_by_policy' };
    if (gate.excludedByProfile) return { status: 'unreachable', reason: 'excluded_by_profile' };
    return { status: 'unreachable', reason: 'no_published_operation' };
  }
  if (!gate.granted) return { status: 'unreachable', reason: 'not_granted' };
  if (gate.excludedByPolicy) return { status: 'unreachable', reason: 'excluded_by_policy' };
  if (gate.excludedByProfile) return { status: 'unreachable', reason: 'excluded_by_profile' };
  return gate.executeWorkerDefinitionIds.length > 0
    ? { status: 'via_worker' }
    : { status: 'unreachable', reason: 'no_worker' };
}
