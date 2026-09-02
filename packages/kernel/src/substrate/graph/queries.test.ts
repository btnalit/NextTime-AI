import { describe, expect, it } from 'vitest';
import {
  buildGetFactForUpdateQuery,
  buildGetObjectQuery,
  buildInsertFactQuery,
  buildMarkFactInvalidatedQuery,
  buildMarkFactSupersededQuery,
  buildNeighborsQuery,
  buildSearchQuery,
  buildStateAtFactsQuery,
  buildTraverseQuery,
  buildUpsertObjectQuery,
} from './queries.js';
import { DEFAULT_SEARCH_LIMIT, MAX_TRAVERSE_DEPTH, TraverseDepthError } from './store.js';

/**
 * Unit tests (no database) for substrate/graph/queries.ts's pure SQL builders —
 * docs/development-tasks.md S1.2: "unit ... for CTE/query builders".
 */

describe('buildUpsertObjectQuery', () => {
  it('inserts without ON CONFLICT when no identity is given', () => {
    const q = buildUpsertObjectQuery('ws1', { objectType: 'test.thing', properties: { a: 1 } });
    expect(q.text).toContain('insert into objects');
    expect(q.text).not.toContain('on conflict');
    expect(q.values).toEqual(['ws1', 'test.thing', JSON.stringify({ a: 1 })]);
  });

  it('inserts without ON CONFLICT when identity is an empty object', () => {
    const q = buildUpsertObjectQuery('ws1', { objectType: 'test.thing', identity: {} });
    expect(q.text).not.toContain('on conflict');
  });

  it('upserts by identity (ON CONFLICT on the partial unique index) when identity has keys', () => {
    const q = buildUpsertObjectQuery('ws1', {
      objectType: 'test.thing',
      identity: { org: 'example', repo: 'widgets' },
      properties: { stars: 3 },
    });
    expect(q.text).toContain('on conflict (workspace_id, object_type, identity_key)');
    expect(q.text).toContain('where identity_key is not null');
    expect(q.text).toContain(
      'do update set properties = objects.properties || excluded.properties',
    );
    expect(q.values).toEqual([
      'ws1',
      'test.thing',
      JSON.stringify({ org: 'example', repo: 'widgets' }),
      JSON.stringify({ stars: 3 }),
    ]);
  });

  it('defaults properties to {} when omitted', () => {
    const q = buildUpsertObjectQuery('ws1', { objectType: 'test.thing' });
    expect(q.values.at(-1)).toBe('{}');
  });
});

describe('buildGetObjectQuery', () => {
  it('binds workspaceId and objectId positionally', () => {
    const q = buildGetObjectQuery('ws1', 'obj1');
    expect(q.values).toEqual(['ws1', 'obj1']);
    expect(q.text).toContain('workspace_id = $1');
    expect(q.text).toContain('id = $2');
  });
});

describe('buildInsertFactQuery', () => {
  it('binds all 12 params in order, including a null supersedesId for a fresh assert', () => {
    const q = buildInsertFactQuery('ws1', {
      linkType: 'test.rel',
      sourceObjectId: 'src1',
      targetObjectId: 'tgt1',
      properties: { note: 'x' },
      validFrom: null,
      validUntil: null,
      epistemicStatus: 'asserted',
      confidence: null,
      activityId: 'act1',
      assertedBy: 'principal1',
      supersedesId: null,
    });
    expect(q.values).toEqual([
      'ws1',
      'test.rel',
      'src1',
      'tgt1',
      JSON.stringify({ note: 'x' }),
      null,
      null,
      'asserted',
      null,
      'act1',
      'principal1',
      null,
    ]);
    expect(q.text).toContain('coalesce($6::timestamptz, now())');
  });

  it('carries a non-null supersedesId through for supersedeFact', () => {
    const q = buildInsertFactQuery('ws1', {
      linkType: 'test.rel',
      sourceObjectId: 'src1',
      targetObjectId: 'tgt1',
      properties: {},
      validFrom: null,
      validUntil: null,
      epistemicStatus: 'inferred',
      confidence: 0.9,
      activityId: 'act1',
      assertedBy: 'principal1',
      supersedesId: 'old-fact-1',
    });
    expect(q.values.at(-1)).toBe('old-fact-1');
    expect(q.values[8]).toBe(0.9);
  });
});

describe('buildGetFactForUpdateQuery / buildMarkFactSupersededQuery / buildMarkFactInvalidatedQuery', () => {
  it('lock the row with FOR UPDATE on read', () => {
    const q = buildGetFactForUpdateQuery('ws1', 'fact1');
    expect(q.text).toContain('for update');
    expect(q.values).toEqual(['ws1', 'fact1']);
  });

  it('supersede sets only superseded_at', () => {
    const q = buildMarkFactSupersededQuery('ws1', 'fact1');
    expect(q.text).toContain('set superseded_at = now()');
    // `invalidated_at` legitimately appears in the RETURNING column list — only the SET clause matters here.
    expect(q.text).not.toContain('invalidated_at =');
  });

  it('invalidate sets only invalidated_at', () => {
    const q = buildMarkFactInvalidatedQuery('ws1', 'fact1');
    expect(q.text).toContain('set invalidated_at = now()');
    expect(q.text).not.toContain('superseded_at =');
  });
});

describe('buildNeighborsQuery', () => {
  it('defaults direction to "both" and linkType to null', () => {
    const q = buildNeighborsQuery('ws1', { objectId: 'obj1' });
    expect(q.values).toEqual(['ws1', 'obj1', 'both', null]);
  });

  it('binds an explicit direction and linkType', () => {
    const q = buildNeighborsQuery('ws1', {
      objectId: 'obj1',
      direction: 'out',
      linkType: 'test.rel',
    });
    expect(q.values).toEqual(['ws1', 'obj1', 'out', 'test.rel']);
  });

  it('only reads currently-active facts', () => {
    const q = buildNeighborsQuery('ws1', { objectId: 'obj1' });
    expect(q.text).toContain('superseded_at is null');
    expect(q.text).toContain('invalidated_at is null');
  });
});

describe('buildTraverseQuery', () => {
  it('is a recursive CTE bounded by depth', () => {
    const q = buildTraverseQuery('ws1', { fromId: 'obj1', depth: 2 });
    expect(q.text).toContain('with recursive walk');
    expect(q.text).toContain('w.depth < $5');
    expect(q.values).toEqual(['ws1', 'obj1', 'both', null, 2]);
  });

  it('defaults depth to 1 and direction to "both" when omitted', () => {
    const q = buildTraverseQuery('ws1', { fromId: 'obj1' });
    expect(q.values).toEqual(['ws1', 'obj1', 'both', null, 1]);
  });

  it(`clamps at MAX_TRAVERSE_DEPTH (${MAX_TRAVERSE_DEPTH}) and rejects deeper requests`, () => {
    expect(() =>
      buildTraverseQuery('ws1', { fromId: 'obj1', depth: MAX_TRAVERSE_DEPTH }),
    ).not.toThrow();
    expect(() =>
      buildTraverseQuery('ws1', { fromId: 'obj1', depth: MAX_TRAVERSE_DEPTH + 1 }),
    ).toThrow(TraverseDepthError);
  });

  it('rejects depth 0', () => {
    expect(() => buildTraverseQuery('ws1', { fromId: 'obj1', depth: 0 })).toThrow(
      TraverseDepthError,
    );
  });

  it('only walks currently-active facts, in both the base case and the recursive step', () => {
    const q = buildTraverseQuery('ws1', { fromId: 'obj1', depth: 3 });
    const occurrences = q.text.split('superseded_at is null').length - 1;
    expect(occurrences).toBe(2);
  });
});

describe('buildStateAtFactsQuery', () => {
  it('binds workspaceId, objectId, and the as-of instant', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const q = buildStateAtFactsQuery('ws1', { objectId: 'obj1', at });
    expect(q.values).toEqual(['ws1', 'obj1', at]);
  });

  it('filters on both the business-time and system-time axes', () => {
    const q = buildStateAtFactsQuery('ws1', { objectId: 'obj1', at: new Date() });
    expect(q.text).toContain('valid_from <= $3');
    expect(q.text).toContain('valid_until is null or valid_until > $3');
    expect(q.text).toContain('recorded_at <= $3');
    expect(q.text).toContain('superseded_at is null or superseded_at > $3');
    expect(q.text).toContain('invalidated_at is null or invalidated_at > $3');
  });
});

describe('buildSearchQuery', () => {
  it('wraps the query in ILIKE wildcards and defaults the limit', () => {
    const q = buildSearchQuery('ws1', { query: 'widget' });
    expect(q.values).toEqual(['ws1', null, '%widget%', DEFAULT_SEARCH_LIMIT]);
  });

  it('binds an explicit objectType and limit', () => {
    const q = buildSearchQuery('ws1', { query: 'widget', objectType: 'test.thing', limit: 10 });
    expect(q.values).toEqual(['ws1', 'test.thing', '%widget%', 10]);
  });
});
