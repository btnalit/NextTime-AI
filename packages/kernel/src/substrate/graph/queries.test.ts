import { describe, expect, it } from 'vitest';
import {
  buildFactCountsByLinkTypeQuery,
  buildGetFactForUpdateQuery,
  buildGetObjectQuery,
  buildGetObjectsByIdsQuery,
  buildInsertFactQuery,
  buildListFactsQuery,
  buildMarkFactInvalidatedQuery,
  buildMarkFactSupersededQuery,
  buildNeighborsQuery,
  buildRecentFactsQuery,
  buildSearchQuery,
  buildStateAtFactsQuery,
  buildTraverseQuery,
  buildUpsertObjectQuery,
  decodeFactsCursor,
  decodeSearchCursor,
  encodeFactsCursor,
  encodeSearchCursor,
} from './queries.js';
import {
  DEFAULT_LIST_FACTS_LIMIT,
  DEFAULT_RECENT_FACTS_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_TRAVERSE_DEPTH,
  TraverseDepthError,
} from './store.js';

/**
 * Unit tests (no database) for substrate/graph/queries.ts's pure SQL builders —
 * docs/development-tasks.md S1.2: "unit ... for CTE/query builders".
 */

describe('buildUpsertObjectQuery', () => {
  it('inserts without ON CONFLICT when no identity is given', () => {
    const q = buildUpsertObjectQuery('ws1', { objectType: 'test.thing', properties: { a: 1 } });
    expect(q.text).toContain('insert into objects');
    expect(q.text).not.toContain('on conflict');
    // S5.2: the trailing `last_observed_at` is `null` for every writer that is not an observation.
    expect(q.values).toEqual(['ws1', 'test.thing', JSON.stringify({ a: 1 }), null]);
  });

  it('S5.2: an observing writer binds last_observed_at, kept on conflict through coalesce', () => {
    const observedAt = new Date('2026-09-17T00:00:00Z');
    const q = buildUpsertObjectQuery('ws1', {
      objectType: 'test.thing',
      identity: { k: 'v' },
      observedAt,
    });
    expect(q.text).toContain(
      'last_observed_at = coalesce(excluded.last_observed_at, objects.last_observed_at)',
    );
    expect(q.values.at(-1)).toBe(observedAt);
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
      null,
    ]);
  });

  it('defaults properties to {} when omitted', () => {
    const q = buildUpsertObjectQuery('ws1', { objectType: 'test.thing' });
    expect(q.values.at(-2)).toBe('{}');
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
  it('binds all 13 params in order, including a null supersedesId for a fresh assert', () => {
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
      observationId: null,
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
      null,
    ]);
    expect(q.text).toContain('coalesce($6::timestamptz, now())');
  });

  it('carries a non-null supersedesId and observationId through for supersedeFact', () => {
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
      observationId: 'obs1',
    });
    expect(q.values.at(-1)).toBe('obs1');
    expect(q.values.at(-2)).toBe('old-fact-1');
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

  it('invalidate sets invalidated_at and invalidation_reason', () => {
    const q = buildMarkFactInvalidatedQuery('ws1', 'fact1', 'no longer accurate');
    expect(q.text).toContain('set invalidated_at = now()');
    expect(q.text).not.toContain('superseded_at =');
    expect(q.values).toEqual(['ws1', 'fact1', 'no longer accurate']);
  });

  it('invalidate with no reason binds null', () => {
    const q = buildMarkFactInvalidatedQuery('ws1', 'fact1', null);
    expect(q.values).toEqual(['ws1', 'fact1', null]);
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
    expect(q.values).toEqual(['ws1', null, '%widget%', DEFAULT_SEARCH_LIMIT, null, null]);
  });

  it('binds an explicit objectType and limit', () => {
    const q = buildSearchQuery('ws1', { query: 'widget', objectType: 'test.thing', limit: 10 });
    expect(q.values).toEqual(['ws1', 'test.thing', '%widget%', 10, null, null]);
  });

  it('with a valid cursor binds the decoded timestamp and id as values 5 and 6, and orders/filters by (updated_at, id)', () => {
    const updatedAt = new Date('2026-01-01T00:00:00.000Z');
    const cursor = encodeSearchCursor(updatedAt, '11111111-2222-4333-8444-555555555555');
    const q = buildSearchQuery('ws1', { query: 'widget', cursor });
    expect(q.values).toEqual([
      'ws1',
      null,
      '%widget%',
      DEFAULT_SEARCH_LIMIT,
      updatedAt.toISOString(),
      '11111111-2222-4333-8444-555555555555',
    ]);
    // Millisecond-truncated on the SQL side to match the cursor's JS-Date precision (see
    // buildSearchQuery's doc comment) — a raw `updated_at` here would skip boundary rows.
    expect(q.text).toContain(
      "(date_trunc('milliseconds', updated_at), id) < ($5::timestamptz, $6::uuid)",
    );
    expect(q.text).toContain("order by date_trunc('milliseconds', updated_at) desc, id desc");
  });
});

describe('encodeSearchCursor / decodeSearchCursor', () => {
  it('round-trips an updatedAt/id pair', () => {
    const updatedAt = new Date('2026-03-04T05:06:07.000Z');
    const cursor = encodeSearchCursor(updatedAt, '0f4b6c2e-1d3a-4e5f-8a9b-0c1d2e3f4a5b');
    expect(decodeSearchCursor(cursor)).toEqual({
      updatedAt: updatedAt.toISOString(),
      id: '0f4b6c2e-1d3a-4e5f-8a9b-0c1d2e3f4a5b',
    });
  });

  it('returns null for a malformed, undefined, or separator-less cursor rather than throwing', () => {
    expect(decodeSearchCursor('not-base64!!')).toBeNull();
    expect(decodeSearchCursor(undefined)).toBeNull();
    // Valid base64url with no `|` separator between timestamp and id.
    expect(
      decodeSearchCursor(Buffer.from('no-separator-here', 'utf8').toString('base64url')),
    ).toBeNull();
    // A well-formed timestamp with a non-UUID id must also read as "no cursor" — it is bound as
    // `$6::uuid`, so letting it through would surface as a Postgres cast error (a 500).
    expect(
      decodeSearchCursor(
        Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid', 'utf8').toString('base64url'),
      ),
    ).toBeNull();
  });
});

describe('buildRecentFactsQuery', () => {
  it('defaults the limit to DEFAULT_RECENT_FACTS_LIMIT', () => {
    const q = buildRecentFactsQuery('ws1', undefined);
    expect(q.values).toEqual(['ws1', DEFAULT_RECENT_FACTS_LIMIT]);
  });

  it('binds an explicit limit', () => {
    const q = buildRecentFactsQuery('ws1', 5);
    expect(q.values).toEqual(['ws1', 5]);
  });

  it('only reads currently-active facts, newest first, with no anchor object', () => {
    const q = buildRecentFactsQuery('ws1', 5);
    expect(q.text).toContain('superseded_at is null');
    expect(q.text).toContain('invalidated_at is null');
    expect(q.text).toContain('order by recorded_at desc');
    expect(q.text).not.toContain('source_object_id = $2');
  });

  // Real-model round 4: every Fact of one call shares its transaction's `recorded_at`, so without
  // `id` breaking ties the LIMIT picked an arbitrary subset that could change per call.
  it('breaks recorded_at ties by id, so the same rows come back every time', () => {
    const q = buildRecentFactsQuery('ws1', 5);
    expect(q.text).toMatch(/order by recorded_at desc, id desc\s+limit \$2/);
  });
});

describe('buildListFactsQuery', () => {
  it('reads active Facts of one link type workspace-wide, keyset-ordered with an id tiebreaker', () => {
    const q = buildListFactsQuery('ws1', { linkType: 'depends_on' });
    expect(q.values).toEqual(['ws1', 'depends_on', DEFAULT_LIST_FACTS_LIMIT, null, null]);
    expect(q.text).toContain('link_type = $2');
    expect(q.text).toContain('superseded_at is null');
    expect(q.text).toContain('invalidated_at is null');
    expect(q.text).toContain('link_visible_to_caller(l.workspace_id, l.activity_id)');
    expect(q.text).toContain("order by date_trunc('milliseconds', recorded_at) desc, id desc");
    expect(q.text).not.toContain('source_object_id = ');
  });

  it('binds a decoded cursor as the keyset boundary and a malformed one as the first page', () => {
    const recordedAt = new Date('2026-10-09T10:00:00.123Z');
    const id = '11111111-2222-4333-8444-555555555555';
    const q = buildListFactsQuery('ws1', {
      linkType: 'runs_on',
      limit: 7,
      cursor: encodeFactsCursor(recordedAt, id),
    });
    expect(q.values).toEqual(['ws1', 'runs_on', 7, recordedAt.toISOString(), id]);
    expect(q.text).toContain(
      "(date_trunc('milliseconds', recorded_at), id) < ($4::timestamptz, $5::uuid)",
    );

    const malformed = buildListFactsQuery('ws1', { linkType: 'runs_on', cursor: 'nope' });
    expect(malformed.values.slice(3)).toEqual([null, null]);
  });

  it('applies the viewer filter after its own binds', () => {
    const q = buildListFactsQuery(
      'ws1',
      { linkType: 'exposes' },
      {
        principalId: 'p1',
        seesEveryDraft: false,
      },
    );
    expect(q.values).toEqual(['ws1', 'exposes', DEFAULT_LIST_FACTS_LIMIT, null, null, false, 'p1']);
    expect(q.text).toContain('not $6::boolean');
  });
});

describe('encodeFactsCursor / decodeFactsCursor', () => {
  it('round-trips and rejects anything that is not <iso>|<uuid>', () => {
    const recordedAt = new Date('2026-10-09T10:00:00.123Z');
    const id = '11111111-2222-4333-8444-555555555555';
    expect(decodeFactsCursor(encodeFactsCursor(recordedAt, id))).toEqual({
      recordedAt: recordedAt.toISOString(),
      id,
    });
    expect(decodeFactsCursor(undefined)).toBeNull();
    expect(decodeFactsCursor('%%%')).toBeNull();
    expect(
      decodeFactsCursor(Buffer.from(`not-a-date|${id}`, 'utf8').toString('base64url')),
    ).toBeNull();
    expect(
      decodeFactsCursor(
        Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid', 'utf8').toString('base64url'),
      ),
    ).toBeNull();
  });
});

describe('buildFactCountsByLinkTypeQuery', () => {
  it('counts active, visible Facts per link type in link-type order', () => {
    const q = buildFactCountsByLinkTypeQuery('ws1');
    expect(q.values).toEqual(['ws1']);
    expect(q.text).toContain('superseded_at is null');
    expect(q.text).toContain('invalidated_at is null');
    expect(q.text).toContain('link_visible_to_caller(l.workspace_id, l.activity_id)');
    expect(q.text).toMatch(/group by link_type\s+order by link_type/);

    const narrowed = buildFactCountsByLinkTypeQuery('ws1', {
      principalId: 'p1',
      seesEveryDraft: true,
    });
    expect(narrowed.values).toEqual(['ws1', true, 'p1']);
    expect(narrowed.text).toContain('not $2::boolean');
  });
});

// STATUS leftover 123 (D-26): a viewer adds the Operation-draft filter and its two binds after the
// query's own; no viewer leaves the query and its binds as they were (internal callers).
describe('Operation-draft viewer filter', () => {
  const viewer = { principalId: 'p1', seesEveryDraft: false };

  it('get_object / getObjectsByIds: a row-level predicate on objects, binds $3 / $4', () => {
    const q = buildGetObjectQuery('ws1', 'obj1', viewer);
    expect(q.values).toEqual(['ws1', 'obj1', false, 'p1']);
    expect(q.text).toContain("and not (objects.object_type = 'Operation'");
    expect(q.text).toContain("coalesce(objects.properties ->> 'status', 'draft') = 'draft'");
    expect(q.text).toContain('not $3::boolean');
    expect(q.text).toContain("objects.properties ->> 'proposedBy' is distinct from $4::text");
    expect(q.text).not.toContain('hidden_op');

    const byIds = buildGetObjectsByIdsQuery('ws1', ['a', 'b'], viewer);
    expect(byIds.values).toEqual(['ws1', ['a', 'b'], false, 'p1']);
    expect(byIds.text).toContain('not $3::boolean');
  });

  it('without a viewer the object queries carry no filter', () => {
    expect(buildGetObjectQuery('ws1', 'obj1').text).not.toContain('Operation');
    expect(buildGetObjectsByIdsQuery('ws1', ['a']).values).toEqual(['ws1', ['a']]);
    expect(buildSearchQuery('ws1', { query: 'x' }).text).not.toContain('Operation');
    expect(buildTraverseQuery('ws1', { fromId: 'obj1' }).text).not.toContain('hidden_op');
  });

  it('search filters in the WHERE (before limit and cursor), binds $7 / $8', () => {
    const q = buildSearchQuery('ws1', { query: 'widget' }, viewer);
    expect(q.values).toEqual([
      'ws1',
      null,
      '%widget%',
      DEFAULT_SEARCH_LIMIT,
      null,
      null,
      false,
      'p1',
    ]);
    expect(q.text).toContain('not $7::boolean');
    expect(q.text.indexOf("objects.object_type = 'Operation'")).toBeLessThan(
      q.text.indexOf('order by'),
    );
  });

  it('traverse drops Facts touching a hidden draft in both the base and the recursive term', () => {
    const q = buildTraverseQuery('ws1', { fromId: 'obj1', depth: 2 }, viewer);
    expect(q.values).toEqual(['ws1', 'obj1', 'both', null, 2, false, 'p1']);
    expect(q.text.split('and not exists (').length - 1).toBe(2);
    expect(q.text).toContain('hidden_op.id in (l.source_object_id, l.target_object_id)');
    expect(q.text).toContain('not $6::boolean');
  });

  it('state_at and recent Facts drop Facts touching a hidden draft', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const stateAt = buildStateAtFactsQuery('ws1', { objectId: 'obj1', at }, viewer);
    expect(stateAt.values).toEqual(['ws1', 'obj1', at, false, 'p1']);
    expect(stateAt.text).toContain('hidden_op.id in (l.source_object_id, l.target_object_id)');
    expect(stateAt.text).toContain('not $4::boolean');

    const recent = buildRecentFactsQuery('ws1', 5, viewer);
    expect(recent.values).toEqual(['ws1', 5, false, 'p1']);
    expect(recent.text).toContain('not $3::boolean');
  });
});
