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
 * What is deliberately absent: any field that could carry a provider key *back out*. `apiKeyEnv`
 * is the *name* of the env var llm-proxy reads the key from (`secrets/llm-proxy.env`, set by the
 * operator) — optional as of S7-A (docs/STATUS.md 维护者决定 2026-09-22 ①: console-written keys,
 * no approval flow): a store provider may have no env var at all and rely purely on the console
 * key. `credentialPresent` says whether *some* credential resolves (console key, then env var);
 * `credentialSource` says which one. Neither ever carries the value — the one write path that
 * does (`PUT /providers/:id/secret {key}`) takes the key in, never echoes it back out on any
 * response, log line, or audit row (llm-proxy's key-store.ts / admin-api.ts).
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

/** S7-A: which of the two possible sources resolves a credential for this provider, in the order
 *  llm-proxy actually applies them — console key (key-store.ts) first, then the env var named by
 *  `apiKeyEnv`, else none. `credentialPresent` (below) is `credentialSource !== 'none'`. */
export const LlmProviderCredentialSourceWireSchema = z.enum(['console', 'env', 'none']);
export type LlmProviderCredentialSourceWire = z.infer<typeof LlmProviderCredentialSourceWireSchema>;

export const LlmProviderWireSchema = z
  .object({
    id: LlmProviderIdWireSchema,
    displayName: z.string(),
    api: LlmProviderApiKindWireSchema,
    upstreamBaseUrl: z.string(),
    authHeader: LlmProviderAuthHeaderWireSchema,
    authScheme: z.literal('Bearer').nullable(),
    /** `null` when this provider has no env var configured at all — S7-A: valid for a store
     *  provider whose key is set purely through the console. */
    apiKeyEnv: LlmProviderApiKeyEnvWireSchema.nullable(),
    /** Whether *some* credential resolves — console key or `process.env[apiKeyEnv]`. Never the
     *  value; see `credentialSource` for which one. */
    credentialPresent: z.boolean(),
    credentialSource: LlmProviderCredentialSourceWireSchema,
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

/** `POST /providers` (all fields) and `PUT /providers/:id` (same, `id` must match the path).
 *  `apiKeyEnv` optional (S7-A): omitted means "no env var" — the console key (if any) is this
 *  provider's only credential source. A full replace on `PUT` clears a previously-set `apiKeyEnv`
 *  when the field is left out, same as every other field here. */
export const LlmProviderInputWireSchema = z
  .object({
    id: LlmProviderIdWireSchema,
    displayName: z.string().min(1).max(120).optional(),
    api: LlmProviderApiKindWireSchema,
    upstreamBaseUrl: z.string().url(),
    authHeader: LlmProviderAuthHeaderWireSchema,
    authScheme: z.literal('Bearer').nullable().optional(),
    apiKeyEnv: LlmProviderApiKeyEnvWireSchema.optional(),
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

/** Deliberately a char-code loop, not a `/[\x00-\x1f\x7f]/` regex (biome's
 *  `noControlCharactersInRegex` — same reasoning as `interfaces/explorer-contract/index.ts`'s
 *  `safeContentDispositionFilename`): avoids the lint without a suppression comment. C0 controls
 *  (0x00–0x1F: NUL, CR, LF, tab, …) plus DEL (0x7F) — the same "surely a mistake, not a real key"
 *  set a pasted-with-a-trailing-newline value would trip. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** S7-A: `PUT /providers/:id/secret` (set/replace) and `POST /providers/:id/secret` (alias, kept
 *  for the original design's route — plan §6/§12). `.trim()` runs during parsing so the stored
 *  value is exactly what the store persists; the control-character refine catches a pasted
 *  newline/tab a human would not otherwise notice. `DELETE /providers/:id/secret` (clear, falls
 *  back to `apiKeyEnv`) has no body. */
export const LLM_PROVIDER_SECRET_MAX_LENGTH = 4096;
export const LlmProviderSecretInputWireSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(LLM_PROVIDER_SECRET_MAX_LENGTH)
      .refine((value) => !hasControlCharacter(value), 'key must not contain control characters'),
  })
  .strict();
export type LlmProviderSecretInputWire = z.infer<typeof LlmProviderSecretInputWireSchema>;

export const DeleteLlmProviderResultWireSchema = z
  .object({
    id: LlmProviderIdWireSchema,
    deleted: z.literal(true),
    /** `true` when the deleted row was an override and the file entry is visible again. */
    restoredFileEntry: z.boolean(),
    /** P2 hotfix (post-v0.16.0 review): `true` when this delete also cleared a console key that
     *  had been set for this provider id (key-store.ts) — recreating the id later never silently
     *  reuses a stale key against a possibly different upstream. `false` when there was no console
     *  key to clear. */
    secretCleared: z.boolean(),
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
