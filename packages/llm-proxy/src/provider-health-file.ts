import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PROVIDER_HEALTH_FILE_VERSION,
  type ProviderHealthFile,
  providerHealth,
} from '@nexttime/shared';
import { toWireProvider } from './admin-api.js';
import type { ProviderCatalog, ResolvedProvider } from './catalog.js';
import type { ProviderCredentialFacts } from './provider-keys.js';

/**
 * provider-health-file: `provider-health.json`, the provider health every model picker shows
 * (console audit P0-2; the rule is `@nexttime/shared`'s `providerHealth`). Written next to
 * `models.json` — the directory llm-proxy already writes and the kernel mounts read-only — so the
 * kernel's model projection (`list_models`, `list_platform_models`) can carry it without a new
 * network path and without the kernel learning anything about a credential: the file holds, per
 * provider id, a status kind and when the applicable test ran. Never a key, an env var's value or
 * an upstream error text (the admin page reads those from the admin API).
 *
 * Written at startup (the env / key-file credentials and a file provider's in-memory test result
 * are only known to this process) and after every catalog rewrite, test and key change
 * (admin-api.ts `refreshProviderHealth`). Atomic, like `models.json`.
 */

export const PROVIDER_HEALTH_FILE_NAME = 'provider-health.json';

/** Where the file goes: next to `models.json` unless `PROVIDER_HEALTH_OUT_FILE` says otherwise. */
export function providerHealthOutFile(modelsJsonOutFile: string, env = process.env): string {
  const configured = env.PROVIDER_HEALTH_OUT_FILE;
  return configured && configured.length > 0
    ? configured
    : join(dirname(modelsJsonOutFile), PROVIDER_HEALTH_FILE_NAME);
}

export function buildProviderHealthFile(
  catalog: ProviderCatalog,
  credentialFacts: (provider: ResolvedProvider) => ProviderCredentialFacts,
  now: () => Date = () => new Date(),
): ProviderHealthFile {
  const providers: Record<string, ProviderHealthFile['providers'][string]> = {};
  for (const provider of catalog.resolve()) {
    const facts = credentialFacts(provider);
    const wire = toWireProvider(provider, facts.present, facts.source, facts.invalid);
    providers[provider.id] = providerHealth(wire, wire.lastTest);
  }
  return { version: PROVIDER_HEALTH_FILE_VERSION, writtenAt: now().toISOString(), providers };
}

export async function writeProviderHealthAtomic(
  outFile: string,
  health: ProviderHealthFile,
): Promise<void> {
  const tmp = `${outFile}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(health, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    await rename(tmp, outFile);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
