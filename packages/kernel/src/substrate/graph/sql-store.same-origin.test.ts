import type { EpistemicStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { SqlGraphStore } from './sql-store.js';

/**
 * Unit test (fake `pg` client, no Postgres — same pattern as `sql-store.assert-fact-lock.test.ts`)
 * for the S5.2 prior-row selection in `SqlGraphStore.assertFact` (migrations/core/0027,
 * docs/development-tasks.md §5b S5.2 实现说明 "同源优先"): when the identity lookup returns several
 * still-active rows (an open Conflict keeps both sides), the writer builds on the row that is its
 * *own* — same origin — even when another origin's row is newer; only with no own row does the
 * newest become the Conflict counterpart, as before 0027.
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
const activityId = 'activity-3';
const callerId = 'principal-collector';
const otherPrincipalId = 'principal-other';

function factRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: workspaceId,
    id: 'fact-a',
    link_type: 'runs_on',
    source_object_id: 'container',
    target_object_id: 'host',
    properties: {},
    valid_from: new Date('2026-01-01T00:00:00Z'),
    valid_until: null,
    recorded_at: new Date('2026-01-01T00:00:00Z'),
    superseded_at: null,
    invalidated_at: null,
    invalidation_reason: null,
    supersedes_id: null,
    epistemic_status: 'observed' as EpistemicStatus,
    confidence: null,
    activity_id: 'activity-1',
    asserted_by: callerId,
    verified_by: null,
    observation_id: null,
    last_observation_id: null,
    last_observed_at: null,
    ...overrides,
  };
}

/** The collector's own older row A and another principal's newer contradicting row B — the state
 *  an identity is in after `collector_conflict_positive_step` (scripts/accept_s3.sh). */
const ownRowA = factRow();
const otherRowB = factRow({
  id: 'fact-b',
  properties: { marker: 'contradiction' },
  recorded_at: new Date('2026-01-02T00:00:00Z'),
  activity_id: 'activity-2',
  asserted_by: otherPrincipalId,
});

function identityFor(input: { linkType: string; sourceObjectId: string; targetObjectId: string }) {
  return { ...input, activityId };
}

describe('SqlGraphStore.assertFact — builds on the caller’s own active row, not the newest (unit, fake client)', () => {
  const identity = { linkType: 'runs_on', sourceObjectId: 'container', targetObjectId: 'host' };

  it('equal content to its own older row: unchanged on that row, no insert, no Conflict', async () => {
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity'))
        return { rows: [otherRowB, ownRowA] };
      if (call.text.includes('from observations')) return { rows: [] }; // origins fall back to principals
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'service' },
      { ...identityFor(identity), properties: {} },
    );

    expect(result.unchanged).toBe(true);
    expect(result.id).toBe('fact-a');
    expect(calls.some((c) => c.text.includes('insert into links'))).toBe(false);
    expect(calls.some((c) => c.text.includes('insert into conflicts'))).toBe(false);
  });

  it('changed content against its own older row: supersedes that row, never the newer foreign one', async () => {
    const replacement = factRow({
      id: 'fact-a2',
      properties: { port: 81 },
      supersedes_id: 'fact-a',
    });
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity'))
        return { rows: [otherRowB, ownRowA] };
      if (call.text.includes('from observations')) return { rows: [] };
      if (call.text.includes('from principals')) return { rows: [{ kind: 'service' }] };
      if (call.text.includes('for update') && call.values?.[1] === 'fact-a')
        return { rows: [ownRowA] };
      if (call.text.includes('insert into links')) return { rows: [replacement] };
      if (call.text.includes('set superseded_at')) return { rows: [ownRowA] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: callerId, kind: 'service' },
      { ...identityFor(identity), properties: { port: 81 } },
    );

    expect(result.id).toBe('fact-a2');
    expect(result.supersedesId).toBe('fact-a');
    const marked = calls.filter((c) => c.text.includes('set superseded_at'));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.values?.[1]).toBe('fact-a');
    expect(calls.some((c) => c.text.includes('insert into conflicts'))).toBe(false);
  });

  it('no own row: the newest active row is the Conflict counterpart (0017 behaviour)', async () => {
    const inserted = factRow({
      id: 'fact-c',
      properties: { marker: 'third' },
      asserted_by: 'principal-third',
    });
    const { client, calls } = createFakeClient((call) => {
      if (call.text.includes('find_active_fact_for_identity'))
        return { rows: [otherRowB, ownRowA] };
      if (call.text.includes('from observations')) return { rows: [] };
      if (call.text.includes('from principals')) return { rows: [{ kind: 'human' }] };
      if (call.text.includes('insert into links')) return { rows: [inserted] };
      return { rows: [] };
    });

    const result = await new SqlGraphStore().assertFact(
      client,
      workspaceId,
      { id: 'principal-third', kind: 'human' },
      { ...identityFor(identity), properties: { marker: 'third' } },
    );

    expect(result.id).toBe('fact-c');
    const conflict = calls.find((c) => c.text.includes('insert into conflicts'));
    expect(conflict).toBeDefined();
    expect(conflict?.values).toContain('fact-b');
    expect(conflict?.values).not.toContain('fact-a');
  });
});
