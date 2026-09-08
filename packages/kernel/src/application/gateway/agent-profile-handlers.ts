import type { PoolClient } from 'pg';
import type {
  AgentPolicyRow,
  AgentProfileRow,
  EffectiveAgentProfile,
  SetAgentPolicyFields,
  SetAgentProfileFields,
} from '../../governance/agent-profile/index.js';
import {
  readAgentPolicy,
  readAgentProfile,
  resolveEffectiveAgentProfile,
  setAgentPolicy,
  setAgentProfile,
} from '../../governance/agent-profile/index.js';
import {
  GATEKEEPER_GRANT_CAPABILITY,
  isWorkspaceOwner,
  listActiveGrantResourceScopes,
  revokeEntrySessionHandles,
} from '../../governance/capability/index.js';
import { listGatekeepers } from '../../governance/gatekeepers/index.js';
import { resolvePublishedSkills } from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { PrincipalNotFoundError } from './members-handlers.js';
import { readModelCatalog } from './models-catalog-handler.js';

/**
 * application/gateway/agent-profile-handlers: the S3.13 "每用户智能体配置" capabilities
 * (docs/development-tasks.md — "AgentProfile / AgentPolicy") — `get_agent_profile` /
 * `set_agent_profile` / `get_agent_policy` / `set_agent_policy`. Storage and the pure
 * policy-resolution rules live in `governance/agent-profile` (this module's own row/effective-value
 * source of truth, per that module's "owns its own tables, other modules go through its published
 * interface" contract, the same shape every other governance submodule already follows); this file
 * is the capability-handler projection plus the write-side validation that has to reach across
 * several other modules' own read APIs (`application/worker`'s published-Skill lookup,
 * `governance/capability`'s Grant lookup, `governance/gatekeepers`'s registry, this same
 * directory's own `models-catalog-handler.ts`) — validation that `governance/agent-profile` itself
 * cannot perform without violating the six-layer rule (governance may not depend on application).
 *
 * Authorization shape (same "minRole gates entry, the handler narrows further" convention
 * `members-handlers.ts`'s own module doc comment already established for `rotate_api_key`):
 *   - `get_agent_profile`/`set_agent_profile`'s registry `minRole` is `'member'` (any authenticated
 *     principal may call it for *themselves*); this handler additionally requires the caller be an
 *     owner to name a *different* `principalId`, and (`set_agent_profile` only) requires the
 *     workspace's own `AgentPolicy.memberCanEditProfile` to be true for a non-owner editing their
 *     own profile.
 *   - `set_agent_profile`'s validation never widens past the principal's own Grants or the
 *     workspace's AgentPolicy caps (S3.13's own core invariant: "Profile 是 Grant 的子集投影，永不扩
 *     权") — every field below is checked against the *actual current* set (published Skills,
 *     active Grants, the llm-proxy model whitelist), not merely schema-shape-valid.
 *   - `set_agent_policy`'s registry `minRole` is `'owner'` outright — no non-owner path exists, so
 *     no additional handler-level role check is needed (the same shape `set_policy`/`set_quota`
 *     already use).
 *
 * Change propagation: `set_agent_profile` revokes the target principal's `kind='entry'` session
 * Handles (`revokeEntrySessionHandles`, the exact same path Grant changes already use —
 * `governance/capability/grants.ts`'s own doc comment) inside the same transaction as the profile
 * write, so a concurrent read of the (now-stale) Handle can never outlive the write that
 * invalidated it. `application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle` mints a
 * fresh Handle on the target's very next Turn, which `worker-supervisor`'s existing jti-rotation
 * recreate logic (`resident-service.ts`) picks up automatically — no second, bespoke propagation
 * mechanism for this task to invent.
 */

export class AgentProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProfileValidationError';
  }
}

async function assertPrincipalExists(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  const result = await client.query(
    'select 1 from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  if ((result.rowCount ?? 0) === 0) throw new PrincipalNotFoundError(workspaceId, principalId);
}

// -------------------------------------------------------------------------------------------
// set_agent_profile validation — every check here reads the *actual current* state (published
// Skills, active Grants, the model whitelist), never merely re-checks the wire schema (dispatch.ts
// already did that) — see this file's own module doc comment.
// -------------------------------------------------------------------------------------------

async function assertModelAllowed(model: string, policy: AgentPolicyRow): Promise<void> {
  const catalog = await readModelCatalog();
  const known = new Set(catalog.map((entry) => entry.id));
  if (!known.has(model)) {
    throw new AgentProfileValidationError(
      `set_agent_profile: model "${model}" is not in the llm-proxy model whitelist (list_models)`,
    );
  }
  if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(model)) {
    throw new AgentProfileValidationError(
      `set_agent_profile: model "${model}" is not in this workspace's AgentPolicy.allowedModels`,
    );
  }
}

/** `refs` may name a published Skill by `id` or by `name` (the same "id-or-name" convention a
 *  WorkerDefinition's own `skills[]` field already uses, `application/worker/skills.ts`'s
 *  `resolvePublishedSkills` doc comment) — every ref not resolving to a currently-published Skill
 *  is reported by name in one error, not just "something didn't resolve". */
async function assertSkillsPublished(
  client: PoolClient,
  workspaceId: string,
  refs: readonly string[],
): Promise<void> {
  if (refs.length === 0) return;
  const resolved = await resolvePublishedSkills(client, workspaceId, refs);
  const known = new Set<string>();
  for (const skill of resolved) {
    known.add(skill.id);
    known.add(skill.name);
  }
  const unresolved = refs.filter((ref) => !known.has(ref));
  if (unresolved.length > 0) {
    throw new AgentProfileValidationError(
      `set_agent_profile: enabledSkills references Skill(s) that are not published: ${unresolved.join(', ')}`,
    );
  }
}

/** I14 owner override reused verbatim (`governance/capability/grants.ts`'s own `isWorkspaceOwner` —
 *  "the workspace owner counts as holding every scope"): when `targetPrincipalId` is an owner, any
 *  currently-registered Gatekeeper in the workspace is an allowed id; otherwise only Gatekeepers
 *  `targetPrincipalId` holds an active `'gatekeeper'`-resource-type Grant for. */
async function assertGatekeepersAccessible(
  client: PoolClient,
  workspaceId: string,
  targetPrincipalId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const targetIsOwner = await isWorkspaceOwner(client, workspaceId, targetPrincipalId);
  const allowed = targetIsOwner
    ? new Set((await listGatekeepers(client, workspaceId)).map((entry) => entry.gatekeeperId))
    : new Set(
        await listActiveGrantResourceScopes(client, workspaceId, {
          principalId: targetPrincipalId,
          resourceType: GATEKEEPER_GRANT_CAPABILITY,
        }),
      );
  const missing = ids.filter((id) => !allowed.has(id));
  if (missing.length > 0) {
    throw new AgentProfileValidationError(
      `set_agent_profile: enabledGatekeepers references Gatekeeper(s) the principal holds no active Grant for: ${missing.join(', ')}`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// Wire projection (docs/wire-contract-conventions.md §2 — one projection function, application
// layer). AgentProfile's own identity field is `principalId` (not `id`) — its natural key is the
// (workspace, principal) pair, the same "no synthetic id for a singleton-per-key resource" shape
// `AgentPolicy` below already needs too (its own key is `workspaceId` alone); the fixed wire
// contract this task implements against names both fields explicitly.
// -------------------------------------------------------------------------------------------

function toWireAgentProfile(
  principalId: string,
  profile: AgentProfileRow | undefined,
  effective: EffectiveAgentProfile,
) {
  return {
    principalId,
    model: profile?.model ?? null,
    enabledSkills: profile?.enabledSkills ?? null,
    enabledGatekeepers: profile?.enabledGatekeepers ?? null,
    enabledWorkerDefinitions: profile?.enabledWorkerDefinitions ?? null,
    promptAddendum: profile?.promptAddendum ?? null,
    autoApproveLow: profile?.autoApproveLow ?? null,
    updatedAt: profile?.updatedAt ? profile.updatedAt.toISOString() : null,
    updatedBy: profile?.updatedBy ?? null,
    effective: {
      model: effective.model,
      enabledSkills: effective.enabledSkills,
      enabledGatekeepers: effective.enabledGatekeepers,
      enabledWorkerDefinitions: effective.enabledWorkerDefinitions,
      promptAddendum: effective.promptAddendum,
      autoApproveLow: effective.autoApproveLow,
    },
  };
}

function toWireAgentPolicy(policy: AgentPolicyRow) {
  return {
    workspaceId: policy.workspaceId,
    allowedModels: policy.allowedModels,
    defaultModel: policy.defaultModel,
    memberCanEditProfile: policy.memberCanEditProfile,
    maxPromptAddendumChars: policy.maxPromptAddendumChars,
    allowedSkills: policy.allowedSkills,
    allowedGatekeepers: policy.allowedGatekeepers,
    allowMemberAutoApproveLow: policy.allowMemberAutoApproveLow,
    updatedAt: policy.updatedAt ? policy.updatedAt.toISOString() : null,
    updatedBy: policy.updatedBy,
  };
}

// -------------------------------------------------------------------------------------------
// Capability handlers
// -------------------------------------------------------------------------------------------

const GetAgentProfileParams = (params: unknown) => params as { principalId?: string };

export const getAgentProfileHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error(
      'get_agent_profile: no resolved human principal in context (this capability is channel:"human"-only)',
    );
  }
  const { principalId } = GetAgentProfileParams(rawParams);
  const target = principalId ?? ctx.principal.id;

  if (target !== ctx.principal.id && ctx.principal.role !== 'owner') {
    throw new ForbiddenError(
      "get_agent_profile: only an owner may read another principal's AgentProfile",
    );
  }
  await assertPrincipalExists(client, workspaceId, target);

  const [profile, policy] = await Promise.all([
    readAgentProfile(client, workspaceId, target),
    readAgentPolicy(client, workspaceId),
  ]);
  const effective = resolveEffectiveAgentProfile(profile, policy);

  return {
    result: toWireAgentProfile(target, profile, effective),
    resourceType: 'agent_profile',
    resourceId: target,
  };
};

const SetAgentProfileParams = (params: unknown) =>
  params as {
    principalId?: string;
    model?: string | null;
    enabledSkills?: readonly string[] | null;
    enabledGatekeepers?: readonly string[] | null;
    enabledWorkerDefinitions?: readonly string[] | null;
    promptAddendum?: string | null;
    autoApproveLow?: boolean | null;
  };

export const setAgentProfileHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error(
      'set_agent_profile: no resolved human principal in context (this capability is channel:"human"-only)',
    );
  }
  const params = SetAgentProfileParams(rawParams);
  const target = params.principalId ?? ctx.principal.id;
  const callerIsOwner = ctx.principal.role === 'owner';

  if (target !== ctx.principal.id && !callerIsOwner) {
    throw new ForbiddenError(
      "set_agent_profile: only an owner may edit another principal's AgentProfile",
    );
  }
  await assertPrincipalExists(client, workspaceId, target);

  const policy = await readAgentPolicy(client, workspaceId);

  if (target === ctx.principal.id && !callerIsOwner && !policy.memberCanEditProfile) {
    throw new ForbiddenError(
      "set_agent_profile: this workspace's AgentPolicy.memberCanEditProfile is false — only an owner may edit AgentProfiles",
    );
  }

  if (params.model !== undefined && params.model !== null) {
    await assertModelAllowed(params.model, policy);
  }
  if (params.enabledSkills !== undefined && params.enabledSkills !== null) {
    await assertSkillsPublished(client, workspaceId, params.enabledSkills);
  }
  if (params.enabledGatekeepers !== undefined && params.enabledGatekeepers !== null) {
    await assertGatekeepersAccessible(client, workspaceId, target, params.enabledGatekeepers);
  }
  if (params.promptAddendum !== undefined && params.promptAddendum !== null) {
    if (params.promptAddendum.length > policy.maxPromptAddendumChars) {
      throw new AgentProfileValidationError(
        `set_agent_profile: promptAddendum is ${params.promptAddendum.length} characters, over this workspace's AgentPolicy.maxPromptAddendumChars (${policy.maxPromptAddendumChars})`,
      );
    }
  }
  if (params.autoApproveLow === true && !policy.allowMemberAutoApproveLow) {
    throw new AgentProfileValidationError(
      "set_agent_profile: autoApproveLow may not be true — this workspace's AgentPolicy forbids auto-approving low-blast-radius actions",
    );
  }

  const fields: SetAgentProfileFields = {
    model: params.model,
    enabledSkills: params.enabledSkills,
    enabledGatekeepers: params.enabledGatekeepers,
    enabledWorkerDefinitions: params.enabledWorkerDefinitions,
    promptAddendum: params.promptAddendum,
    autoApproveLow: params.autoApproveLow,
  };
  const updated = await setAgentProfile(client, workspaceId, target, ctx.principal.id, fields);

  // S3.13 change propagation — see this file's own module doc comment.
  await revokeEntrySessionHandles(client, workspaceId, target);

  const effective = resolveEffectiveAgentProfile(updated, policy);
  return {
    result: toWireAgentProfile(target, updated, effective),
    resourceType: 'agent_profile',
    resourceId: target,
  };
};

export const getAgentPolicyHandler: CapabilityHandler = async (client, workspaceId) => {
  const policy = await readAgentPolicy(client, workspaceId);
  return {
    result: toWireAgentPolicy(policy),
    resourceType: 'agent_policy',
    resourceId: workspaceId,
  };
};

const SetAgentPolicyParams = (params: unknown) => params as SetAgentPolicyFields;

export const setAgentPolicyHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error(
      'set_agent_policy: no resolved human principal in context (this capability is channel:"human"-only)',
    );
  }
  const params = SetAgentPolicyParams(rawParams);
  const updated = await setAgentPolicy(client, workspaceId, ctx.principal.id, params);
  return {
    result: toWireAgentPolicy(updated),
    resourceType: 'agent_policy',
    resourceId: workspaceId,
  };
};
