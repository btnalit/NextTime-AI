import { fileURLToPath } from 'node:url';
import { createPool } from '../adapters/db/pool.js';
import type { PoolLike } from '../adapters/db/pool.js';
import { findUserByLogin } from '../application/identity/index.js';
import {
  OBSERVATION_COMPACTION_AGE_DAYS,
  OBSERVATION_COMPACTION_BATCH_SIZE,
  ObservationCompactionFailedError,
  compactObservations,
  envAdminLogins,
} from '../application/platform/index.js';
import type {
  CompactObservationsResult,
  ObservationCompactionCounts,
} from '../application/platform/index.js';

/**
 * Operator CLI for `observations` retention (STATUS leftover 103) — the mechanism and the exact
 * deletion rule are in application/platform/compact-observations.ts.
 *
 * Usage:
 *   node dist/cli/compact-observations.js [--dry-run | --yes] [--older-than-days <n>]
 *       [--batch-size <n>] [--workspace <id>] [--actor <login>]
 *
 * Without `--yes` it is a dry run (the default): every Observation older than the age gate is
 * classified and counted — kept because it carries a payload, because a Fact references it,
 * because it is its Source's newest, because it is the last row of its (activity, source) pair, or
 * deletable — and nothing is written. `--yes` deletes, in windows of `--batch-size` rows (one short
 * transaction each), and writes one `cli.observations_compacted` platform audit row attributed to
 * `--actor <login>`, else the first `NEXTTIME_PLATFORM_ADMINS` login, else unattributed
 * (`payload.attributedActor: false`, migration core 0040). `--older-than-days` defaults to 30 (the
 * maintainer's age gate, 2026-10-04).
 *
 * `scripts/apply-release.sh` runs `--yes` right after the release's `BACKUP_NOW` — that dump is
 * the recovery point. The last stdout line is a one-line summary the script echoes as its
 * `STEP observations-compaction` line; on failure the last line (stderr) says what failed, and the
 * exit code is 1. Runs on the login role (`DATABASE_URL`), like the bootstrap CLI's purge.
 */

export class CompactObservationsUsageError extends Error {}

export interface CompactObservationsCliArgs {
  readonly confirm: boolean;
  readonly olderThanDays: number;
  readonly batchSize: number;
  readonly workspaceId?: string;
  readonly actorLogin?: string;
}

const USAGE =
  'usage: compact-observations [--dry-run | --yes] [--older-than-days <n>] [--batch-size <n>] ' +
  '[--workspace <id>] [--actor <login>]';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveInteger(flag: string, raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new CompactObservationsUsageError(`${USAGE}\n--${flag} must be a positive integer`);
  }
  return Number(raw);
}

/** Parses the flags; exported so the guards are unit-testable without a database. */
export function parseCompactObservationsArgs(argv: readonly string[]): CompactObservationsCliArgs {
  let yes = false;
  let dryRun = false;
  let olderThanDays = OBSERVATION_COMPACTION_AGE_DAYS;
  let batchSize = OBSERVATION_COMPACTION_BATCH_SIZE;
  let workspaceId: string | undefined;
  let actorLogin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) {
      throw new CompactObservationsUsageError(`${USAGE}\nunknown argument: ${token}`);
    }
    const eq = token.indexOf('=');
    const flag = token.slice(2, eq === -1 ? undefined : eq);
    const takeValue = (): string => {
      if (eq !== -1) return token.slice(eq + 1);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CompactObservationsUsageError(`${USAGE}\n--${flag} needs a value`);
      }
      i++;
      return value;
    };
    switch (flag) {
      case 'yes':
        yes = true;
        break;
      case 'dry-run':
        dryRun = true;
        break;
      case 'older-than-days':
        olderThanDays = positiveInteger(flag, takeValue());
        break;
      case 'batch-size':
        batchSize = positiveInteger(flag, takeValue());
        break;
      case 'workspace': {
        const value = takeValue();
        if (!UUID_PATTERN.test(value)) {
          throw new CompactObservationsUsageError(`${USAGE}\n--workspace must be a workspace id`);
        }
        workspaceId = value;
        break;
      }
      case 'actor':
        actorLogin = takeValue();
        break;
      default:
        throw new CompactObservationsUsageError(`${USAGE}\nunknown argument: ${token}`);
    }
  }
  if (yes && dryRun) {
    throw new CompactObservationsUsageError(`${USAGE}\n--yes and --dry-run are exclusive`);
  }
  return {
    confirm: yes,
    olderThanDays,
    batchSize,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(actorLogin !== undefined ? { actorLogin } : {}),
  };
}

/** `--actor <login>` (must exist — a typo must not silently unattribute the row), else the first
 *  `NEXTTIME_PLATFORM_ADMINS` login if that user exists, else `undefined` — the same resolution as
 *  the bootstrap CLI's. */
async function resolveActor(
  pool: PoolLike,
  actorLogin: string | undefined,
): Promise<{ readonly id: string; readonly login: string } | undefined> {
  if (actorLogin !== undefined) {
    const user = await findUserByLogin(pool, actorLogin);
    if (!user)
      throw new CompactObservationsUsageError(`--actor: no user with login "${actorLogin}"`);
    return { id: user.id, login: user.login };
  }
  const [envAdmin] = envAdminLogins();
  if (envAdmin === undefined) return undefined;
  const user = await findUserByLogin(pool, envAdmin);
  return user ? { id: user.id, login: user.login } : undefined;
}

function formatCounts(counts: ObservationCompactionCounts, deletedLabel: string): string {
  return (
    `older=${counts.examined} payload=${counts.keptPayload} referenced=${counts.keptReferenced} ` +
    `source-newest=${counts.keptSourceNewest} last-of-activity-source=${counts.keptLastOfActivitySource} ` +
    `${deletedLabel}=${counts.deleted}`
  );
}

/** The report; its last line is the one-line summary `apply-release.sh` echoes. */
export function formatCompactionReport(
  result: CompactObservationsResult,
  actor: { readonly login: string } | undefined,
): string[] {
  const deletedLabel = result.executed ? 'deleted' : 'would-delete';
  const lines = [
    `compact-observations: ${result.executed ? 'executing' : 'dry run — nothing deleted'} ` +
      `(older than ${result.olderThanDays} days, cutoff ${result.cutoff}, batch ${result.batchSize})`,
  ];
  for (const ws of result.workspaces) {
    lines.push(
      `workspace ${ws.workspaceId} (${ws.name ?? '-'}): rows=${ws.rowsBefore} ${formatCounts(ws, deletedLabel)}`,
    );
  }
  lines.push(
    `total: rows=${result.totals.rowsBefore} ${formatCounts(result.totals, deletedLabel)}`,
  );
  if (result.executed) {
    lines.push(
      result.auditRecordId !== null
        ? `audit: cli.observations_compacted ${result.auditRecordId} (${actor ? `actor ${actor.login}` : 'unattributed — pass --actor <login> or set NEXTTIME_PLATFORM_ADMINS'})`
        : 'audit: none written',
    );
  }
  lines.push(
    `compact-observations: ${result.executed ? 'ok' : 'dry-run'} ${deletedLabel}=${result.totals.deleted} ` +
      `of older=${result.totals.examined} rows=${result.totals.rowsBefore} ` +
      `workspaces=${result.workspaces.filter((ws) => ws.examined > 0).length} batches=${result.batches}`,
  );
  return lines;
}

async function run(): Promise<void> {
  const args = parseCompactObservationsArgs(process.argv.slice(2));
  const pool = createPool();
  try {
    const actor = args.confirm ? await resolveActor(pool, args.actorLogin) : undefined;
    let result: CompactObservationsResult;
    try {
      result = await compactObservations(pool, {
        confirm: args.confirm,
        olderThanDays: args.olderThanDays,
        batchSize: args.batchSize,
        ...(args.workspaceId !== undefined ? { workspaceId: args.workspaceId } : {}),
        ...(actor !== undefined ? { actorUserId: actor.id } : {}),
      });
    } catch (err) {
      if (err instanceof ObservationCompactionFailedError) {
        // Some windows committed before the failure; their deletions are on the audit row.
        for (const line of formatCompactionReport(err.partial, actor).slice(0, -1)) {
          console.log(line);
        }
      }
      throw err;
    }
    for (const line of formatCompactionReport(result, actor)) console.log(line);
  } finally {
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  run().catch((err: unknown) => {
    console.error(
      `compact-observations: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  });
}
