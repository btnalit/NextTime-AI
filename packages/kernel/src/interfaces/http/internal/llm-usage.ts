import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../../adapters/db/pool.js';
import { withWorkspace } from '../../../adapters/db/pool.js';
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
 * Trust boundary (design doc §11: "内核不发布端口" — only `control`-network compose services can
 * reach the kernel at all): this route performs no additional authentication of its own. That is
 * a deliberate S1 assumption, not an oversight — see PR body "假设与偏离".
 *
 * `principalId` for `withWorkspace`: this route has no authenticated human/agent principal (it's
 * a service-to-service call from `llm-proxy`, which only ever holds a Handle's *claims*, not a
 * Principal identity of its own). `llm_usage`'s RLS predicate is workspace-only (see the
 * migration's header comment), so `principalId` is inert to the policy either way — this route
 * passes each record's own `sessionId`, a real, syntactically-valid uuid already on hand, rather
 * than fabricating one.
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
          (client) => record(client, records),
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
