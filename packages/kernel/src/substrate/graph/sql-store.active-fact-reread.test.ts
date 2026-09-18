import type { EpistemicStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { SqlGraphStore } from './sql-store.js';

/**
 * Unit test (fake `pg` client, no Postgres — same pattern as `sql-store.assert-fact-lock.test.ts`)
 * for the S5.5 leftover-24 bounded re-read loop added to `SqlGraphStore.assertFact` (see
 * sql-store.ts's own comment on that loop, migrations/core/0029, docs/development-tasks.md §5b
 * S5.5 实现说明): after the advisory-lock re-read still finds 0 rows, `assertFact` asks
 * `latest_fact_invalidated_for_identity` whether the identity's newest row (any lifecycle state) is
 * `invalidated` — if not (it is `recorded` or `superseded`), a fresh `find_active_fact_for_identity`
 * read is worth one more try, up to a bound; if it *is* invalidated, or there is no row at all, a
 * fresh insert is correct and the loop stops immediately.
 *
 * The check is deliberately "not invalidated" rather than "superseded": a *second* concurrent
 * supersede (a fourth transaction superseding the very successor a third one just created) keeps
 * making the newest row the un-superseded tip of the chain — checking `superseded_at` on it would
 * misread "the chain kept moving" as "no successor" and stop one re-read short. The
 * "latest row active (recorded), not previously found" case below pins exactly that distinction.
 *
 * These fake-client cases pin the *decision* and the *bound* precisely (exact call counts, no real
 * blocking/EvalPlanQual involved), which the real three-transaction interleaving needs a real
 * Postgres to reproduce — that DB-gated case lives in substrate/epistemic/conflicts.test.ts.
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

function countCallsTo(calls: readonly RecordedCall[], substring: string): number {
  return calls.filter((c) => c.text.includes(substring)).length;
}

const identityInput = {
  linkType: 'test.runs_on',
  sourceObjectId: 'obj-b',
  targetObjectId: 'obj-a',
  activityId,
  properties: { port: 81 },
};

describe('SqlGraphStore.assertFact — bounded re-read after the advisory lock (leftover 24, unit, fake client)', () => {
  it('does not consult latest_fact_invalidated_for_identity when the re-read already found a row', async () => {
    const priorRow = fullFactRow(); // properties: { port: 80 }, same as the assertion below → unchanged, no supersede
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) return { rows: [priorRow] };
      if (call.text.includes('from observations')) return { rows: [] };
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      { ...identityInput, properties: { port: 80 } },
    );

    expect(result.unchanged).toBe(true);
    expect(countCallsTo(calls, 'pg_advisory_xact_lock')).toBe(0);
    expect(countCallsTo(calls, 'latest_fact_invalidated_for_identity')).toBe(0);
  });

  it('no row at all for the identity: stops after one check, inserts fresh', async () => {
    const inserted = fullFactRow({ id: 'fact-fresh' });
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) return { rows: [] };
      if (call.text.includes('latest_fact_invalidated_for_identity'))
        return { rows: [{ invalidated: null }] }; // no row for the identity at all
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      if (call.text.includes('insert into links')) return { rows: [inserted] };
      if (call.text.includes('insert into outbox')) return { rows: [] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      identityInput,
    );

    expect(result.id).toBe('fact-fresh');
    expect(result.supersedesId).toBeNull();
    // initial lookup + advisory-lock re-read = 2; the loop's own re-read never fires.
    expect(countCallsTo(calls, 'find_active_fact_for_identity')).toBe(2);
    expect(countCallsTo(calls, 'latest_fact_invalidated_for_identity')).toBe(1);
  });

  it('latest row invalidated: stops after one check, inserts fresh', async () => {
    const inserted = fullFactRow({ id: 'fact-fresh-2' });
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) return { rows: [] };
      if (call.text.includes('latest_fact_invalidated_for_identity'))
        return { rows: [{ invalidated: true }] }; // newest row exists and is invalidated — dead end
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      if (call.text.includes('insert into links')) return { rows: [inserted] };
      if (call.text.includes('insert into outbox')) return { rows: [] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      identityInput,
    );

    expect(result.id).toBe('fact-fresh-2');
    expect(countCallsTo(calls, 'find_active_fact_for_identity')).toBe(2);
    expect(countCallsTo(calls, 'latest_fact_invalidated_for_identity')).toBe(1);
  });

  it('latest row active (recorded, not superseded) but not yet visible: retries and finds it directly — the case a "superseded" check would have missed', async () => {
    const active = fullFactRow({ id: 'fact-active', asserted_by: callerId });
    const replacement = fullFactRow({
      id: 'fact-active-replacement',
      properties: { port: 81 },
      supersedes_id: 'fact-active',
    });
    let identityCallCount = 0;
    let latestCheckCount = 0;
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) {
        identityCallCount += 1;
        // 1: initial lookup (empty). 2: advisory-lock re-read (empty — stale snapshot). 3: the
        // loop's own re-read, after the invalidated check below reports `false` once.
        if (identityCallCount <= 2) return { rows: [] };
        return { rows: [active] };
      }
      if (call.text.includes('latest_fact_invalidated_for_identity')) {
        latestCheckCount += 1;
        return { rows: [{ invalidated: false }] }; // newest row is `recorded`, not invalidated
      }
      if (call.text.includes('from observations')) return { rows: [] };
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      // supersedeValidatedFact's own re-lock of the active row by id, insert, and mark-superseded.
      if (call.text.includes('for update') && call.values?.[1] === 'fact-active')
        return { rows: [active] };
      if (call.text.includes('insert into links')) return { rows: [replacement] };
      if (call.text.includes('set superseded_at')) return { rows: [active] };
      if (call.text.includes('insert into outbox')) return { rows: [] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      identityInput, // properties: { port: 81 }, differs from active's { port: 80 } → same origin, changed content → supersede
    );

    expect(identityCallCount).toBe(3);
    expect(latestCheckCount).toBe(1);
    // Found the real active row and superseded it — never an unrelated fresh insert.
    expect(result.id).toBe('fact-active-replacement');
    expect(result.supersedesId).toBe('fact-active');
    expect(calls.some((c) => c.text.includes('insert into conflicts'))).toBe(false);
  });

  it('latest row superseded (a further concurrent supersede) then the successor becomes visible: retries and builds on it, not a fresh insert', async () => {
    const successor = fullFactRow({ id: 'fact-successor', asserted_by: callerId });
    const replacement = fullFactRow({
      id: 'fact-replacement',
      properties: { port: 81 },
      supersedes_id: 'fact-successor',
    });
    let identityCallCount = 0;
    let latestCheckCount = 0;
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) {
        identityCallCount += 1;
        // 1: initial lookup (empty). 2: advisory-lock re-read (empty — successor not committed
        // yet from this statement's point of view). 3: the loop's own re-read, after the
        // invalidated check below reports `false` once — the successor is now visible.
        if (identityCallCount <= 2) return { rows: [] };
        return { rows: [successor] };
      }
      if (call.text.includes('latest_fact_invalidated_for_identity')) {
        latestCheckCount += 1;
        return { rows: [{ invalidated: false }] }; // newest row is `superseded`, not `invalidated`
      }
      if (call.text.includes('from observations')) return { rows: [] };
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      // supersedeValidatedFact's own re-lock of the successor by id, insert, and mark-superseded.
      if (call.text.includes('for update') && call.values?.[1] === 'fact-successor')
        return { rows: [successor] };
      if (call.text.includes('insert into links')) return { rows: [replacement] };
      if (call.text.includes('set superseded_at')) return { rows: [successor] };
      if (call.text.includes('insert into outbox')) return { rows: [] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      identityInput, // properties: { port: 81 }, differs from successor's { port: 80 } → same origin, changed content → supersede
    );

    expect(identityCallCount).toBe(3);
    expect(latestCheckCount).toBe(1);
    // Same origin (callerId === successor.asserted_by) with changed content → supersedeValidatedFact,
    // never a fresh unrelated insert — the loop found the real successor, not a duplicate.
    expect(calls.some((c) => c.text.includes('insert into conflicts'))).toBe(false);
    expect(result.id).toBe('fact-replacement');
    expect(result.supersedesId).toBe('fact-successor');
  });

  it('gives up after the bound and falls back to a fresh insert when the successor never becomes visible', async () => {
    const inserted = fullFactRow({ id: 'fact-gave-up' });
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity')) return { rows: [] }; // never finds a row
      if (call.text.includes('latest_fact_invalidated_for_identity'))
        return { rows: [{ invalidated: false }] }; // never invalidated — always claims worth retrying
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      if (call.text.includes('insert into links')) return { rows: [inserted] };
      if (call.text.includes('insert into outbox')) return { rows: [] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'human' },
      identityInput,
    );

    expect(result.id).toBe('fact-gave-up');
    expect(result.supersedesId).toBeNull();
    // initial lookup + advisory-lock re-read (2) + MAX_ACTIVE_FACT_REREAD_ATTEMPTS (5) more re-reads
    // inside the loop = 7; the bound is what stops this from looping forever.
    expect(countCallsTo(calls, 'find_active_fact_for_identity')).toBe(7);
    expect(countCallsTo(calls, 'latest_fact_invalidated_for_identity')).toBe(5);
  });
});
