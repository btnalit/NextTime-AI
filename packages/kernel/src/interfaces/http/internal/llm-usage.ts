import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../../adapters/db/pool.js';
import { withWorkspace } from '../../../adapters/db/pool.js';
import { findAttributableTurnForSession } from '../../../application/host-bridge/index.js';
import { recordWorkerRunUsage } from '../../../application/task/index.js';
import {
  LlmUsageBatchSchema,
  type LlmUsageRecord,
  type RecordUsageOptions,
  type RecordUsageResult,
  recordUsage,
} from '../../../governance/llm-usage/index.js';

/**
 * interfaces/http/internal/llm-usage: `POST /internal/llm-usage` (design doc §7.7, §13;
 * docs/development-tasks.md S1.7). Receives the batched usage reports `llm-proxy`'s bounded
 * in-memory replay queue POSTs — a bare JSON array of `LlmUsageRecord` (S1.7 task brief: "JSON
 * array of records, batched") — and forwards each per-workspace group to
 * `governance/llm-usage`'s `recordUsage`.
 *
 * Trust boundary: every `/internal/*` route, this one included, sits behind
 * `interfaces/internal-auth`'s shared-secret guard (a root-level `onRequest` hook installed by
 * `packages/kernel/src/index.ts`'s `createServer` — `Authorization: Bearer <internal token>`,
 * constant-time compared, plus the `NEXTTIME_SUBNET_WORKERS` peer rule). This file performs no
 * authentication of its own by design: the guard is keyed on the `/internal/` route prefix so no
 * internal route can forget it. The pre-2026-09 assumption that "only `control`-network services
 * can reach the kernel" was wrong for a kernel dual-homed on `control` and `workers` — see
 * `@nexttime/shared`'s `internal-token.ts` doc comment.
 *
 * `principalId` for `withWorkspace`: this route has no authenticated human/agent principal (it's
 * a service-to-service call from `llm-proxy`, which only ever holds a Handle's *claims*, not a
 * Principal identity of its own). `llm_usage`'s RLS predicate is workspace-only (see the
 * migration's header comment), so `principalId` is inert to the policy either way — this route
 * passes each record's own `sessionId`, a real, syntactically-valid uuid already on hand, rather
 * than fabricating one.
 *
 * Turn attribution (docs/development-tasks.md S1.7 补注, 2026-09 — `llm_usage.turn_id` was always
 * NULL: `governance/llm-usage/service.ts`'s `recordUsage` has always taken a `resolveTurnId` hook,
 * but nothing ever supplied a real one, and the module itself may not import `application` to
 * build one internally, §7.10 layering — "governance may not depend on application"). This route
 * *is* the layer-legal place to close that gap: it already sits inside `application`'s upstream
 * layer (`interfaces`, which may depend on both `application` and `governance`), and it already
 * opens the same `client`/transaction `recordUsage` runs in. For each workspace group, it builds a
 * `resolveTurnId` closure over that `client` that calls `application/host-bridge`'s
 * `findAttributableTurnForSession` (session → principal → the S1.10 egress rule: the principal's
 * running Turn, else the most recent one within 5 minutes — reused verbatim, not reinvented) and
 * passes it as `options.resolveTurnId` into `recordUsage`. A session with no attributable Turn
 * (a Worker session ahead of S2, or a report delayed past the window) resolves to `null` and is
 * logged at `debug` — `recordUsage`'s own insert already treats a `null` `turn_id` as normal, and
 * this route's job is only to try to fill it in, never to reject a report over it (usage must
 * always be recorded, task brief). Idempotency is unaffected: `recordUsage`'s
 * `on conflict (workspace_id, jti, started_at) do nothing` already means a replayed report that
 * matches an existing row never touches that row's columns, `turn_id` included — this route does
 * not need its own replay guard on top of that.
 *
 * Per-Task budget accounting (docs/development-tasks.md S2.7 "usage reports carry sessionId; a
 * Worker session's usage must count against its Task's budget ... same layer-legal shape as the
 * turn attribution added in PR #37"): same pattern as `resolveTurnId` above — this route builds an
 * `onRecordInserted` closure over the same per-group `client`/transaction and passes it as
 * `options.onRecordInserted`, so `application/task`'s `recordWorkerRunUsage` runs in the *same*
 * transaction as the `llm_usage` insert it is reacting to (I18: a 100%-budget Task failure and the
 * usage row that pushed it there commit or roll back together). `recordWorkerRunUsage` itself is a
 * no-op for any session that is not a `worker_run` (an entry/other session's usage has no Task to
 * accumulate onto) — this route does not need to know which sessions those are.
 */

export interface LlmUsageRoutesDeps {
  readonly pool: PoolLike;
  /** Injectable for tests, so route-shape tests (validation, grouping, status codes) never touch
   *  Postgres. Defaults to the real `governance/llm-usage` `recordUsage`. */
  readonly recordUsage?: (
    client: PoolClient,
    records: readonly LlmUsageRecord[],
    options?: RecordUsageOptions,
  ) => Promise<RecordUsageResult>;
}

/** Groups a validated batch by `workspaceId` — `recordUsage` requires every record in one call to
 *  share a workspace (it does not open `withWorkspace` itself), and one POST body may legitimately
 *  span several workspaces (`llm-proxy` serves every workspace's requests through one process). */
function groupByWorkspace(records: readonly LlmUsageRecord[]): Map<string, LlmUsageRecord[]> {
  const groups = new Map<string, LlmUsageRecord[]>();
  for (const record of records) {
    const existing = groups.get(record.workspaceId);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(record.workspaceId, [record]);
    }
  }
  return groups;
}

export async function registerLlmUsageRoutes(
  app: FastifyInstance,
  deps: LlmUsageRoutesDeps,
): Promise<void> {
  const record = deps.recordUsage ?? recordUsage;

  app.post('/internal/llm-usage', async (request, reply) => {
    const parsed = LlmUsageBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_body', message: parsed.error.message } };
    }

    const groups = groupByWorkspace(parsed.data);
    let inserted = 0;

    try {
      for (const [workspaceId, records] of groups) {
        const first = records[0];
        if (!first) continue;
        // Idempotent inserts (unique (workspace_id, jti, started_at), on conflict do nothing) —
        // a group that fails partway through is safe to retry as a whole on the caller's next
        // flush attempt; nothing here needs to roll back a sibling group's already-committed work.
        const result = await withWorkspace(
          deps.pool,
          { workspaceId, principalId: first.sessionId },
          (client) => {
            // See module doc "Turn attribution" — bound to this group's `client`/`workspaceId` so
            // it can resolve each record's own `sessionId` within the same transaction the insert
            // below runs in.
            const resolveTurnId = async (sessionId: string): Promise<string | null> => {
              const turn = await findAttributableTurnForSession(client, {
                workspaceId,
                sessionId,
                at: new Date(),
              });
              if (!turn) {
                app.log?.debug?.(
                  { workspaceId, sessionId },
                  'llm-usage: no attributable turn for session, recording turn_id = null',
                );
                return null;
              }
              return turn.id;
            };
            // See module doc "Per-Task budget accounting" — same client/transaction as the
            // insert(s) it is reacting to; only ever called for a record `recordUsage` actually
            // inserted (not a replayed duplicate — see that function's own doc comment).
            const onRecordInserted = (usageRecord: LlmUsageRecord): Promise<void> =>
              recordWorkerRunUsage(client, workspaceId, usageRecord.sessionId, {
                inputTokens: usageRecord.inputTokens,
                outputTokens: usageRecord.outputTokens,
                cacheReadTokens: usageRecord.cacheReadTokens,
                cacheWriteTokens: usageRecord.cacheWriteTokens,
              });
            return record(client, records, { resolveTurnId, onRecordInserted });
          },
        );
        inserted += result.inserted;
      }
    } catch (err) {
      app.log?.error?.(err, 'llm-usage: failed to record a batch');
      reply.code(500);
      return { ok: false, error: { code: 'internal_error', message: 'failed to record usage' } };
    }

    return { ok: true, result: { inserted } };
  });
}
