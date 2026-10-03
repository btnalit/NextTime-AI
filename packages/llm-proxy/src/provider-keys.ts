import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * provider-keys (R-24, review 2026-10-02): where `api_key_env` is looked up. A provider key that
 * reaches this process as container env is readable by anything that can inspect the container —
 * the read-only collector socket proxy among them — so the keys move to files: one file per
 * `api_key_env` name in `LLM_PROVIDER_KEYS_DIR` (default `/run/secrets/llm-provider-keys`, a
 * read-only bind mount of `${NEXTTIME_DATA}/secrets/llm-provider-keys`; docker-compose.yml). The
 * file holds the key, trailing newline ignored. Inspecting the container then shows a mount path,
 * never a key.
 *
 * Backwards compatible on purpose, so a host apply never breaks: a name with no file falls back
 * to `process.env[name]` — an operator `secrets/llm-proxy.env` that still sets the key keeps
 * working — and logs one deprecation warning per name. The directory is read once at startup
 * (`loadProviderKeyFiles`); like the env file before it, a changed key takes effect on the next
 * `docker compose up -d --force-recreate llm-proxy`.
 *
 * Only files directly in that directory, named like an env var, are keys — never a `<name>_FILE`
 * indirection: `api_key_env` is set from the console, and an indirection would let it name any
 * file this process can read (its own key store, for one) as a "provider key".
 */

export const DEFAULT_PROVIDER_KEYS_DIR = '/run/secrets/llm-provider-keys';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every `NAME` file in `dir` (non-empty after trimming the trailing newline) → its content. A
 *  missing or unreadable directory is no keys from files (every name then falls back to env); a
 *  file that cannot be read is skipped and reported through `log`. */
export async function loadProviderKeyFiles(
  dir: string,
  log: (line: string) => void = (line) => console.log(line),
): Promise<ReadonlyMap<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // Absent: not migrated yet, every name falls back to env. Anything else (a 0700 root-owned
    // directory, say) is a permission mistake the operator must see, not a silent fallback.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: the provider keys directory could not be read — check its mode / group (0750, group 10001); falling back to env for every key',
          dir,
          error: (err as NodeJS.ErrnoException).code ?? String(err),
        }),
      );
    }
    return new Map();
  }
  const keys = new Map<string, string>();
  for (const name of entries) {
    if (!ENV_NAME_PATTERN.test(name)) continue;
    try {
      const value = (await readFile(join(dir, name), 'utf8')).replace(/\r?\n$/, '');
      if (value.length > 0) keys.set(name, value);
    } catch (err) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: a provider key file could not be read — check its mode / group (0640, group 10001)',
          name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return keys;
}

/** The `resolveApiKey` both the proxy and the admin API take: the key file first, then the env
 *  var (deprecated — one warning per name, the value never logged). */
export function createProviderKeyResolver(options: {
  readonly files: ReadonlyMap<string, string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
}): (name: string) => string | undefined {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const warned = new Set<string>();
  return (name: string) => {
    const fromFile = options.files.get(name);
    if (fromFile !== undefined) return fromFile;
    const fromEnv = env[name];
    if (fromEnv && !warned.has(name)) {
      warned.add(name);
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: provider key read from the environment (deprecated, visible to container inspect) — move it to a file named after the variable in the provider keys directory and remove it from secrets/llm-proxy.env',
          name,
        }),
      );
    }
    return fromEnv;
  };
}
