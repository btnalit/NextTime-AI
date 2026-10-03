import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PoolLike } from '../../../adapters/db/pool.js';

/**
 * interfaces/http/internal/handle-revocations: `GET /internal/handle-revocations?since=<iso>`
 * (design doc §7.7 "撤销表按 jti 周期同步不逐请求回调"; docs/development-tasks.md S1.7). `llm-proxy`
 * polls this every `REVOCATION_SYNC_INTERVAL_MS` and keeps an in-memory revoked-`jti` set, instead
 * of a per-request callback to the kernel.
 *
 * Trust boundary: behind `interfaces/internal-auth`'s credential guard like every `/internal/*`
 * route (`llm-proxy` sends `Authorization: Bearer <its own credential>` on each poll); this file
 * performs no authentication of its own — see llm-usage.ts's doc comment.
 *
 * Cross-workspace query (task brief: "reads capability_handles across workspaces — a kernel-
 * internal, superuser-pool query, so use skipRoleSwitch/no RLS as pool.ts allows"): this is a
 * deliberate, narrow exception to the §7.10 module contract ("不查询其他模块的表") — the task brief
 * itself sanctions it for exactly this endpoint, and the module boundary this file may touch is
 * restricted to this directory (not `governance/capability`'s own files) per the S1.7 dispatch's
 * ownership list. `defaultListRevokedSince` below therefore queries `capability_handles` directly,
 * on a bare `pool.connect()` (no `withWorkspace`): there is no single workspace to scope this read
 * to, and skipping the `SET LOCAL ROLE nexttime_app` switch (the same mechanism `withWorkspace`'s
 * own `skipRoleSwitch` option uses) is exactly what makes the query see every workspace's rows —
 * the pool's login role is a superuser (packages/kernel/src/adapters/db/pool.ts doc comment) and
 * therefore bypasses RLS entirely when nothing switches it to the RLS-constrained role.
 *
 * `expires_at > now()` bounds the result set: an already-expired Handle is rejected by
 * `verifyHandleToken`'s own `exp` check regardless of revocation, so there is no reason for this
 * set to grow forever — only "revoked but would otherwise still verify" rows matter. `since`
 * (default: the epoch, when the query param is omitted — the caller's very first sync) combined
 * with that bound keeps even a cold-start query small.
 *
 * Paging (review 2026-10-02 R-14): a page holds at most `pageSize` rows (5000). It used to stop
 * there silently, and llm-proxy then moved its `since` to `now`, so after a cold start with more
 * revoked-but-unexpired Handles than that the newest revocations were never synced. Rows are now
 * returned in the stable order `(revoked_at, jti)`; a full page answers `hasMore: true` with
 * `nextCursor`, which the caller passes back as `cursor` (with the same `since`) for the rows
 * after it. The cursor carries `revoked_at` to the microsecond, not the millisecond of the wire's
 * `revokedAt`: one `revokeSession` gives every Handle it touches the same `revoked_at`, and a
 * millisecond cursor would return such a page forever.
 */

export interface RevokedHandleRow {
  readonly jti: string;
  readonly revokedAt: string;
}

/** Where the previous page ended: its last row's exact `revoked_at` and `jti`. */
export interface RevocationCursor {
  /** `revoked_at` in UTC to the microsecond, as Postgres renders it (`…T12:00:00.123456Z`). */
  readonly revokedAt: string;
  readonly jti: string;
}

export interface ListRevokedSinceResult {
  readonly revoked: readonly RevokedHandleRow[];
  /** The kernel DB server's own clock (not this process's, not the caller's) — the caller should
   *  use this, not its own local time, as the `since` cursor for its next poll (avoids clock
   *  skew between the two hosts). */
  readonly now: string;
  /** Present when more rows follow this page. */
  readonly next?: RevocationCursor;
}

const DEFAULT_PAGE_SIZE = 5000;

async function defaultListRevokedSince(
  pool: PoolLike,
  since: Date,
  limit: number,
  after: RevocationCursor | undefined,
): Promise<ListRevokedSinceResult> {
  const client = await pool.connect();
  try {
    const nowResult = await client.query<{ now: Date }>('select now() as now');
    const now = nowResult.rows[0]?.now ?? new Date();

    // One row past the page proves there is a next one without a second query.
    const listResult = await client.query<{ jti: string; revoked_at: Date; cursor_at: string }>(
      `select jti, revoked_at,
              to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
       from capability_handles
       where revoked_at is not null
         and revoked_at >= $1
         and expires_at > now()
         and ($3::timestamptz is null or (revoked_at, jti) > ($3::timestamptz, $4::uuid))
       order by revoked_at asc, jti asc
       limit $2`,
      [since.toISOString(), limit + 1, after?.revokedAt ?? null, after?.jti ?? null],
    );

    const rows = listResult.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      revoked: rows.map((row) => ({
        jti: row.jti,
        revokedAt: row.revoked_at.toISOString(),
      })),
      now: now.toISOString(),
      ...(listResult.rows.length > limit && last
        ? { next: { revokedAt: last.cursor_at, jti: last.jti } }
        : {}),
    };
  } finally {
    client.release();
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeRevocationCursor(cursor: RevocationCursor): string {
  return Buffer.from(`${cursor.revokedAt}|${cursor.jti}`, 'utf8').toString('base64url');
}

/** `undefined` for anything that is not a cursor this route issued. */
export function decodeRevocationCursor(value: string): RevocationCursor | undefined {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) return undefined;
  const revokedAt = decoded.slice(0, sep);
  const jti = decoded.slice(sep + 1);
  if (!UUID_PATTERN.test(jti) || Number.isNaN(Date.parse(revokedAt))) return undefined;
  return { revokedAt, jti };
}

const QuerySchema = z
  .object({
    since: z.string().datetime().optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .passthrough();

export interface HandleRevocationsRoutesDeps {
  readonly pool: PoolLike;
  /** Injectable for tests, so route-shape tests (query parsing, response shape, status codes)
   *  never touch Postgres. Defaults to `defaultListRevokedSince` above. */
  readonly listRevokedSince?: (
    since: Date,
    limit: number,
    after: RevocationCursor | undefined,
  ) => Promise<ListRevokedSinceResult>;
  /** Rows per page; tests shrink it to page through a handful of rows. Default 5000. */
  readonly revocationPageSize?: number;
}

export async function registerHandleRevocationRoutes(
  app: FastifyInstance,
  deps: HandleRevocationsRoutesDeps,
): Promise<void> {
  const listRevokedSince =
    deps.listRevokedSince ??
    ((since: Date, limit: number, after: RevocationCursor | undefined) =>
      defaultListRevokedSince(deps.pool, since, limit, after));
  const pageSize = deps.revocationPageSize ?? DEFAULT_PAGE_SIZE;

  app.get('/internal/handle-revocations', async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_query', message: parsed.error.message } };
    }

    const since = parsed.data.since ? new Date(parsed.data.since) : new Date(0);
    const after =
      parsed.data.cursor === undefined ? undefined : decodeRevocationCursor(parsed.data.cursor);
    if (parsed.data.cursor !== undefined && after === undefined) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_query', message: 'cursor is not valid' } };
    }

    try {
      const result = await listRevokedSince(since, pageSize, after);
      return {
        revoked: result.revoked,
        now: result.now,
        hasMore: result.next !== undefined,
        ...(result.next ? { nextCursor: encodeRevocationCursor(result.next) } : {}),
      };
    } catch (err) {
      app.log?.error?.(err, 'handle-revocations: query failed');
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: 'failed to query revocations' },
      };
    }
  });
}
