import { z } from 'zod';

/**
 * wire/llm-admin: the S6-B provider-management shapes (docs/console-completion-plan.md §5.4 /
 * §6; docs/platform-admin-design.md §6.2). Two producers share them: the kernel's
 * `issue_llm_admin_token` result (`LlmAdminTokenWireSchema`), and llm-proxy's own admin endpoints
 * (`/api/llm-admin/providers*` via caddy), which validate their request bodies against
 * `LlmProviderInputWireSchema` and answer with `LlmProviderWireSchema` rows — the console types its
 * client (`packages/web/src/lib/llm-admin.ts`) off the same definitions, so the three cannot drift.
 *
 * Field names are camelCase (docs/wire-contract-conventions.md §2) even though llm-proxy's on-disk
 * `llm-providers.yaml` / `providers.json` keep the S1.7 snake_case (`upstream_base_url`,
 * `api_key_env`) — the translation happens once, inside llm-proxy's admin layer.
 *
 * What is deliberately absent: any field that could carry a provider key. `apiKeyEnv` is the
 * *name* of the env var llm-proxy reads the key from (`secrets/llm-proxy.env`, set by the
 * operator), `credentialPresent` says whether that var is set — never its value. The secret-write
 * path (`POST /providers/:id/secret`) is a 501 stub until the maintainer decides whether console
 * writes of a provider key must go through approval (plan §12 末 "仍待维护者确认").
 */

/** The three upstream API kinds llm-proxy speaks (packages/llm-proxy/src/config.ts
 *  `ProviderConfigSchema.api`; verified against pi's own provider implementations there). */
export const LlmProviderApiKindWireSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);
export type LlmProviderApiKindWire = z.infer<typeof LlmProviderApiKindWireSchema>;

export const LlmProviderAuthHeaderWireSchema = z.enum(['authorization', 'x-api-key']);
export type LlmProviderAuthHeaderWire = z.infer<typeof LlmProviderAuthHeaderWireSchema>;

/** Provider ids are URL path segments on both sides (llm-proxy's `/<provider>/v1/*` inbound
 *  route and pi's `models.json` `baseUrl`) — lower-case slug, 1–63 chars. `admin` / `healthz` /
 *  `internal` are llm-proxy's own top-level segments and are refused by its store. */
export const LLM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const LLM_PROVIDER_RESERVED_IDS: readonly string[] = ['admin', 'healthz', 'internal'];
export const LlmProviderIdWireSchema = z.string().regex(LLM_PROVIDER_ID_PATTERN);

/** Env-var name, never a value: `^[A-Z][A-Z0-9_]*$`. */
export const LlmProviderApiKeyEnvWireSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

const CostRates = {
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
};
export const LlmProviderModelCostWireSchema = z
  .object({
    ...CostRates,
    tiers: z.array(z.object({ inputTokensAbove: z.number(), ...CostRates }).strict()).optional(),
  })
  .strict();
export type LlmProviderModelCostWire = z.infer<typeof LlmProviderModelCostWireSchema>;

export const LlmProviderModelWireSchema = z
  .object({
    id: z.string().min(1).max(200),
    /** Shown in the console and written to `models.json` as pi's `name`; `null` = use `id`. */
    displayName: z.string().min(1).max(120).nullable(),
    cost: LlmProviderModelCostWireSchema.nullable(),
  })
  .strict();
export type LlmProviderModelWire = z.infer<typeof LlmProviderModelWireSchema>;

export const LlmProviderTestOutcomeWireSchema = z.enum(['ok', 'error', 'skipped']);

/** `POST /providers/:id/test` — plan §5.4 acceptance: one real completion **and** one tool-call
 *  round trip against the upstream (Workers and gate tools depend on the latter; "兼容零改动"
 *  is only proven once both pass). `toolCall` is `skipped` when the completion already failed. */
export const LlmProviderTestResultWireSchema = z
  .object({
    providerId: LlmProviderIdWireSchema,
    model: z.string(),
    completion: LlmProviderTestOutcomeWireSchema,
    toolCall: LlmProviderTestOutcomeWireSchema,
    latencyMs: z.number().int().nonnegative(),
    /** Upstream status / parse failure, sanitized (never a key, never a full body). */
    error: z.string().nullable(),
    testedAt: z.string(),
  })
  .strict();
export type LlmProviderTestResultWire = z.infer<typeof LlmProviderTestResultWireSchema>;

export const LlmProviderSourceWireSchema = z.enum(['file', 'store']);

export const LlmProviderWireSchema = z
  .object({
    id: LlmProviderIdWireSchema,
    displayName: z.string(),
    api: LlmProviderApiKindWireSchema,
    upstreamBaseUrl: z.string(),
    authHeader: LlmProviderAuthHeaderWireSchema,
    authScheme: z.literal('Bearer').nullable(),
    apiKeyEnv: LlmProviderApiKeyEnvWireSchema,
    /** Whether `process.env[apiKeyEnv]` is set in the llm-proxy container — the honest credential
     *  state the page shows ("凭证：已配置 / 待操作员配置"). Never the value. */
    credentialPresent: z.boolean(),
    enabled: z.boolean(),
    /** `file`: from the operator-managed `llm-providers.yaml` (read-only base). `store`: from
     *  llm-proxy's own `providers.json`, written through this API. */
    source: LlmProviderSourceWireSchema,
    /** `true` when a store entry shadows a same-id file entry (editing / disabling a file provider
     *  creates such an override; deleting the override restores the file entry). */
    overridesFile: z.boolean(),
    models: z.array(LlmProviderModelWireSchema),
    lastTest: LlmProviderTestResultWireSchema.nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type LlmProviderWire = z.infer<typeof LlmProviderWireSchema>;

export const LlmProviderListWireSchema = z
  .object({
    items: z.array(LlmProviderWireSchema),
    /** When llm-proxy last rewrote the merged catalog (`models.json`) in this process, `null`
     *  before the first mutation since start. */
    modelsJsonWrittenAt: z.string().nullable(),
    /** The last rewrite failure (sanitized), `null` when the last rewrite succeeded or none was
     *  attempted — the page turns a non-null value into the operator step (state directory /
     *  config directory ownership, docs/runbooks/operations.md 供应商管理). */
    modelsJsonError: z.string().nullable(),
    /** Whether llm-proxy can persist store entries at all (`false` = the state directory is not
     *  writable; reads still work, every mutation answers 503 `store_unwritable`). */
    storeWritable: z.boolean(),
  })
  .strict();
export type LlmProviderListWire = z.infer<typeof LlmProviderListWireSchema>;

/** `POST /providers` (all fields) and `PUT /providers/:id` (same, `id` must match the path). */
export const LlmProviderInputWireSchema = z
  .object({
    id: LlmProviderIdWireSchema,
    displayName: z.string().min(1).max(120).optional(),
    api: LlmProviderApiKindWireSchema,
    upstreamBaseUrl: z.string().url(),
    authHeader: LlmProviderAuthHeaderWireSchema,
    authScheme: z.literal('Bearer').nullable().optional(),
    apiKeyEnv: LlmProviderApiKeyEnvWireSchema,
    models: z.array(LlmProviderModelWireSchema).min(1).max(200),
    enabled: z.boolean().optional(),
  })
  .strict();
export type LlmProviderInputWire = z.infer<typeof LlmProviderInputWireSchema>;

export const LlmProviderTestInputWireSchema = z
  .object({
    /** Defaults to the provider's first model. */
    model: z.string().min(1).optional(),
  })
  .strict();
export type LlmProviderTestInputWire = z.infer<typeof LlmProviderTestInputWireSchema>;

export const DeleteLlmProviderResultWireSchema = z
  .object({
    id: LlmProviderIdWireSchema,
    deleted: z.literal(true),
    /** `true` when the deleted row was an override and the file entry is visible again. */
    restoredFileEntry: z.boolean(),
  })
  .strict();
export type DeleteLlmProviderResultWire = z.infer<typeof DeleteLlmProviderResultWireSchema>;

/** `issue_llm_admin_token` result — the browser presents `token` as `Authorization: Bearer` to
 *  `url` (same origin, caddy `/api/llm-admin/*`). `jti` is the audit correlation key (the
 *  kernel's `platform.llm_admin_token_issued` row and llm-proxy's audit lines both carry it). */
export const LlmAdminTokenWireSchema = z
  .object({
    token: z.string(),
    url: z.string(),
    jti: z.string(),
    expiresAt: z.string(),
  })
  .strict();
export type LlmAdminTokenWire = z.infer<typeof LlmAdminTokenWireSchema>;

/** llm-proxy admin error envelope — the same `{error: {code, message}}` shape its provider
 *  routes already answer with (packages/llm-proxy/src/proxy.ts `sendJson`). */
export const LlmAdminErrorWireSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type LlmAdminErrorWire = z.infer<typeof LlmAdminErrorWireSchema>;
