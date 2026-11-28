import { fileURLToPath } from 'node:url';
import { createPool } from '../adapters/db/pool.js';
import type { PoolLike } from '../adapters/db/pool.js';
import { findUserByLogin } from '../application/identity/index.js';
import {
  COUNTED_CATEGORIES,
  RAW_SECRET_SCRUB_BATCH_SIZE,
  REWRITTEN_CATEGORIES,
  RawSecretScrubFailedError,
  TAIL_UNPROVEN_CATEGORIES,
  envAdminLogins,
  scrubRawSecrets,
} from '../application/platform/index.js';
import type {
  CountedRawSecretCategory,
  CountedRawSecretRow,
  LiveApiKeyRow,
  ScrubRawSecretsResult,
  TailUnprovenCategory,
} from '../application/platform/index.js';

/**
 * Operator CLI for the rows written before STATUS legacy 183–187 were fixed — what it rewrites and
 * what it only counts is in application/platform/scrub-raw-secrets.ts.
 *
 * Usage:
 *   node dist/cli/scrub-raw-secrets.js [--dry-run | --yes] [--batch-size <n>] [--actor <login>]
 *
 * Without `--yes` it is a dry run (the default): every row is read and classified, and nothing is
 * written. `--yes` rewrites, one short transaction per window of `--batch-size` rows, and writes
 * one `cli.raw_secrets_scrubbed` platform audit row attributed to `--actor <login>`, else the first
 * `NEXTTIME_PLATFORM_ADMINS` login, else unattributed. Every counted row is printed by id, never
 * by value, one `counted <category> <workspace>/<id>` line each (`<id>` alone for a platform row),
 * uncapped — the operator goes through them row by row; the per-category report lines and the
 * audit row carry only the first few. Likewise every row of the database holding a platform API
 * key still issued: one `live-api-key <table> <row> principal <workspace>/<id> <kind>[ user <id>]`
 * line each (`<row>` its primary key, `/`-joined), ids only — the keys to rotate, one Principal
 * each (`liveApiKeys=` in the summary). And every row «收尾未证明» (`tailUnproven` — the text after a
 * mask does not pass the tail check: a row to look at, not a secret found), one
 * `tail-unproven <category> <workspace>/<id>` line each, uncapped, and `tailUnproven=` in the
 * summary; nothing is rewritten for them.
 *
 * `scripts/apply-release.sh` runs `--yes` right after the release's `BACKUP_NOW` — that dump is the
 * recovery point. The last stdout line is a one-line summary the script echoes as its
 * `STEP raw-secret-scrub` line; on failure the last line (stderr) says what failed, and the exit
 * code is 1. Runs on the login role (`DATABASE_URL`), like compact-observations.
 */

export class ScrubRawSecretsUsageError extends Error {}

export interface ScrubRawSecretsCliArgs {
  readonly confirm: boolean;
  readonly batchSize: number;
  readonly actorLogin?: string;
}

const USAGE = 'usage: scrub-raw-secrets [--dry-run | --yes] [--batch-size <n>] [--actor <login>]';

/** Parses the flags; exported so the guards are unit-testable without a database. */
export function parseScrubRawSecretsArgs(argv: readonly string[]): ScrubRawSecretsCliArgs {
  let yes = false;
  let dryRun = false;
  let batchSize = RAW_SECRET_SCRUB_BATCH_SIZE;
  let actorLogin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) {
      throw new ScrubRawSecretsUsageError(`${USAGE}\nunknown argument: ${token}`);
    }
    const eq = token.indexOf('=');
    const flag = token.slice(2, eq === -1 ? undefined : eq);
    const takeValue = (): string => {
      if (eq !== -1) return token.slice(eq + 1);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ScrubRawSecretsUsageError(`${USAGE}\n--${flag} needs a value`);
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
      case 'batch-size': {
        const raw = takeValue();
        if (!/^[1-9][0-9]*$/.test(raw)) {
          throw new ScrubRawSecretsUsageError(`${USAGE}\n--batch-size must be a positive integer`);
        }
        batchSize = Number(raw);
        break;
      }
      case 'actor':
        actorLogin = takeValue();
        break;
      default:
        throw new ScrubRawSecretsUsageError(`${USAGE}\nunknown argument: ${token}`);
    }
  }
  if (yes && dryRun) {
    throw new ScrubRawSecretsUsageError(`${USAGE}\n--yes and --dry-run are exclusive`);
  }
  return { confirm: yes, batchSize, ...(actorLogin !== undefined ? { actorLogin } : {}) };
}

/** `--actor <login>` (must exist), else the first `NEXTTIME_PLATFORM_ADMINS` login if that user
 *  exists, else `undefined` — the same resolution as compact-observations. */
async function resolveActor(
  pool: PoolLike,
  actorLogin: string | undefined,
): Promise<{ readonly id: string; readonly login: string } | undefined> {
  if (actorLogin !== undefined) {
    const user = await findUserByLogin(pool, actorLogin);
    if (!user) throw new ScrubRawSecretsUsageError(`--actor: no user with login "${actorLogin}"`);
    return { id: user.id, login: user.login };
  }
  const [envAdmin] = envAdminLogins();
  if (envAdmin === undefined) return undefined;
  const user = await findUserByLogin(pool, envAdmin);
  return user ? { id: user.id, login: user.login } : undefined;
}

/** One counted row, as the CLI prints it while it scans. */
export function formatCountedRow(
  category: CountedRawSecretCategory,
  row: CountedRawSecretRow,
): string {
  return `counted ${category} ${row.workspaceId ? `${row.workspaceId}/${row.id}` : row.id}`;
}

/** One row «收尾未证明», as the CLI prints it while it scans. */
export function formatTailUnprovenRow(
  category: TailUnprovenCategory,
  row: CountedRawSecretRow,
): string {
  return `tail-unproven ${category} ${row.workspaceId ? `${row.workspaceId}/${row.id}` : row.id}`;
}

/** One row holding a key still issued, as the CLI prints it while it scans: the row, then whose key
 *  it is — never the key, never its hash. */
export function formatLiveApiKeyRow(row: LiveApiKeyRow): string {
  const user = row.userId !== null ? ` user ${row.userId}` : '';
  return `live-api-key ${row.table} ${row.row.join('/')} principal ${row.principalWorkspaceId}/${row.principalId} ${row.principalKind}${user}`;
}

/** A counted category's rows carry a credential, except the duplicates `connectedSystems` leaves
 *  behind — listed for the record, with nothing to fix. */
function countedLabel(name: CountedRawSecretCategory): {
  readonly group: string;
  readonly rows: string;
} {
  return name === 'connectedSystemDuplicates'
    ? { group: 'listed, nothing to fix', rows: 'duplicates' }
    : { group: 'counted, not rewritten', rows: 'carrying' };
}

/** The report; its last line is the one-line summary `apply-release.sh` echoes. */
export function formatScrubReport(
  result: ScrubRawSecretsResult,
  actor: { readonly login: string } | undefined,
): string[] {
  const verb = result.executed ? 'rewritten' : 'would-rewrite';
  const lines = [
    `scrub-raw-secrets: ${result.executed ? 'executing' : 'dry run — nothing written'} (batch ${result.batchSize})`,
  ];
  for (const name of REWRITTEN_CATEGORIES) {
    const c = result.categories[name];
    const skipped = c.skipped > 0 ? ` skipped-changed-meanwhile=${c.skipped}` : '';
    lines.push(
      `${name}: examined=${c.examined} ${verb}=${c.affected - c.skipped} values=${c.values}${skipped}`,
    );
  }
  for (const name of COUNTED_CATEGORIES) {
    const c = result.categories[name];
    const ids = c.examples.map((e) => (e.workspaceId ? `${e.workspaceId}/${e.id}` : e.id));
    const more =
      c.affected > ids.length ? `,… (all ${c.affected}: the "counted ${name}" lines)` : '';
    const listed = ids.length > 0 ? ` ids=${ids.join(',')}${more}` : '';
    const label = countedLabel(name);
    lines.push(
      `${name} (${label.group}): examined=${c.examined} ${label.rows}=${c.affected}${listed}`,
    );
  }
  for (const name of TAIL_UNPROVEN_CATEGORIES) {
    const c = result.tailUnproven[name];
    const ids = c.examples.map((e) => (e.workspaceId ? `${e.workspaceId}/${e.id}` : e.id));
    const more = c.rows > ids.length ? `,… (all ${c.rows}: the "tail-unproven ${name}" lines)` : '';
    const listed = ids.length > 0 ? ` ids=${ids.join(',')}${more}` : '';
    lines.push(
      `${name} tail unproven (a row to look at, not a secret count; not rewritten): rows=${c.rows}${listed}`,
    );
  }
  const live = result.liveApiKeys;
  const principals = [
    ...new Set(live.examples.map((row) => `${row.principalWorkspaceId}/${row.principalId}`)),
  ];
  const moreLive =
    live.found > live.examples.length ? `,… (all ${live.found}: the "live-api-key" lines)` : '';
  lines.push(
    `liveApiKeys (still issued, rotate each): tables=${live.tables} rows=${live.rows} keys=${live.keys} found=${live.found}${principals.length > 0 ? ` principals=${principals.join(',')}${moreLive}` : ''}`,
  );
  if (result.executed) {
    lines.push(
      result.auditRecordId !== null
        ? `audit: cli.raw_secrets_scrubbed ${result.auditRecordId} (${actor ? `actor ${actor.login}` : 'unattributed — pass --actor <login> or set NEXTTIME_PLATFORM_ADMINS'})`
        : 'audit: none written',
    );
  }
  const rewritten = REWRITTEN_CATEGORIES.reduce(
    (sum, name) => sum + result.categories[name].affected - result.categories[name].skipped,
    0,
  );
  const counted = COUNTED_CATEGORIES.map(
    (name) => `${name}=${result.categories[name].affected}`,
  ).join(' ');
  const unproven = TAIL_UNPROVEN_CATEGORIES.reduce(
    (sum, name) => sum + result.tailUnproven[name].rows,
    0,
  );
  lines.push(
    `scrub-raw-secrets: ${result.executed ? 'ok' : 'dry-run'} ${verb}=${rewritten} counted: ${counted} tailUnproven=${unproven} liveApiKeys=${live.keys} batches=${result.batches}`,
  );
  return lines;
}

async function run(): Promise<void> {
  const args = parseScrubRawSecretsArgs(process.argv.slice(2));
  const pool = createPool();
  try {
    const actor = args.confirm ? await resolveActor(pool, args.actorLogin) : undefined;
    let result: ScrubRawSecretsResult;
    try {
      result = await scrubRawSecrets(pool, {
        confirm: args.confirm,
        batchSize: args.batchSize,
        ...(actor !== undefined ? { actorUserId: actor.id } : {}),
        onCounted: (category, row) => console.log(formatCountedRow(category, row)),
        onLiveApiKey: (row) => console.log(formatLiveApiKeyRow(row)),
        onTailUnproven: (category, row) => console.log(formatTailUnprovenRow(category, row)),
      });
    } catch (err) {
      if (err instanceof RawSecretScrubFailedError) {
        // Some windows committed before the failure; their rewrites are on the audit row.
        for (const line of formatScrubReport(err.partial, actor).slice(0, -1)) console.log(line);
      }
      throw err;
    }
    for (const line of formatScrubReport(result, actor)) console.log(line);
  } finally {
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  run().catch((err: unknown) => {
    console.error(`scrub-raw-secrets: failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
