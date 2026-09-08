import type { AgentPolicyRow, AgentProfileRow } from './types.js';

/**
 * governance/agent-profile/resolve: the pure "apply AgentPolicy defaults to an AgentProfile" half
 * of S3.13 (docs/development-tasks.md "每用户智能体配置：AgentProfile / AgentPolicy" — "effective 是
 * 应用 AgentPolicy 默认与该 principal 的 Grants 后的解析值"). No IO — takes an already-read
 * `AgentProfileRow | undefined` and `AgentPolicyRow`, returns the resolved `EffectiveAgentProfile`.
 * Deliberately does **not** take the principal's current Grants: the Grant-intersection half of
 * "never widen" (entry Handle scope = Grant ∩ Profile) happens where the Grant list already lives
 * — `application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle`, which already computes
 * the principal's granted Gatekeeper ids for the entry Handle and intersects `effective
 * .enabledGatekeepers` into that same computation — folding it in here would require this "pure,
 * unit-testable in isolation" module to accept a DB client for no benefit (the intersection is one
 * `Set` filter either place).
 *
 * `null` is the "inherit"/"no restriction" sentinel throughout `AgentProfileRow`'s own fields
 * (S3.13 ontology: "缺省 = 继承 AgentPolicy 默认"); `AgentPolicyRow`'s `allowedSkills`/
 * `allowedGatekeepers` are *caps* — `[]` means "unrestricted" (S3.13: "上限集合（空 = 不限制）"), a
 * non-empty list means "never resolve wider than this set" regardless of what the profile itself
 * asked for. `intersectCapped` below is the one place that combines the two conventions.
 */

export interface EffectiveAgentProfile {
  readonly model: string | null;
  /** `null` = "the profile expresses no restriction of its own" — what a `null` value means at the
   *  point of use is each consumer's own call (documented there): `application/host-bridge/
   *  agent-host-runtime.ts`'s gate-intersection treats a `null` `enabledGatekeepers` as "every
   *  Gatekeeper the principal is currently Granted" (the pre-existing ceiling, unaffected by
   *  Profile); that same file's Skill-mounting step deliberately treats a `null` `enabledSkills` as
   *  "mount nothing" rather than "every published Skill" — entry containers mounted zero Skills
   *  before S3.13 existed, and expanding that to "everything published" merely because a principal
   *  has never touched their own Profile would be a surprising, unrequested widening of every
   *  existing workspace's entry-agent behavior the moment this ships. A principal who wants Skills
   *  mounted must name them.
   */
  readonly enabledSkills: readonly string[] | null;
  readonly enabledGatekeepers: readonly string[] | null;
  readonly enabledWorkerDefinitions: readonly string[] | null;
  readonly promptAddendum: string | null;
  /** Always a concrete boolean — `AgentPolicyRow.allowMemberAutoApproveLow` is never itself
   *  nullable, so there is always a definite fallback once the profile's own `null` is resolved. */
  readonly autoApproveLow: boolean;
}

/**
 * `value` (a raw `AgentProfileRow` field, `null` = "no restriction from the profile") capped by
 * `cap` (an `AgentPolicyRow` upper-bound list, `[]` = "no cap"). Never returns something wider than
 * either input allows:
 *   - no cap (`cap.length === 0`): the profile's own value passes through unchanged (including
 *     `null`, "no restriction at all").
 *   - a cap, profile `null`: the cap itself becomes the effective (explicit) list — "inherit" now
 *     resolves to exactly what the workspace currently allows, not literally everything.
 *   - a cap, profile non-null: filtered to the intersection — the profile can only ever narrow
 *     further than the cap, never escape it.
 */
function intersectCapped(
  value: readonly string[] | null,
  cap: readonly string[],
): readonly string[] | null {
  if (cap.length === 0) return value;
  if (value === null) return [...cap];
  const allowed = new Set(cap);
  return value.filter((entry) => allowed.has(entry));
}

export function resolveEffectiveAgentProfile(
  profile: AgentProfileRow | undefined,
  policy: AgentPolicyRow,
): EffectiveAgentProfile {
  return {
    model: profile?.model ?? policy.defaultModel,
    enabledSkills: intersectCapped(profile?.enabledSkills ?? null, policy.allowedSkills),
    enabledGatekeepers: intersectCapped(
      profile?.enabledGatekeepers ?? null,
      policy.allowedGatekeepers,
    ),
    enabledWorkerDefinitions: profile?.enabledWorkerDefinitions ?? null,
    promptAddendum: profile?.promptAddendum ?? null,
    autoApproveLow: profile?.autoApproveLow ?? policy.allowMemberAutoApproveLow,
  };
}
