import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PoolLike } from '../../../adapters/db/pool.js';

/**
 * interfaces/http/internal/handle-revocations: `GET /internal/handle-revocations?since=<iso>`
 * (design doc §7.7 "撤销表按 jti 周期同步不逐请求回调"; docs/development-tasks.md S1.7). `llm-proxy`
 * polls this every `REVOCATION_SYNC_INTERVAL_MS` and keeps an in-memory revoked-`jti` set, instead
 * of a per-request callback to the kernel.
 *
 * Trust boundary: behind `interfaces/internal-auth`'s shared-secret guard like every `/internal/*`
 * route (`llm-proxy` sends `Authorization: Bearer <internal token>` on each poll); this file
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
 */

export interface RevokedHandleRow {
  readonly jti: string;
  readonly revokedAt: string;
}

export interface ListRevokedSinceResult {
  readonly revoked: readonly RevokedHandleRow[];
  /** The kernel DB server's own clock (not this process's, not the caller's) — the caller should
   *  use this, not its own local time, as the `since` cursor for its next poll (avoids clock
   *  skew between the two hosts). */
  readonly now: string;
}

const DEFAULT_LIMIT = 5000;

async function defaultListRevokedSince(
  pool: PoolLike,
  since: Date,
  limit: number,
): Promise<ListRevokedSinceResult> {
  const client = await pool.connect();
  try {
    const nowResult = await client.query<{ now: Date }>('select now() as now');
    const now = nowResult.rows[0]?.now ?? new Date();

    const listResult = await client.query<{ jti: string; revoked_at: Date }>(
      `select jti, revoked_at
       from capability_handles
       where revoked_at is not null
         and revoked_at >= $1
         and expires_at > now()
       order by revoked_at asc
       limit $2`,
      [since.toISOString(), limit],
    );

    return {
      revoked: listResult.rows.map((row) => ({
        jti: row.jti,
        revokedAt: row.revoked_at.toISOString(),
      })),
      now: now.toISOString(),
    };
  } finally {
    client.release();
  }
}

const QuerySchema = z
  .object({
    since: z.string().datetime().optional(),
  })
  .passthrough();

export interface HandleRevocationsRoutesDeps {
  readonly pool: PoolLike;
  /** Injectable for tests, so route-shape tests (query parsing, response shape, status codes)
   *  never touch Postgres. Defaults to `defaultListRevokedSince` above. */
  readonly listRevokedSince?: (since: Date, limit: number) => Promise<ListRevokedSinceResult>;
}

export async function registerHandleRevocationRoutes(
  app: FastifyInstance,
  deps: HandleRevocationsRoutesDeps,
): Promise<void> {
  const listRevokedSince =
    deps.listRevokedSince ??
    ((since: Date, limit: number) => defaultListRevokedSince(deps.pool, since, limit));

  app.get('/internal/handle-revocations', async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_query', message: parsed.error.message } };
    }

    const since = parsed.data.since ? new Date(parsed.data.since) : new Date(0);

    try {
      const result = await listRevokedSince(since, DEFAULT_LIMIT);
      return { revoked: result.revoked, now: result.now };
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
