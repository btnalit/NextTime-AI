/**
 * lib/agent-profile: wire shapes for the S3.13 AgentProfile/AgentPolicy capabilities
 * (docs/development-tasks.md §S3.13). Written while the kernel half landed in a parallel PR; the
 * capabilities have since shipped and the interim "treat `not_found` as not deployed yet"
 * convention was retired in S6-A0 (B6). Field names follow the task brief verbatim; `null` on an
 * `AgentProfile` field means "inherit the workspace default" (§S3.13: "缺省 = 继承 AgentPolicy
 * 默认").
 */

/** One (workspace, principal) row — a `null` scalar means "inherit"; the three lists are
 *  *exclusion* lists (console redesign D1, governance 0012): `[]` excludes nothing, so a system
 *  granted or a Skill / Worker published later is picked up automatically. */
export interface AgentProfile {
  readonly principalId: string;
  readonly model: string | null;
  readonly excludedSkills: readonly string[];
  readonly excludedGatekeepers: readonly string[];
  readonly excludedWorkerDefinitions: readonly string[];
  readonly promptAddendum: string | null;
  /** R-21 / D-16: `false` narrows this principal; `null` (inherit) and `true` follow the
   *  workspace AgentPolicy, whose `allowMemberAutoApproveLow: false` is enforced for everyone. */
  readonly autoApproveLow: boolean | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** The systems the My Agent checklist offers (leftover 98): granted ones (read + write) plus
   *  every system readable without a Grant — before exclusions, not capped by the policy. */
  readonly availableGatekeepers: readonly AvailableGatekeeper[];
  /** Resolved — never `null`: the model / addendum fall back to the policy's defaults,
   *  `autoApproveLow` is the policy's value narrowed by the profile's own `false` (exactly what the
   *  kernel enforces on `request_action`), and each list is everything currently granted /
   *  published minus the exclusions, capped by the policy. `enabledGatekeepers` is the *granted*
   *  (read + write) set only. */
  readonly effective: EffectiveAgentProfile;
}

/** `AvailableGatekeeperWire` (packages/shared wire/identity): `granted` = the member holds a gate
 *  Grant (their agent may also act on it through a Worker); `inUse` = not unticked here and inside
 *  the workspace policy's gate cap, as the kernel decides it for every read. */
export interface AvailableGatekeeper {
  readonly gatekeeperId: string;
  readonly granted: boolean;
  readonly inUse: boolean;
}

export interface EffectiveAgentProfile {
  readonly model: string;
  readonly enabledSkills: readonly string[];
  readonly enabledGatekeepers: readonly string[];
  readonly enabledWorkerDefinitions: readonly string[];
  readonly promptAddendum: string;
  readonly autoApproveLow: boolean;
}

/** `set_agent_profile` params — every field optional, but this console's own editor
 *  (`components/AgentProfileForm.tsx`) always sends the full state of the other five fields on
 *  save (`null` for "reset to inherit", `[]` for "exclude nothing") rather than a partial diff, so
 *  a cleared field is unambiguously cleared rather than silently left at its previous override by
 *  omission. `autoApproveLow` is sent only when the reader changed it (R-21): `null` to follow the
 *  workspace, `false` to narrow — never `true`. */
export interface SetAgentProfileParams {
  readonly principalId?: string;
  readonly model?: string | null;
  readonly excludedSkills?: readonly string[];
  readonly excludedGatekeepers?: readonly string[];
  readonly excludedWorkerDefinitions?: readonly string[];
  readonly promptAddendum?: string | null;
  readonly autoApproveLow?: boolean | null;
}

export interface AgentPolicy {
  readonly workspaceId: string;
  readonly allowedModels: readonly string[];
  /** `null` = not set: the runtime uses the entry Worker's own model or its built-in default. */
  readonly defaultModel: string | null;
  readonly memberCanEditProfile: boolean;
  readonly maxPromptAddendumChars: number;
  /** Empty = unrestricted (§S3.13 AgentPolicy: "空 = 不限制") — never read as "nothing allowed". */
  readonly allowedSkills: readonly string[];
  readonly allowedGatekeepers: readonly string[];
  /** R-21 / D-16: `false` is enforced — low-blast-radius auto-approval is off for every requester
   *  in the workspace, whatever their profile says. Default `true`. */
  readonly allowMemberAutoApproveLow: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SetAgentPolicyParams {
  readonly allowedModels?: readonly string[];
  readonly defaultModel?: string | null;
  readonly memberCanEditProfile?: boolean;
  readonly maxPromptAddendumChars?: number;
  readonly allowedSkills?: readonly string[];
  readonly allowedGatekeepers?: readonly string[];
  readonly allowMemberAutoApproveLow?: boolean;
}

/** An empty allow-list means "unrestricted" throughout AgentPolicy (`allowedModels`/
 *  `allowedSkills`/`allowedGatekeepers`) — this intersects `available` with `allowed` only when
 *  `allowed` is non-empty, rather than a literal `Set` intersection that would (wrongly) narrow to
 *  nothing the moment a policy has never been set. */
export function narrowByPolicyAllowList<T>(
  available: readonly T[],
  allowed: readonly string[] | undefined,
  idOf: (item: T) => string,
): readonly T[] {
  if (!allowed || allowed.length === 0) return available;
  const allowedSet = new Set(allowed);
  return available.filter((item) => allowedSet.has(idOf(item)));
}

/** Field-name guess for a `set_agent_profile`/`set_agent_policy` 400 `invalid_params` message —
 *  same "map the kernel's prose to the field it's about" convention as
 *  `CompleteConnectionForm.tsx`'s `fieldForInvalidParams`. */
export function fieldForAgentProfileError(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('promptaddendum') || lower.includes('prompt_addendum')) {
    return 'promptAddendum';
  }
  if (lower.includes('autoapprovelow') || lower.includes('auto_approve_low')) {
    return 'autoApproveLow';
  }
  if (lower.includes('workerdefinition')) return 'excludedWorkerDefinitions';
  if (lower.includes('gatekeeper')) return 'excludedGatekeepers';
  if (lower.includes('skill')) return 'excludedSkills';
  if (lower.includes('model')) return 'model';
  return undefined;
}

/** Whether a caller of `role` may edit their own AgentProfile under `policy` — the kernel's own
 *  rule (`application/gateway/agent-profile-handlers.ts`, `set_agent_profile` on oneself): an
 *  owner always, anyone else only while `memberCanEditProfile` is on. `undefined` while either is
 *  not known yet (the kernel decides). The role's own capability check is `useRoleCan`'s. */
export function policyLetsEditOwnProfile(
  policy: AgentPolicy | undefined,
  role: string | null,
): boolean | undefined {
  if (policy === undefined || role === null) return undefined;
  return role === 'owner' || policy.memberCanEditProfile;
}
