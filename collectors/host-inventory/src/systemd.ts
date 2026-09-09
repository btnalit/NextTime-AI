import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * systemd: `SystemdService` observations via `systemctl list-units --type=service` (docs/
 * development-tasks.md S3.3 deliverable 2: "SystemdService via `systemctl list-units --type=service`
 * when `/run/systemd` is mounted read-only (make it optional; skip cleanly otherwise)").
 *
 * `/run/systemd` is this collector's own signal for "does `systemctl` have anything real to talk
 * to" — a container with no `/run/systemd` mount either has no `systemctl` binary at all, or has
 * one that can only ever fail (`Failed to connect to bus`); checking for the mount first avoids
 * spawning a process that is guaranteed to fail and lets `collectSystemdServices` return a clean
 * `{skipped: true}` instead of surfacing a spawn/exit-code error up to `run.ts`. `docker-compose.
 * yml`'s own collector service mounts `${NEXTTIME_DATA}/host/run-systemd:/run/systemd:ro` — see
 * that service's own comment for why this is the one filesystem mount this otherwise
 * `docker.sock`-free, read-only collector needs, and `docs/runbooks/host-collector.md` for the
 * operator-facing note that this mount is optional (omit it, `systemctl` is simply never run).
 */

const execFileAsync = promisify(execFile);

export interface RawSystemdService {
  readonly unitName: string;
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly description: string;
}

export interface SystemdCollectionResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly services: readonly RawSystemdService[];
}

export type SystemctlRunner = (args: readonly string[]) => Promise<{ readonly stdout: string }>;

const RUN_SYSTEMD_PATH = '/run/systemd';

async function isSystemdVisible(runSystemdPath: string): Promise<boolean> {
  try {
    await access(runSystemdPath);
    return true;
  } catch {
    return false;
  }
}

/** `systemctl list-units --type=service --all --no-legend --plain --no-pager` — one line per unit:
 *  `<unit> <load> <active> <sub> <description...>`, exactly four fixed columns then free-text
 *  description (systemd's own plain-output contract; the description is whatever text remains
 *  after the fourth whitespace-delimited field). Lines that do not parse into at least four fields
 *  are skipped rather than thrown on (a trailing summary/blank line some systemd versions still
 *  emit even with `--no-legend`, defensively). */
export function parseSystemctlOutput(stdout: string): RawSystemdService[] {
  const services: RawSystemdService[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const [unitName, loadState, activeState, subState, ...descriptionParts] = parts;
    if (!unitName || !loadState || !activeState || !subState) continue;
    services.push({
      unitName,
      loadState,
      activeState,
      subState,
      description: descriptionParts.join(' '),
    });
  }
  return services;
}

async function defaultSystemctlRunner(args: readonly string[]): Promise<{ stdout: string }> {
  const result = await execFileAsync('systemctl', [...args], { timeout: 10_000 });
  return { stdout: result.stdout };
}

export interface CollectSystemdServicesOptions {
  readonly runSystemdPath?: string;
  readonly runner?: SystemctlRunner;
}

/** `{skipped: true}` when `/run/systemd` is not present (the optional-mount case) or when
 *  `systemctl` itself fails to run (missing binary, non-zero exit, timeout) — never throws. */
export async function collectSystemdServices(
  options: CollectSystemdServicesOptions = {},
): Promise<SystemdCollectionResult> {
  const runSystemdPath = options.runSystemdPath ?? RUN_SYSTEMD_PATH;
  const runner = options.runner ?? defaultSystemctlRunner;

  if (!(await isSystemdVisible(runSystemdPath))) {
    return {
      skipped: true,
      reason: `systemd: ${runSystemdPath} is not mounted — skipping (optional data source)`,
      services: [],
    };
  }

  try {
    const { stdout } = await runner([
      'list-units',
      '--type=service',
      '--all',
      '--no-legend',
      '--plain',
      '--no-pager',
    ]);
    return { skipped: false, services: parseSystemctlOutput(stdout) };
  } catch (err) {
    return {
      skipped: true,
      reason: `systemd: systemctl failed — ${err instanceof Error ? err.message : String(err)}`,
      services: [],
    };
  }
}
