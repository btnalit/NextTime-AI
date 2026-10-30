import type { PoolClient } from 'pg';
import type { AgentPolicyRow, AgentProfileRow } from '../../governance/agent-profile/index.js';
import { readAgentPolicy, readAgentProfile } from '../../governance/agent-profile/index.js';
import { listPublishedOperationsForGatekeepers } from '../../governance/gatekeepers/index.js';
import {
  type GatekeeperPlatformPolicy,
  operationPlatformStatus,
  readGatekeeperPlatformPolicies,
} from './store.js';

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
 *      member's own AgentProfile (the Handle's `obo` — for a Worker, the member it acts for), nor —
 *      for a Worker whose Task sets an observation scope (S11 GO11, S10 I-E1) — outside that
 *      scope. The Task scope is one more source of exclusions for the same condition, never another
 *      predicate: a Task scope only narrows what the member's agent may observe.
 *
 * No gate Grant, no `resources.gatekeeper`: a Handle's gate scope now means *execute* authority
 * only (Grant-derived, attenuated per Worker) and never decides observation. The human channel
 * (a person reading from the console) needs no Grant either since leftover 97 (maintainer
 * 2026-09-27 "也放开吧"): `observe_operation` calls this with `NO_OBSERVE_EXCLUSIONS` — condition 4
 * is about the member's *agent* (AgentPolicy / AgentProfile, S3.13), not the person's own reads —
 * and keeps only the role rule (`auditor` never reaches a Gatekeeper). Every observation is still
 * audited by `dispatch.ts` exactly as before; this module decides nothing about audit.
 *
 * Consumers (the Sept-26 lesson: a read model re-deriving enforcement is how the production
 * incident happened — each of these calls this function, none re-implements it):
 * `observe_operation` and `request_action`'s observe branch (enforcement,
 * application/gateway/request-action-handler.ts), `list_allowed_operations` (the tool list every
 * pi mode and the MCP server project, application/gateway/worker-result-handler.ts),
 * `computeCapabilityReachability` (execution_readiness + find_operations' annotation,
 * application/gateway/capability-reachability.ts), `find_procedures`' observe steps
 * (application/task/service.ts), the My Agent checklist's "readable but not granted" systems
 * (`observableGatekeeperIds` below, application/gateway/agent-profile-handlers.ts), and S11 GO3d's
 * reconcile checks — a goal plan's declared check, validated with `NO_OBSERVE_EXCLUSIONS`
 * (application/goal/plan.ts), and the platform's observation itself, made for the requester with
 * their agent exclusions (application/goal/reconcile-check.ts). The Handle-caller consumers read
 * their exclusions with `readHandleObserveExclusions` (application/task/observe-scope.ts), which
 * adds the session's Task scope; the member-level read models (execution readiness, My Agent) and
 * the platform's observation describe no Task.
 */

/** S11 GO11: the observation scope of the Task a calling Worker runs (`tasks.observe_scope`,
 *  migrations/task/0010) — only these gates. Read per call from the Handle's session
 *  (`readSessionTaskObserveScope`, application/task/observe-scope.ts), never from the Handle. */
export interface TaskObserveScope {
  readonly taskId: string;
  readonly gatekeeperIds: readonly string[];
}

/** The inputs condition 4 needs, read once per caller. */
export interface ObserveExclusions {
  /** `AgentPolicy.allowedGatekeepers` — `[]` means no cap (S3.13 "上限集合（空 = 不限制）"). */
  readonly policyAllowedGatekeepers: readonly string[];
  /** The calling member's own `AgentProfile.excludedGatekeepers` (governance 0012). */
  readonly profileExcludedGatekeepers: readonly string[];
  /** S11 GO11: the calling Worker's Task's observation scope — unlike the policy cap, `[]` here
   *  means no gate at all. `null`: the caller is not a Worker of a scoped Task (a member's agent
   *  outside any Task, the human channel, the platform observing for a requester). */
  readonly taskScope: TaskObserveScope | null;
}

/** No cap, no exclusion and no Task — the human channel (a person's own reads), and "readable by
 *  anyone in the workspace" before a member's own agent settings narrow it
 *  (`observableGatekeeperIds`). */
export const NO_OBSERVE_EXCLUSIONS: ObserveExclusions = Object.freeze({
  policyAllowedGatekeepers: [],
  profileExcludedGatekeepers: [],
  taskScope: null,
});

/** A member's agent as such, from rows a caller already read (`computeCapabilityReachability`
 *  reads both anyway) — the member-level read models (execution readiness, My Agent), which
 *  describe no Task and so carry no Task scope. */
export function observeExclusionsOf(
  profile: AgentProfileRow | undefined,
  policy: AgentPolicyRow,
): ObserveExclusions {
  return {
    policyAllowedGatekeepers: policy.allowedGatekeepers,
    profileExcludedGatekeepers: profile?.excludedGatekeepers ?? [],
    taskScope: null,
  };
}

/** `taskScope` is required, so each caller states whether a Task narrows this observation: a
 *  Handle caller passes its session's (application/task/observe-scope.ts's
 *  `readHandleObserveExclusions` does both reads), the platform's own observation passes `null`. */
export async function readObserveExclusions(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  taskScope: TaskObserveScope | null,
): Promise<ObserveExclusions> {
  // One client, one query at a time (pg rejects concurrent queries on a client).
  const profile = await readAgentProfile(client, workspaceId, principalId);
  const policy = await readAgentPolicy(client, workspaceId);
  return { ...observeExclusionsOf(profile, policy), taskScope };
}

export type ObserveGateExclusion = 'excluded_by_policy' | 'excluded_by_profile';

/** Which policy an `excluded_by_policy` comes from — the workspace AgentPolicy gate cap (an owner
 *  changes it on Models & Quotas) or the calling Worker's Task's observation scope (fixed when the
 *  Task was created). Same reason code either way (S10 I-E1 "复用现有谓词，不新造判定"); the error
 *  text says which. */
export type ObserveGateRefusal =
  | { readonly reason: 'excluded_by_policy'; readonly policy: 'agent_policy' }
  | {
      readonly reason: 'excluded_by_policy';
      readonly policy: 'task_scope';
      readonly taskId: string;
    }
  | { readonly reason: 'excluded_by_profile' };

/** Condition 4 with where it comes from. The Task's scope first: a Worker of a scoped Task is told
 *  about the bound its Task fixed — no owner can lift it for this Task — before the workspace cap,
 *  then the member's own exclusion. */
export function observeGateRefusal(
  exclusions: ObserveExclusions,
  gatekeeperId: string,
): ObserveGateRefusal | undefined {
  const task = exclusions.taskScope;
  if (task !== null && !task.gatekeeperIds.includes(gatekeeperId)) {
    return { reason: 'excluded_by_policy', policy: 'task_scope', taskId: task.taskId };
  }
  const cap = exclusions.policyAllowedGatekeepers;
  if (cap.length > 0 && !cap.includes(gatekeeperId)) {
    return { reason: 'excluded_by_policy', policy: 'agent_policy' };
  }
  if (exclusions.profileExcludedGatekeepers.includes(gatekeeperId)) {
    return { reason: 'excluded_by_profile' };
  }
  return undefined;
}

/** Condition 4 alone — the gate-level half of `observeRefusal`, exposed so the reachability read
 *  model can flag a gate as excluded without an Operation in hand. Same rule
 *  `resolveEffectiveAgentProfile`'s `resolveList` applies to the execute side (profile exclusion,
 *  then the policy cap), reported policy-first like the reachability reason order. */
export function observeGateExclusion(
  exclusions: ObserveExclusions,
  gatekeeperId: string,
): ObserveGateExclusion | undefined {
  return observeGateRefusal(exclusions, gatekeeperId)?.reason;
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
  /** `readGatekeeperPlatformPolicy` / `readGatekeeperPlatformPolicies` — the gate's origin and the
   *  platform's cut-off for it (catalog: connector deny list; self: suspension). */
  readonly platformPolicy: GatekeeperPlatformPolicy | null | undefined;
}

export type ObserveRefusal =
  | { readonly reason: 'gate_not_enabled' }
  | {
      readonly reason: 'disabled_by_platform';
      readonly connector: string;
      readonly cutoff: 'connector_deny_list' | 'self_connection_suspended';
    }
  | { readonly reason: 'no_published_operation' }
  | { readonly reason: 'not_observe_class'; readonly mode: string }
  | ObserveGateRefusal;

/** `undefined` = the caller may observe; otherwise the first unmet condition, in the order above
 *  (the order enforcement has always refused in, so error shapes are unchanged). */
export function observeRefusal(
  exclusions: ObserveExclusions,
  target: ObserveTarget,
): ObserveRefusal | undefined {
  if (!target.gateEnabled) return { reason: 'gate_not_enabled' };
  const platform = operationPlatformStatus(target.platformPolicy, target.operationName);
  if (platform.disabled) {
    return {
      reason: 'disabled_by_platform',
      connector: platform.connector ?? '',
      cutoff: platform.reason ?? 'connector_deny_list',
    };
  }
  if (target.publishedMode === undefined) return { reason: 'no_published_operation' };
  if (target.publishedMode !== 'observe') {
    return { reason: 'not_observe_class', mode: target.publishedMode };
  }
  return observeGateRefusal(exclusions, target.gatekeeperId);
}

/**
 * The gates among `gatekeeperIds` (registered Gatekeepers of this workspace — callers pass
 * `listGatekeepers`' ids) that have at least one published Operation `observeRefusal` accepts with
 * `NO_OBSERVE_EXCLUSIONS`: readable by any member's agent before that member's own AgentProfile /
 * the workspace AgentPolicy cap narrow it. The My Agent checklist offers these next to the
 * member's granted gates, so a member can exclude a system their agent may read without a Grant
 * (leftover 98, application/gateway/agent-profile-handlers.ts). Same predicate, same inputs
 * (published Operations, the platform deny list) as every enforcement point — never re-derived.
 */
export async function observableGatekeeperIds(
  client: PoolClient,
  workspaceId: string,
  gatekeeperIds: readonly string[],
): Promise<ReadonlySet<string>> {
  // One client, one query at a time (pg rejects concurrent queries on a client).
  const published = await listPublishedOperationsForGatekeepers(client, workspaceId, gatekeeperIds);
  const platformPolicies = await readGatekeeperPlatformPolicies(client, workspaceId);
  const observable = new Set<string>();
  for (const record of published) {
    if (observable.has(record.gatekeeperId)) continue;
    const refusal = observeRefusal(NO_OBSERVE_EXCLUSIONS, {
      gatekeeperId: record.gatekeeperId,
      gateEnabled: true,
      operationName: record.name,
      publishedMode: record.operation.mode,
      platformPolicy: platformPolicies.get(record.gatekeeperId),
    });
    if (refusal === undefined) observable.add(record.gatekeeperId);
  }
  return observable;
}
