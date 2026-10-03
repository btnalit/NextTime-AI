import { readFile } from 'node:fs/promises';
import type { PlatformStatusBackupWire } from '@nexttime/shared';

/**
 * application/platform/backup-status: `platform_status.backup` (review 2026-10-02 D-28, L10-2).
 * The `backup` service (deploy/backup/backup.sh) writes `${NEXTTIME_DATA}/backups/last-success`
 * after every successful nightly run; the compose file bind-mounts exactly that one file,
 * read-only, into the kernel at `/data/backups/last-success`. Nothing else from `backups/` (the
 * dumps, the files tarballs with provider keys) is visible to the kernel.
 *
 * Freshness is the same rule `scripts/check-backup-freshness.sh` applies on the host: stale when
 * the marker's `timestamp=` is more than `BACKUP_MAX_AGE_HOURS` (26 h: one daily run plus slack)
 * old, compared in whole minutes like that script. The script's other two checks (the service is
 * running, the named dump is still on disk) need the host and stay there.
 *
 * Never throws. A marker that is missing, unreadable (the kernel runs as uid 10001 — the host file
 * must be world-readable, see docs/runbooks/backup-restore.md), a directory, or unparseable is an
 * explicit `unknown` with the reason in `detail` — never "not configured", and never a failed
 * `platform_status` call.
 */

export const DEFAULT_BACKUP_LAST_SUCCESS_FILE = '/data/backups/last-success';

/** Kept equal to `scripts/check-backup-freshness.sh`'s `MAX_AGE_HOURS` default. */
export const BACKUP_MAX_AGE_HOURS = 26;

/** The marker is three short lines; anything larger is not the marker. */
const MAX_MARKER_BYTES = 4096;

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function resolveBackupLastSuccessFile(env: NodeJS.ProcessEnv): string {
  const configured = env.BACKUP_LAST_SUCCESS_FILE;
  return configured && configured.length > 0 ? configured : DEFAULT_BACKUP_LAST_SUCCESS_FILE;
}

function unknown(detail: string): PlatformStatusBackupWire {
  return {
    status: 'unknown',
    lastSuccessAt: null,
    stale: null,
    maxAgeHours: BACKUP_MAX_AGE_HOURS,
    detail,
  };
}

function readErrorDetail(file: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return `no backup marker at ${file} — no backup has succeeded yet, or the kernel has no mount of backups/last-success (compose file, kernel service)`;
    case 'EACCES':
    case 'EPERM':
      return `backup marker ${file} is not readable by the kernel (uid 10001) — the host file must be mode 0644 (docs/runbooks/backup-restore.md)`;
    case 'EISDIR':
      return `backup marker path ${file} is a directory — the host file was missing when the kernel started, so the container runtime created a directory there (docs/runbooks/backup-restore.md)`;
    default:
      return `backup marker ${file} could not be read (${code ?? 'error'})`;
  }
}

/** Pure half: the marker's text → status, at `now`. */
export function backupStatusFromMarker(text: string, now: Date): PlatformStatusBackupWire {
  const stamp = text
    .split('\n')
    .filter((line) => line.startsWith('timestamp='))
    .map((line) => line.slice('timestamp='.length).trim())
    .pop();
  if (stamp === undefined || stamp.length === 0) {
    return unknown('backup marker has no timestamp= line');
  }
  const at = Date.parse(stamp);
  if (!UTC_TIMESTAMP.test(stamp) || Number.isNaN(at)) {
    return unknown(`backup marker timestamp '${stamp.slice(0, 64)}' is not a UTC ISO time`);
  }
  const ageMinutes = Math.floor((now.getTime() - at) / 60_000);
  const stale = ageMinutes > BACKUP_MAX_AGE_HOURS * 60;
  const age =
    ageMinutes < 0 ? 'in the future' : `${Math.floor(ageMinutes / 60)}h${ageMinutes % 60}m old`;
  return {
    status: stale ? 'stale' : 'fresh',
    lastSuccessAt: new Date(at).toISOString(),
    stale,
    maxAgeHours: BACKUP_MAX_AGE_HOURS,
    detail: stale
      ? `last successful backup ${stamp} is ${age} (> ${BACKUP_MAX_AGE_HOURS}h) — check the backup service's logs on the host (docs/runbooks/backup-restore.md)`
      : `last successful backup ${stamp} (${age}, limit ${BACKUP_MAX_AGE_HOURS}h)`,
  };
}

/** Reads the mounted marker and derives the status. Never throws. */
export async function readBackupStatus(
  file: string,
  now: Date = new Date(),
): Promise<PlatformStatusBackupWire> {
  let text: string;
  try {
    const buffer = await readFile(file);
    if (buffer.length > MAX_MARKER_BYTES) {
      return unknown(`backup marker ${file} is ${buffer.length} bytes — not a backup marker`);
    }
    text = buffer.toString('utf8');
  } catch (err) {
    return unknown(readErrorDetail(file, err));
  }
  return backupStatusFromMarker(text, now);
}
