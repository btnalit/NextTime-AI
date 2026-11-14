import { ACTION_REQUEST_EDGES } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { ACTION_REQUEST_STATUS_DEPTH } from './invariant-checks.js';

/**
 * substrate/audit/invariant-checks (unit): I6 orders the transitions one transaction wrote by
 * `ACTION_REQUEST_STATUS_DEPTH`, which recovers their order only while every legal edge goes to a
 * deeper status — an edge added back to an earlier status (a cycle) breaks that, and this says so.
 */
describe('ACTION_REQUEST_STATUS_DEPTH', () => {
  it('names every status an edge reaches, and every edge goes deeper', () => {
    for (const edge of ACTION_REQUEST_EDGES) {
      const from = ACTION_REQUEST_STATUS_DEPTH[edge.from];
      const to = ACTION_REQUEST_STATUS_DEPTH[edge.to];
      expect(from, edge.from).toBeTypeOf('number');
      expect(to, edge.to).toBeTypeOf('number');
      expect(to, `${edge.from} -> ${edge.to}`).toBeGreaterThan(from as number);
    }
  });

  it('starts the lifecycle at proposed', () => {
    expect(ACTION_REQUEST_STATUS_DEPTH.proposed).toBe(0);
  });
});
