/**
 * governance/agent-profile/types: the `AgentProfileRow`/`AgentPolicyRow` row shapes — split out of
 * `store.ts` into their own file so `resolve.ts` (pure) can depend on the shapes without importing
 * `store.ts` (IO) itself, which would otherwise create a same-module import cycle
 * (`store.ts` imports `resolveEffectiveAgentProfile` from `resolve.ts` for its own
 * `readEffectiveAgentProfile` convenience — `pnpm depcruise`'s `no-circular` check flagged the
 * two-file version of this split). No logic here, mirrors `application/task/types.ts`'s own
 * "row shapes live in their own file" convention.
 */

export interface AgentProfileRow {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly model: string | null;
  readonly enabledSkills: readonly string[] | null;
  readonly enabledGatekeepers: readonly string[] | null;
  readonly enabledWorkerDefinitions: readonly string[] | null;
  readonly promptAddendum: string | null;
  readonly autoApproveLow: boolean | null;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
}

export interface AgentPolicyRow {
  readonly workspaceId: string;
  readonly allowedModels: readonly string[];
  readonly defaultModel: string | null;
  readonly memberCanEditProfile: boolean;
  readonly maxPromptAddendumChars: number;
  readonly allowedSkills: readonly string[];
  readonly allowedGatekeepers: readonly string[];
  readonly allowMemberAutoApproveLow: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
}
