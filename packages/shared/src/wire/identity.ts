import { z } from 'zod';
import { PrincipalKindSchema, RoleSchema } from '../enums.js';

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

export const AgentProfileWireSchema = z
  .object({
    principalId: z.string(),
    model: z.string().nullable(),
    enabledSkills: z.array(z.string()).nullable(),
    enabledGatekeepers: z.array(z.string()).nullable(),
    enabledWorkerDefinitions: z.array(z.string()).nullable(),
    promptAddendum: z.string().nullable(),
    autoApproveLow: z.boolean().nullable(),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
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

/** `list_models` item shape (models-catalog-handler.ts's `ModelCatalogEntry`). */
export const ModelCatalogEntryWireSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    model: z.string(),
  })
  .strict();
