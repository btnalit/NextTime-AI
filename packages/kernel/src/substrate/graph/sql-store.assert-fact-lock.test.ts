import type { EpistemicStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { SqlGraphStore } from './sql-store.js';

/**
 * Unit test (fake `pg` client, no Postgres — mirrors the pattern in substrate/outbox/
 * enqueue.test.ts and adapters/db/pool.test.ts) for the W5.5 advisory-lock branch added to
 * `SqlGraphStore.assertFact` (see sql-store.ts's own comment on that branch, docs/development-
 * tasks.md S3.2 "W5.5 实现说明"): `select pg_advisory_xact_lock(...)` must be issued only when the
 * *first* identity lookup (`find_active_fact_for_identity`) comes back empty — never when a prior
 * active Fact is already found, since that row already gives `FOR UPDATE`-style serialization by
 * itself.
 *
 * `sql-store.test.ts` is entirely DB-gated (`describe.runIf(DATABASE_URL !== undefined)`) with a
 * real Postgres pool and no fake-client seam of its own, so this lives in a separate file that
 * always runs, using the fake-client pattern already established elsewhere in this package.
 */

interface RecordedCall {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

function createFakeClient(handler: (call: RecordedCall) => { rows: unknown[] }) {
  const calls: RecordedCall[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      const call = { text, values };
      calls.push(call);
      return handler(call);
    }),
  };
  return { client: client as unknown as PoolClient, calls };
}

const workspaceId = 'ws-1';
const activityId = 'activity-1';
const callerId = 'principal-1';

function fullFactRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: workspaceId,
    id: 'fact-1',
    link_type: 'test.runs_on',
    source_object_id: 'obj-b',
    target_object_id: 'obj-a',
    properties: { port: 80 },
    valid_from: new Date('2026-01-01T00:00:00Z'),
    valid_until: null,
    recorded_at: new Date('2026-01-01T00:00:00Z'),
    superseded_at: null,
    invalidated_at: null,
    invalidation_reason: null,
    supersedes_id: null,
    epistemic_status: 'asserted' as EpistemicStatus,
    confidence: null,
    activity_id: activityId,
    asserted_by: callerId,
    verified_by: null,
    observation_id: null,
    ...overrides,
  };
}

describe('SqlGraphStore.assertFact — advisory lock only on the no-prior-row path (unit, fake client)', () => {
  it('does not issue pg_advisory_xact_lock when a prior active Fact is already found', async () => {
    const priorRow = fullFactRow();
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) return { rows: [priorRow] };
      if (call.text.includes('from observations')) return { rows: [] }; // no distinct Source → falls back to principal
      return { rows: [] };
    });

    const store = new SqlGraphStore();
    const result = await store.assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      {
        linkType: 'test.runs_on',
        sourceObjectId: 'obj-b',
        targetObjectId: 'obj-a',
        activityId,
        properties: { port: 80 }, // identical to priorRow → same origin (same assertedBy) + same content → unchanged, no insert
      },
    );

    const lockCalls = calls.filter((c) => c.text.includes('pg_advisory_xact_lock'));
    const identityCalls = calls.filter((c) => c.text.includes('find_active_fact_for_identity'));
    expect(lockCalls).toHaveLength(0);
    expect(identityCalls).toHaveLength(1);
    expect(result.unchanged).toBe(true);
    expect(result.id).toBe(priorRow.id);
  });

  it('issues pg_advisory_xact_lock and re-reads the identity lookup when no prior Fact is found', async () => {
    let identityCallCount = 0;
    const insertedRow = fullFactRow({ id: 'fact-2', properties: { port: 81 } });
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) {
        identityCallCount += 1;
        return { rows: [] }; // stays empty both before and after the lock — a genuinely first assertion
      }
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      if (call.text.includes('insert into links')) return { rows: [insertedRow] };
      if (call.text.includes('insert into outbox')) return { rows: [] };
      return { rows: [] };
    });

    const store = new SqlGraphStore();
    const result = await store.assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      {
        linkType: 'test.runs_on',
        sourceObjectId: 'obj-b',
        targetObjectId: 'obj-a',
        activityId,
        properties: { port: 81 },
      },
    );

    const lockCalls = calls.filter((c) => c.text.includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(1);
    expect(identityCallCount).toBe(2); // initial lookup + re-read after the lock
    expect(result.id).toBe(insertedRow.id);
    expect(result.supersedesId).toBeNull();
    expect(result.unchanged).toBeUndefined();
  });
});
