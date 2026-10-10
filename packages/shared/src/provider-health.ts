import { z } from 'zod';
import {
  type LlmProviderTestResultWire,
  type LlmProviderWire,
  upstreamBaseUrlProblem,
} from './wire/llm-admin.js';

/**
 * provider-health: whether a model provider can serve a call right now, as far as the platform
 * knows — one rule for the providers table's 状态 column (admins) and for every model a member can
 * pick (console audit P0-2: a provider whose key the upstream refused kept appearing next to working
 * models in every model picker, and the overview counted its models as available).
 *
 * **What it is.** An observation derived by llm-proxy, the only process that knows a provider's
 * credential state and holds its test results: the console key store and the container's env (a
 * key present, or one that cannot go in a header) plus the last `/test` run. It is not authority
 * for anything — routing never consults it — and it can be stale: an upstream that broke since the
 * last test still reads `ok`, which is why the console says 「上次测试」.
 *
 * **How it reaches members.** llm-proxy writes `provider-health.json` next to `models.json` (same
 * directory: llm-proxy writes it, the kernel mounts it read-only) whenever the catalog, a key or a
 * test result changes and at startup; the kernel's model projection (`list_models`,
 * `list_platform_models`) attaches each model's provider health. No credential crosses: the file
 * holds a status kind and a time, never a key, an env var's value or an upstream error text.
 *
 * Kinds, checked in this order (the first that applies wins):
 *   - `disabled`     — switched off; never routed (and not in models.json).
 *   - `key_invalid`  — the resolved key cannot go in a header; every call is 502.
 *   - `key_missing`  — no console key and no env / file key; every call is 502.
 *   - `url_unsafe`   — the saved Base URL breaks the bare-base rule; never routed.
 *   - `key_rejected` — the last test (still applicable) got the provider's own 401 / 403.
 *   - `test_failed`  — the last test's completion failed for another reason.
 *   - `tools_failed` — completions work but the tool call failed: an agent turn needs tools.
 *   - `untested`     — none of the above and no applicable test: configured, never verified.
 *   - `ok`           — the last applicable test passed both the completion and the tool call.
 * A test stops applying when the provider was edited after it (`updatedAt` later) or the tested
 * model is no longer listed.
 */
export const ProviderHealthStatusSchema = z.enum([
  'disabled',
  'key_invalid',
  'key_missing',
  'url_unsafe',
  'key_rejected',
  'test_failed',
  'tools_failed',
  'untested',
  'ok',
]);
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>;

/** What a model picker does with a status: `ok` — offer it; `unverified` / `warn` — offer it with
 *  a marker; `blocked` — every call fails, so do not offer it (keep a value already chosen visible,
 *  marked). */
export type ProviderHealthUsability = 'ok' | 'unverified' | 'warn' | 'blocked';

export function providerHealthUsability(status: ProviderHealthStatus): ProviderHealthUsability {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'untested':
      return 'unverified';
    case 'tools_failed':
      return 'warn';
    default:
      return 'blocked';
  }
}

/** One provider's health as the model projection carries it — a kind and when it was last
 *  tested, nothing else. */
export const ProviderHealthWireSchema = z
  .object({
    status: ProviderHealthStatusSchema,
    /** The applicable test's time; `null` when there is none. */
    testedAt: z.string().nullable(),
  })
  .strict();
export type ProviderHealthWire = z.infer<typeof ProviderHealthWireSchema>;

/** `provider-health.json`: written by llm-proxy, read by the kernel. */
export const PROVIDER_HEALTH_FILE_VERSION = 1;
export const ProviderHealthFileSchema = z
  .object({
    version: z.literal(PROVIDER_HEALTH_FILE_VERSION),
    writtenAt: z.string(),
    providers: z.record(z.string(), ProviderHealthWireSchema),
  })
  .strict();
export type ProviderHealthFile = z.infer<typeof ProviderHealthFileSchema>;

/** The provider fields the rule reads — `LlmProviderWire` has them all. */
export type ProviderHealthInput = Pick<
  LlmProviderWire,
  'enabled' | 'credentialPresent' | 'credentialInvalid' | 'upstreamBaseUrl' | 'models' | 'updatedAt'
>;
export type ProviderHealthTest = Pick<
  LlmProviderTestResultWire,
  'model' | 'completion' | 'toolCall' | 'error' | 'testedAt'
>;

/** Whether `lastTest` still says something about `provider` (see the module doc comment). */
export function providerTestStillApplies(
  provider: ProviderHealthInput,
  lastTest: ProviderHealthTest,
): boolean {
  if (!provider.models.some((model) => model.id === lastTest.model)) return false;
  return !(
    provider.updatedAt !== null && Date.parse(provider.updatedAt) > Date.parse(lastTest.testedAt)
  );
}

/** The health of `provider`, given its freshest test result. */
export function providerHealth(
  provider: ProviderHealthInput,
  lastTest: ProviderHealthTest | null,
): ProviderHealthWire {
  if (!provider.enabled) return { status: 'disabled', testedAt: null };
  if (provider.credentialInvalid === true) return { status: 'key_invalid', testedAt: null };
  if (!provider.credentialPresent) return { status: 'key_missing', testedAt: null };
  if (upstreamBaseUrlProblem(provider.upstreamBaseUrl) !== null) {
    return { status: 'url_unsafe', testedAt: null };
  }
  if (lastTest === null || !providerTestStillApplies(provider, lastTest)) {
    return { status: 'untested', testedAt: null };
  }
  const testedAt = lastTest.testedAt;
  if (lastTest.completion === 'error') {
    return {
      status: /^HTTP 40[13]\b/.test(lastTest.error ?? '') ? 'key_rejected' : 'test_failed',
      testedAt,
    };
  }
  if (lastTest.toolCall === 'error') return { status: 'tools_failed', testedAt };
  if (lastTest.completion === 'ok' && lastTest.toolCall === 'ok') return { status: 'ok', testedAt };
  return { status: 'untested', testedAt };
}
