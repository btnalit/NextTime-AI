import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { enqueue } from './enqueue.js';

/**
 * Unit tests (fake `pg` client, no Postgres) for substrate/outbox/enqueue.ts's `enqueue()` — mirrors
 * the fake-client pattern already used by adapters/db/pool.test.ts.
 */

function createFakeClient() {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    }),
  };
  return { client: client as unknown as PoolClient, calls };
}

describe('enqueue', () => {
  it('inserts one row into outbox with workspace_id/event_type/payload from the event', async () => {
    const { client, calls } = createFakeClient();

    await enqueue(client, {
      type: 'FactAsserted',
      workspaceId: 'ws1',
      factId: 'fact1',
      objectId: 'obj1',
      epistemicStatus: 'asserted',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('insert into outbox');
    expect(calls[0]?.values).toEqual([
      'ws1',
      'FactAsserted',
      JSON.stringify({
        type: 'FactAsserted',
        workspaceId: 'ws1',
        factId: 'fact1',
        objectId: 'obj1',
        epistemicStatus: 'asserted',
      }),
    ]);
  });

  it('rejects a malformed event before issuing any query', async () => {
    const { client, calls } = createFakeClient();

    await expect(
      enqueue(client, {
        type: 'FactAsserted',
        workspaceId: 'ws1',
        factId: 'fact1',
        // @ts-expect-error — deliberately invalid epistemicStatus to exercise runtime validation
        epistemicStatus: 'not-a-real-status',
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('works for every domain event shape (TaskUpdated, a non-Fact example)', async () => {
    const { client, calls } = createFakeClient();

    await enqueue(client, {
      type: 'TaskUpdated',
      workspaceId: 'ws1',
      taskId: 'task1',
      status: 'running',
    });

    expect(calls[0]?.values?.[0]).toBe('ws1');
    expect(calls[0]?.values?.[1]).toBe('TaskUpdated');
  });
});
