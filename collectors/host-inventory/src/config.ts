/**
 * config: environment parsing for this collector — pure, no IO (docs/runbooks/host-collector.md
 * documents every one of these for the operator).
 */

export interface CollectorConfig {
  /** Base URL of the kernel's HTTP API (`POST <kernelUrl>/api/cap/<name>`). */
  readonly kernelUrl: string;
  /** Path to the file holding this collector's Handle bearer token — minted by `cli/bootstrap.js
   *  issue-service-handle` (docs/runbooks/host-collector.md). Read fresh on every run (never
   *  cached across runs in memory) so a rotated token on disk takes effect on the next run without
   *  a restart. */
  readonly handleTokenFile: string;
  readonly dockerHost: string | undefined;
  /** `/run/systemd` mount path — see `systemd.ts`'s own doc comment. */
  readonly runSystemdPath: string;
  /** Absolute paths of git repositories to collect `Repository`/`built_from` facts for — optional,
   *  empty by default (`repository.ts`'s own doc comment). */
  readonly repositoryPaths: readonly string[];
  /** Run once and exit (`--once`), or loop on `intervalMs` until terminated. */
  readonly once: boolean;
  /** Loop interval in milliseconds when `once` is false. */
  readonly intervalMs: number;
  /** Source registration is idempotent across restarts via this local cache file — see
   *  `run.ts`'s own doc comment ("register_source always inserts... a collector that must keep
   *  asserting under the same origin across independent runs persists the returned id itself"). */
  readonly sourceStateFile: string;
  readonly sourceName: string;
  readonly sourceKind: string;
}

const DEFAULT_RUN_SYSTEMD_PATH = '/run/systemd';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_SOURCE_STATE_FILE = '/data/state/host-inventory-source.json';
const DEFAULT_SOURCE_NAME = 'host-inventory';
const DEFAULT_SOURCE_KIND = 'host-inventory-collector';
const DEFAULT_HANDLE_TOKEN_FILE = '/run/secrets/collector_host_inventory_token';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseRepositoryPaths(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseIntervalMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`HOST_INVENTORY_INTERVAL_MS must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export interface LoadConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: readonly string[];
}

/** Reads `env` (default `process.env`) and `argv` (default `process.argv.slice(2)`) into a
 *  `CollectorConfig`. Throws `ConfigError` for a missing required value (`KERNEL_URL`) or a
 *  malformed one (`HOST_INVENTORY_INTERVAL_MS`) — fails fast at startup, before any collection or
 *  network call, matching `packages/kernel/src/adapters/db/pool.ts`'s own `DatabaseConfigError`
 *  convention for this codebase's other services. */
export function loadConfig(options: LoadConfigOptions = {}): CollectorConfig {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);

  const kernelUrl = env.KERNEL_URL;
  if (!kernelUrl) {
    throw new ConfigError('KERNEL_URL must be set (e.g. http://kernel:8080)');
  }

  return {
    kernelUrl: kernelUrl.replace(/\/+$/, ''),
    handleTokenFile: env.NEXTTIME_HANDLE_TOKEN_FILE ?? DEFAULT_HANDLE_TOKEN_FILE,
    dockerHost: env.DOCKER_HOST,
    runSystemdPath: env.HOST_INVENTORY_RUN_SYSTEMD_PATH ?? DEFAULT_RUN_SYSTEMD_PATH,
    repositoryPaths: parseRepositoryPaths(env.HOST_INVENTORY_REPOSITORY_PATHS),
    once: argv.includes('--once'),
    intervalMs: parseIntervalMs(env.HOST_INVENTORY_INTERVAL_MS),
    sourceStateFile: env.HOST_INVENTORY_SOURCE_STATE_FILE ?? DEFAULT_SOURCE_STATE_FILE,
    sourceName: env.HOST_INVENTORY_SOURCE_NAME ?? DEFAULT_SOURCE_NAME,
    sourceKind: env.HOST_INVENTORY_SOURCE_KIND ?? DEFAULT_SOURCE_KIND,
  };
}
