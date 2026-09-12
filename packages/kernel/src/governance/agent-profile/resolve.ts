import type { AgentPolicyRow, AgentProfileRow } from './types.js';

/**
 * governance/agent-profile/resolve: the pure "apply AgentPolicy defaults/caps and the currently-
 * available resources to an AgentProfile" half of S3.13 (docs/development-tasks.md "每用户智能体配
 * 置：AgentProfile / AgentPolicy" — "effective 是应用 AgentPolicy 默认与该 principal 的 Grants 后的解
 * 析值"). No IO — takes an already-read `AgentProfileRow | undefined`, `AgentPolicyRow`, and the
 * caller-supplied `AvailableAgentResources`, returns the resolved, always-concrete
 * `EffectiveAgentProfile`.
 *
 * **`null` (inherit) resolves to "every currently available resource", never to "nothing" or to a
 * bare `null` on the wire** — this is the one load-bearing semantic decision this module makes,
 * and it is *not* a free judgment call: `packages/web`'s already-merged AgentProfile console
 * (`AgentProfileForm.tsx`/`AgentProfilePage.tsx`'s `EffectivePanel`, PR #101) was built against
 * exactly this reading of the shared task contract — "AgentProfile's `null` and an explicit empty
 * array are different effective states ('everything currently available' vs. 'explicitly
 * nothing')" (that PR's own commit message) — and calls `.length`/renders every `effective.*`
 * field as a concrete, non-nullable value (`EffectiveAgentProfile` in `lib/agent-profile.ts` has
 * no `| null` anywhere). Returning `null` here would not just be a stylistic mismatch, it would
 * make the already-shipped `EffectivePanel` throw on `effective.enabledSkills.length` the moment a
 * principal's Profile has never been touched. This module's own resolution therefore mirrors the
 * runtime behavior too (`application/host-bridge/agent-host-runtime.ts`'s Skill-mounting no longer
 * treats `null` as "mount nothing" — see that file's own doc comment): what the "当前生效" panel
 * displays and what the entry container actually does must never diverge.
 *
 * `AgentPolicyRow`'s `allowedSkills`/`allowedGatekeepers` remain *caps* — `[]` means "unrestricted"
 * (S3.13: "上限集合（空 = 不限制）"), a non-empty list means "never resolve wider than this set"
 * regardless of what the profile (or the available-resources ceiling) would otherwise include.
 */

/** The resources currently available to resolve `null` (inherit) against — computed by the
 *  caller, which has the DB access this module deliberately does not (governance may not depend
 *  on `application/worker`, the six-layer rule): every currently-*published* Skill id
 *  (`application/worker/skills.ts`'s `listPublishedSkillIds`), every Gatekeeper id the target
 *  principal currently holds an active `'gatekeeper'`-resource-type Grant for
 *  (`governance/capability`'s `listActiveGrantResourceScopes`), and every currently-*published*
 *  WorkerDefinition id (`application/worker/definitions.ts`'s `listWorkerDefinitions`). A caller
 *  that only needs `.model`/`.promptAddendum`/`.autoApproveLow` (never inspects the list fields)
 *  may pass `NO_AVAILABLE_AGENT_RESOURCES` below — those three fields never influence anything but
 *  the list fields this caller does not read. */
export interface AvailableAgentResources {
  readonly publishedSkillIds: readonly string[];
  readonly grantedGatekeeperIds: readonly string[];
  readonly publishedWorkerDefinitionIds: readonly string[];
}

/** The "I don't need the list fields" placeholder — safe for any caller that only reads
 *  `.model`/`.promptAddendum`/`.autoApproveLow` off the result (`application/task/invoke.ts`/
 *  `lifecycle.ts`'s model fallback, `application/gateway/request-action-handler.ts`'s
 *  `autoApproveLow` check): passing empty arrays here can only ever affect the *value* of fields
 *  those callers never look at. */
export const NO_AVAILABLE_AGENT_RESOURCES: AvailableAgentResources = {
  publishedSkillIds: [],
  grantedGatekeeperIds: [],
  publishedWorkerDefinitionIds: [],
};

export interface EffectiveAgentProfile {
  readonly model: string;
  readonly enabledSkills: readonly string[];
  readonly enabledGatekeepers: readonly string[];
  readonly enabledWorkerDefinitions: readonly string[];
  readonly promptAddendum: string;
  /** Always a concrete boolean — `AgentPolicyRow.allowMemberAutoApproveLow` is never itself
   *  nullable, so there is always a definite fallback once the profile's own `null` is resolved. */
  readonly autoApproveLow: boolean;
}

/**
 * `explicit` (a raw `AgentProfileRow` list field) resolved against `available` (the "inherit"
 * ceiling) and capped by `cap` (an `AgentPolicyRow` upper-bound list, `[]` = "no cap"). Never
 * returns something wider than either input allows:
 *   - `explicit` is `null`/`undefined` (inherit): resolves to `available` — every resource
 *     currently on offer, not "nothing".
 *   - `explicit` is a real (possibly empty) list: that list wins outright — an explicit `[]` means
 *     "nothing", genuinely different from `null`.
 *   - either way, `cap` (when non-empty) filters the result down further — a policy cap can only
 *     ever narrow, whether the profile expressed an explicit choice or inherited the full ceiling.
 */
function resolveList(
  explicit: readonly string[] | null | undefined,
  available: readonly string[],
  cap: readonly string[],
): readonly string[] {
  const base = explicit ?? available;
  if (cap.length === 0) return base;
  const allowed = new Set(cap);
  return base.filter((entry) => allowed.has(entry));
}

/**
 * P-A2 (docs/platform-admin-design.md §2 "自己的模型选择 … 可选范围由管理员在工作区配置里限定"):
 * `AgentPolicy.allowedModels` is a *cap* on the model too, not only a validation-time rule in
 * `set_agent_profile`. A profile whose `model` was picked before the administrator narrowed the
 * list (`set_allowed_models`) must not keep running on a model the workspace no longer allows —
 * it falls back to the entry model (`policy.defaultModel`) when that is itself allowed, else to
 * `''` ("nothing configured anywhere", the runtime's own "use the entry WorkerDefinition's model /
 * pi default" signal). `[]` keeps its S3.13 meaning: unrestricted.
 */
function resolveModel(explicit: string | null | undefined, policy: AgentPolicyRow): string {
  const allowed = policy.allowedModels;
  const isAllowed = (model: string): boolean => allowed.length === 0 || allowed.includes(model);
  if (explicit && isAllowed(explicit)) return explicit;
  if (policy.defaultModel && isAllowed(policy.defaultModel)) return policy.defaultModel;
  return '';
}

export function resolveEffectiveAgentProfile(
  profile: AgentProfileRow | undefined,
  policy: AgentPolicyRow,
  available: AvailableAgentResources,
): EffectiveAgentProfile {
  return {
    model: resolveModel(profile?.model, policy),
    enabledSkills: resolveList(
      profile?.enabledSkills,
      available.publishedSkillIds,
      policy.allowedSkills,
    ),
    enabledGatekeepers: resolveList(
      profile?.enabledGatekeepers,
      available.grantedGatekeeperIds,
      policy.allowedGatekeepers,
    ),
    enabledWorkerDefinitions:
      profile?.enabledWorkerDefinitions ?? available.publishedWorkerDefinitionIds,
    promptAddendum: profile?.promptAddendum ?? '',
    autoApproveLow: profile?.autoApproveLow ?? policy.allowMemberAutoApproveLow,
  };
}
