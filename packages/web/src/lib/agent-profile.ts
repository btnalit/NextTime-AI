/**
 * lib/agent-profile: wire shapes for the S3.13 AgentProfile/AgentPolicy capabilities this PR's web
 * half codes against (the task's "Contract you code against" section — the kernel half is landing
 * in a parallel PR against the same names/shapes; see docs/development-tasks.md §S3.13). None of
 * these capabilities exist in `@nexttime/shared`'s `CAPABILITY_REGISTRY` yet on `main` as of this
 * PR — every page reading them treats a `not_found` response as "not deployed yet"
 * (`lib/errors.ts` `isNotFoundError`), the same convention `lib/governance.ts`'s own doc comment
 * established for the S3.11 capabilities. Field names follow the task brief verbatim; `null` on
 * an `AgentProfile` field means "inherit the workspace default" (§S3.13: "缺省 = 继承 AgentPolicy
 * 默认").
 */

/** One (workspace, principal) row — every field `null` means "inherit". */
export interface AgentProfile {
  readonly principalId: string;
  readonly model: string | null;
  readonly enabledSkills: readonly string[] | null;
  readonly enabledGatekeepers: readonly string[] | null;
  readonly enabledWorkerDefinitions: readonly string[] | null;
  readonly promptAddendum: string | null;
  readonly autoApproveLow: boolean | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** The same six fields, resolved against `AgentPolicy` — never `null`: an unset field falls
   *  back to the policy's own default (`defaultModel`, an empty allow-list read as "every
   *  published Skill/Gatekeeper", `promptAddendum: ''`, `autoApproveLow: false`). */
  readonly effective: EffectiveAgentProfile;
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
 *  (`components/AgentProfilePage.tsx`) always sends the full six-field state on save (`null` for
 *  "reset to inherit") rather than a partial diff, so a cleared field is unambiguously cleared
 *  rather than silently left at its previous override by omission. */
export interface SetAgentProfileParams {
  readonly principalId?: string;
  readonly model?: string | null;
  readonly enabledSkills?: readonly string[] | null;
  readonly enabledGatekeepers?: readonly string[] | null;
  readonly enabledWorkerDefinitions?: readonly string[] | null;
  readonly promptAddendum?: string | null;
  readonly autoApproveLow?: boolean | null;
}

export interface AgentPolicy {
  readonly workspaceId: string;
  readonly allowedModels: readonly string[];
  readonly defaultModel: string;
  readonly memberCanEditProfile: boolean;
  readonly maxPromptAddendumChars: number;
  /** Empty = unrestricted (§S3.13 AgentPolicy: "空 = 不限制") — never read as "nothing allowed". */
  readonly allowedSkills: readonly string[];
  readonly allowedGatekeepers: readonly string[];
  readonly allowMemberAutoApproveLow: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SetAgentPolicyParams {
  readonly allowedModels?: readonly string[];
  readonly defaultModel?: string;
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
  if (lower.includes('workerdefinition')) return 'enabledWorkerDefinitions';
  if (lower.includes('gatekeeper')) return 'enabledGatekeepers';
  if (lower.includes('skill')) return 'enabledSkills';
  if (lower.includes('model')) return 'model';
  return undefined;
}
