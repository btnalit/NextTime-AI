import { describe, expect, it, vi } from 'vitest';
import type { DecisionRow } from '../../substrate/epistemic/index.js';

/**
 * Legacy 291: `listDecisionsForExplorer`'s `category` filter counts matching decisions toward
 * `skip + limit` while it pages `queryDecisions`, instead of filtering an already-full batch.
 * Pure unit test: `withWorkspace` and `queryDecisions` are replaced, so no database is needed.
 */

vi.mock('../../adapters/db/pool.js', () => ({
  withWorkspace: (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
}));

// Legacy 421: who the caller is does not matter here (the fake `queryDecisions` ignores it).
vi.mock('./draft-viewer.js', () => ({
  humanReadViewersOf: vi.fn(async (_client: unknown, _ws: unknown, principalId: string) => ({
    decisions: { principalId, seesEveryGoalRun: true, seesEveryActionRequest: true },
    drafts: { principalId, seesEveryDraft: true },
  })),
}));

/** 250 decisions newest first; only the last five carry `rationale.category = 'wanted'`. */
const DECISIONS = Array.from(
  { length: 250 },
  (_, i) =>
    ({
      id: `d${i}`,
      rationale: i >= 245 ? { category: 'wanted' } : { category: 'other' },
    }) as unknown as DecisionRow,
);

vi.mock('../../substrate/epistemic/index.js', () => ({
  causalChain: vi.fn(),
  decisionImpact: vi.fn(),
  explainByNodeId: vi.fn(),
  findPrecedents: vi.fn(),
  queryDecisions: vi.fn(async (_client: unknown, _ws: unknown, input: { cursor?: string }) => {
    const start = input.cursor ? Number(input.cursor) : 0;
    const items = DECISIONS.slice(start, start + 100);
    const next = start + 100;
    return next < DECISIONS.length ? { items, nextCursor: String(next) } : { items };
  }),
}));

const { listDecisionsForExplorer } = await import('./explorer-read-service.js');

describe('listDecisionsForExplorer category filter (legacy 291)', () => {
  it('finds matching decisions that sit behind more non-matching ones than skip + limit', async () => {
    const rows = await listDecisionsForExplorer({} as never, 'ws', 'p', {
      category: 'wanted',
      limit: 3,
    });
    expect(rows.map((r) => r.id)).toEqual(['d245', 'd246', 'd247']);
  });

  it('skip counts matching decisions only', async () => {
    const rows = await listDecisionsForExplorer({} as never, 'ws', 'p', {
      category: 'wanted',
      skip: 3,
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(['d248', 'd249']);
  });

  it('without a category it still pages in order', async () => {
    const rows = await listDecisionsForExplorer({} as never, 'ws', 'p', { skip: 98, limit: 4 });
    expect(rows.map((r) => r.id)).toEqual(['d98', 'd99', 'd100', 'd101']);
  });
});
