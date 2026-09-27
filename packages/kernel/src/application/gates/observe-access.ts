import type { PoolClient } from 'pg';
import type { AgentPolicyRow, AgentProfileRow } from '../../governance/agent-profile/index.js';
import { readAgentPolicy, readAgentProfile } from '../../governance/agent-profile/index.js';
import { type GateLinkPolicyView, operationPlatformStatus } from './store.js';

/**
 * application/gates/observe-access: the one predicate for "may this Handle caller observe through
 * this gate's Operation" (design doc §11 "门上的观察"; decision D4 revoked 2026-09-27 — the
 * maintainer confirmed "只读调用不需要授权"). An observe-class Operation is callable by any Handle
 * in the workspace when:
 *
 *   1. the gate is enabled in this workspace (a registered Gatekeeper);
 *   2. the Operation is not on the platform connector deny list (`operationPlatformStatus`, the
 *      shared deny-list predicate — checked before "published", matching the order enforcement
 *      has always refused in);
 *   3. the Operation is published and observe-class;
 *   4. the gate is not left out by the workspace AgentPolicy gate cap, nor excluded by the calling
 *      member's own AgentProfile (the Handle's `obo` — for a Worker, the member it acts for).
 *
 * No gate Grant, no `resources.gatekeeper`: a Handle's gate scope now means *execute* authority
 * only (Grant-derived, attenuated per Worker) and never decides observation. The human channel
 * keeps its own Grant check (`assertHumanGatekeeperAccess`, request-action-handler.ts) and calls
 * this with `NO_OBSERVE_EXCLUSIONS` — the maintainer has not decided that channel yet. Every
 * observation is still audited by `dispatch.ts` exactly as before; this module decides nothing
 * about audit.
 *
 * Consumers (the Sept-26 lesson: a read model re-deriving enforcement is how the production
 * incident happened — each of these calls this function, none re-implements it):
 * `observe_operation` and `request_action`'s observe branch (enforcement,
 * application/gateway/request-action-handler.ts), `list_allowed_operations` (the tool list every
 * pi mode and the MCP server project, application/gateway/worker-result-handler.ts),
 * `computeCapabilityReachability` (execution_readiness + find_operations' annotation,
 * application/gateway/capability-reachability.ts) and `find_procedures`' observe steps
 * (application/task/service.ts).
 */

/** The two inputs condition 4 needs, read once per caller. */
export interface ObserveExclusions {
  /** `AgentPolicy.allowedGatekeepers` — `[]` means no cap (S3.13 "上限集合（空 = 不限制）"). */
  readonly policyAllowedGatekeepers: readonly string[];
  /** The calling member's own `AgentProfile.excludedGatekeepers` (governance 0012). */
  readonly profileExcludedGatekeepers: readonly string[];
}

/** No cap and no exclusion — the human channel, whose observation check is its Grant. */
export const NO_OBSERVE_EXCLUSIONS: ObserveExclusions = Object.freeze({
  policyAllowedGatekeepers: [],
  profileExcludedGatekeepers: [],
});

/** From rows a caller already read (`computeCapabilityReachability` reads both anyway). */
export function observeExclusionsOf(
  profile: AgentProfileRow | undefined,
  policy: AgentPolicyRow,
): ObserveExclusions {
  return {
    policyAllowedGatekeepers: policy.allowedGatekeepers,
    profileExcludedGatekeepers: profile?.excludedGatekeepers ?? [],
  };
}

export async function readObserveExclusions(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<ObserveExclusions> {
  // One client, one query at a time (pg rejects concurrent queries on a client).
  const profile = await readAgentProfile(client, workspaceId, principalId);
  const policy = await readAgentPolicy(client, workspaceId);
  return observeExclusionsOf(profile, policy);
}

export type ObserveGateExclusion = 'excluded_by_policy' | 'excluded_by_profile';

/** Condition 4 alone — the gate-level half of `observeRefusal`, exposed so the reachability read
 *  model can flag a gate as excluded without an Operation in hand. Same rule
 *  `resolveEffectiveAgentProfile`'s `resolveList` applies to the execute side (profile exclusion,
 *  then the policy cap), reported policy-first like the reachability reason order. */
export function observeGateExclusion(
  exclusions: ObserveExclusions,
  gatekeeperId: string,
): ObserveGateExclusion | undefined {
  const cap = exclusions.policyAllowedGatekeepers;
  if (cap.length > 0 && !cap.includes(gatekeeperId)) return 'excluded_by_policy';
  if (exclusions.profileExcludedGatekeepers.includes(gatekeeperId)) return 'excluded_by_profile';
  return undefined;
}

/** The facts about one (gate, Operation) pair the predicate decides on — every consumer already
 *  reads them (enforcement one at a time, the read models batched). */
export interface ObserveTarget {
  readonly gatekeeperId: string;
  /** A Gatekeeper with this id is registered in this workspace. */
  readonly gateEnabled: boolean;
  readonly operationName: string;
  /** The published Operation's `mode`; `undefined` when it is not published (draft / unknown). */
  readonly publishedMode: string | undefined;
  /** `readGateLinkPolicy` / `readGateLinkPoliciesForWorkspace` — absent for a gate the workspace
   *  connected itself (no platform deny list applies). */
  readonly gateLink: GateLinkPolicyView | null | undefined;
}

export type ObserveRefusal =
  | { readonly reason: 'gate_not_enabled' }
  | { readonly reason: 'disabled_by_platform'; readonly connector: string }
  | { readonly reason: 'no_published_operation' }
  | { readonly reason: 'not_observe_class'; readonly mode: string }
  | { readonly reason: ObserveGateExclusion };

/** `undefined` = the caller may observe; otherwise the first unmet condition, in the order above
 *  (the order enforcement has always refused in, so error shapes are unchanged). */
export function observeRefusal(
  exclusions: ObserveExclusions,
  target: ObserveTarget,
): ObserveRefusal | undefined {
  if (!target.gateEnabled) return { reason: 'gate_not_enabled' };
  const platform = operationPlatformStatus(target.gateLink, target.operationName);
  if (platform.disabled) {
    return { reason: 'disabled_by_platform', connector: platform.connector ?? '' };
  }
  if (target.publishedMode === undefined) return { reason: 'no_published_operation' };
  if (target.publishedMode !== 'observe') {
    return { reason: 'not_observe_class', mode: target.publishedMode };
  }
  const exclusion = observeGateExclusion(exclusions, target.gatekeeperId);
  return exclusion === undefined ? undefined : { reason: exclusion };
}
