import { describe, expect, it } from 'vitest';
import { decodeActionRequestCursor, encodeActionRequestCursor } from './reads.js';

/**
 * Unit tests (no database) for governance/approval/reads.ts's pure cursor helpers — S5.5 leftover
 * 21 (`list_action_requests`). Mirrors substrate/graph/queries.test.ts's own
 * `encodeSearchCursor`/`decodeSearchCursor` coverage, since `encodeActionRequestCursor`/
 * `decodeActionRequestCursor` are a deliberate second private copy of that same encoding
 * (`requestedAt`/`id` in place of `updatedAt`/`id` — see this file's own doc comment).
 */

describe('encodeActionRequestCursor / decodeActionRequestCursor', () => {
  it('round-trips a requestedAt/id pair', () => {
    const requestedAt = new Date('2026-03-04T05:06:07.000Z');
    const cursor = encodeActionRequestCursor(requestedAt, '0f4b6c2e-1d3a-4e5f-8a9b-0c1d2e3f4a5b');
    expect(decodeActionRequestCursor(cursor)).toEqual({
      requestedAt: requestedAt.toISOString(),
      id: '0f4b6c2e-1d3a-4e5f-8a9b-0c1d2e3f4a5b',
    });
  });

  it('returns null for a malformed, undefined, or separator-less cursor rather than throwing', () => {
    expect(decodeActionRequestCursor('not-base64!!')).toBeNull();
    expect(decodeActionRequestCursor(undefined)).toBeNull();
    // Valid base64url with no `|` separator between timestamp and id.
    expect(
      decodeActionRequestCursor(Buffer.from('no-separator-here', 'utf8').toString('base64url')),
    ).toBeNull();
    // A well-formed timestamp with a non-UUID id must also read as "no cursor" — it is bound as
    // `$6::uuid`, so letting it through would surface as a Postgres cast error (a 500).
    expect(
      decodeActionRequestCursor(
        Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid', 'utf8').toString('base64url'),
      ),
    ).toBeNull();
  });
});
