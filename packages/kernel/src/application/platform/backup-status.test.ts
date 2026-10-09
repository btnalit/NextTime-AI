import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_MAX_AGE_HOURS,
  DEFAULT_BACKUP_LAST_SUCCESS_FILE,
  backupStatusFromMarker,
  readBackupStatus,
  resolveBackupLastSuccessFile,
} from './backup-status.js';

/** D-28: `platform_status.backup` from the backup service's `last-success` marker. */

const NOW = new Date('2026-10-03T12:00:00Z');

function marker(stamp: string): string {
  return `timestamp=${stamp}\ndb_dump=/data/backups/db/nexttime-20261003T033000Z.dump size=123\nfiles_tar=/data/backups/files/files-20261003T033000Z.tgz size=456\n`;
}

describe('backupStatusFromMarker', () => {
  it('is fresh within the limit and carries the timestamp', () => {
    expect(backupStatusFromMarker(marker('2026-10-03T03:30:00Z'), NOW)).toEqual({
      status: 'fresh',
      lastSuccessAt: '2026-10-03T03:30:00.000Z',
      stale: false,
      maxAgeHours: BACKUP_MAX_AGE_HOURS,
      detail: expect.stringContaining('8h30m old'),
    });
  });

  it('uses the same boundary as check-backup-freshness.sh: exactly 26h is fresh, one minute more is stale', () => {
    expect(backupStatusFromMarker(marker('2026-10-02T10:00:00Z'), NOW).stale).toBe(false);
    const stale = backupStatusFromMarker(marker('2026-10-02T09:59:00Z'), NOW);
    expect(stale).toMatchObject({ status: 'stale', stale: true });
    expect(stale.detail).toContain("backup service's logs");
  });

  it('reads the last timestamp= line when there are several', () => {
    const text = `${marker('2026-09-01T00:00:00Z')}${marker('2026-10-03T03:30:00Z')}`;
    expect(backupStatusFromMarker(text, NOW).lastSuccessAt).toBe('2026-10-03T03:30:00.000Z');
  });

  it('is unknown, never fresh, without a parseable UTC timestamp', () => {
    for (const text of ['', 'db_dump=/x size=1\n', 'timestamp=\n', 'timestamp=yesterday\n']) {
      expect(backupStatusFromMarker(text, NOW)).toMatchObject({
        status: 'unknown',
        lastSuccessAt: null,
        stale: null,
      });
    }
    expect(backupStatusFromMarker('timestamp=2026-10-03 03:30:00\n', NOW).status).toBe('unknown');
  });
});

describe('readBackupStatus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'backup-status-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a marker file', async () => {
    const file = path.join(dir, 'last-success');
    await writeFile(file, marker('2026-10-03T03:30:00Z'));
    expect((await readBackupStatus(file, NOW)).status).toBe('fresh');
  });

  it('a missing marker is unknown, not an error', async () => {
    const status = await readBackupStatus(path.join(dir, 'missing'), NOW);
    expect(status).toMatchObject({ status: 'unknown', lastSuccessAt: null, stale: null });
    expect(status.detail).toContain('no backup marker');
  });

  it('a directory where the marker should be is unknown with the reason', async () => {
    const file = path.join(dir, 'last-success');
    await mkdir(file);
    const status = await readBackupStatus(file, NOW);
    expect(status.status).toBe('unknown');
    expect(status.detail).toContain('is a directory');
  });

  it('an oversized file is not taken for the marker', async () => {
    const file = path.join(dir, 'last-success');
    await writeFile(file, `${marker('2026-10-03T03:30:00Z')}${'x'.repeat(5000)}`);
    const status = await readBackupStatus(file, NOW);
    expect(status.status).toBe('unknown');
    expect(status.detail).toContain('bytes — not a backup marker');
  });

  it('a symlink is refused, not followed (#530 review)', async () => {
    const real = path.join(dir, 'elsewhere');
    await writeFile(real, marker('2026-10-03T03:30:00Z'));
    const file = path.join(dir, 'last-success');
    await symlink(real, file);
    const status = await readBackupStatus(file, NOW);
    expect(status.status).toBe('unknown');
    expect(status.detail).toContain('symlink');
  });

  it('a FIFO is refused without blocking the read (#530 review)', async () => {
    const file = path.join(dir, 'last-success');
    execFileSync('mkfifo', [file]);
    const status = await readBackupStatus(file, NOW);
    expect(status.status).toBe('unknown');
    expect(status.detail).toContain('not a regular file');
  });
});

describe('resolveBackupLastSuccessFile', () => {
  it('defaults to the compose mount and honours an override', () => {
    expect(resolveBackupLastSuccessFile({})).toBe(DEFAULT_BACKUP_LAST_SUCCESS_FILE);
    expect(resolveBackupLastSuccessFile({ BACKUP_LAST_SUCCESS_FILE: '/tmp/m' })).toBe('/tmp/m');
  });
});
