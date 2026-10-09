import { z } from 'zod';
import { PrincipalKindSchema, RoleSchema } from '../enums.js';
import { ProviderHealthWireSchema } from '../provider-health.js';

/**
 * wire/identity: Principal / Workspace / AgentProfile / AgentPolicy wire shapes
 * (docs/wire-contract-conventions.md §5, S3.7) — mirror `application/gateway/members-handlers.ts`'s
 * `toWirePrincipal`/`getWorkspaceHandler` and `application/gateway/agent-profile-handlers.ts`'s
 * `toWireAgentProfile`/`toWireAgentPolicy` (all already ISO-string clean, no wire fix needed).
 */

export const PrincipalWireSchema = z
  .object({
    id: z.string(),
    kind: PrincipalKindSchema,
    role: RoleSchema,
    displayName: z.string().nullable(),
    createdAt: z.string(),
    workerDefinitionId: z.string().optional(),
    hasApiKey: z.boolean(),
    disabledAt: z.string().nullable(),
    /** S8 W4 (leftover 88): true for the platform's own internal service Principals
     *  (`__gatekeeper_service__`, `__draft_reaper__`) — derived by the kernel from a reserved
     *  `displayName` naming convention (`members-handlers.ts`'s `isInternalPrincipalDisplayName`),
     *  never from a client-side name list. Consumers (the Access page's service-Handle picker,
     *  the Members page) filter these out or label them distinctly rather than guessing. */
    internal: z.boolean(),
  })
  .strict();
export type PrincipalWire = z.infer<typeof PrincipalWireSchema>;

/** `create_principal`'s result — the created Principal plus the plaintext key, returned once
 *  (members-handlers.ts's own doc comment: never persisted, never audited). */
export const CreatePrincipalResultWireSchema = z
  .object({
    principal: PrincipalWireSchema,
    apiKey: z.string(),
  })
  .strict();

/** `rotate_api_key`'s result. */
export const RotateApiKeyResultWireSchema = z
  .object({
    principalId: z.string(),
    apiKey: z.string(),
  })
  .strict();

export const WorkspaceWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    principalCount: z.number().int().nonnegative(),
    gatekeeperCount: z.number().int().nonnegative(),
    caller: z
      .object({
        id: z.string(),
        role: RoleSchema,
        displayName: z.string().nullable(),
        kind: PrincipalKindSchema,
      })
      .strict(),
  })
  .strict();
export type WorkspaceWire = z.infer<typeof WorkspaceWireSchema>;

const EffectiveAgentProfileWireSchema = z
  .object({
    model: z.string(),
    enabledSkills: z.array(z.string()),
    enabledGatekeepers: z.array(z.string()),
    enabledWorkerDefinitions: z.array(z.string()),
    promptAddendum: z.string(),
    autoApproveLow: z.boolean(),
  })
  .strict();

/** One gate the My Agent checklist offers (leftover 98, `agent-profile-handlers.ts`'s
 *  `resolveAvailableGatekeepers`): granted to the member (`granted: true` — read and write), or
 *  readable without a Grant (`granted: false` — design doc §11 "门上的观察": registered, with a
 *  published observe-class Operation not on the platform deny list). `inUse`: the member's agent
 *  uses it now — not in `excludedGatekeepers` and inside the AgentPolicy gate cap (the check every
 *  observe call makes); for a granted gate it equals membership of `effective.enabledGatekeepers`. */
export const AvailableGatekeeperWireSchema = z
  .object({
    gatekeeperId: z.string(),
    granted: z.boolean(),
    inUse: z.boolean(),
  })
  .strict();
export type AvailableGatekeeperWire = z.infer<typeof AvailableGatekeeperWireSchema>;

export const AgentProfileWireSchema = z
  .object({
    principalId: z.string(),
    model: z.string().nullable(),
    // Exclusion lists (console redesign D1): `effective.enabled*` = what is on offer minus these;
    // `[]` = exclude nothing, so a later grant / publish is picked up automatically.
    excludedSkills: z.array(z.string()),
    excludedGatekeepers: z.array(z.string()),
    excludedWorkerDefinitions: z.array(z.string()),
    promptAddendum: z.string().nullable(),
    autoApproveLow: z.boolean().nullable(),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
    // Additive (leftover 98): the gates on offer before exclusions — granted ones plus every gate
    // readable without a Grant. `effective.enabledGatekeepers` stays the execute set (granted ∩ not
    // excluded ∩ policy cap), the entry Handle's `resources.gatekeeper`.
    availableGatekeepers: z.array(AvailableGatekeeperWireSchema),
    effective: EffectiveAgentProfileWireSchema,
  })
  .strict();
export type AgentProfileWire = z.infer<typeof AgentProfileWireSchema>;

export const AgentPolicyWireSchema = z
  .object({
    workspaceId: z.string(),
    allowedModels: z.array(z.string()),
    defaultModel: z.string().nullable(),
    memberCanEditProfile: z.boolean(),
    maxPromptAddendumChars: z.number().int().positive(),
    allowedSkills: z.array(z.string()),
    allowedGatekeepers: z.array(z.string()),
    allowMemberAutoApproveLow: z.boolean(),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
  })
  .strict();
export type AgentPolicyWire = z.infer<typeof AgentPolicyWireSchema>;

/** `list_models` / `list_platform_models` item shape (models-catalog-handler.ts's
 *  `ModelCatalogEntry`). `health` is the model's provider health as llm-proxy last wrote it
 *  (`provider-health.ts`); absent when the kernel could not read that file (an llm-proxy that
 *  predates it, or a file not written yet) — unknown, not healthy. */
export const ModelCatalogEntryWireSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    model: z.string(),
    health: ProviderHealthWireSchema.optional(),
  })
  .strict();
