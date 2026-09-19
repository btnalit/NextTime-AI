import { describe, expect, it } from 'vitest';
import { GRAPH_PATH, auditHrefForNode, graphHref, parseGraphHash } from './graph-route.js';

describe('graph-route', () => {
  it('parses the bare path and a query, drops empty values, ignores unknown keys', () => {
    expect(parseGraphHash(GRAPH_PATH)).toEqual({});
    expect(parseGraphHash('#/work/graph?objectId=o-1&q=web&type=Host&at=&x=1')).toEqual({
      objectId: 'o-1',
      q: 'web',
      type: 'Host',
    });
  });

  it('returns null for any other route', () => {
    expect(parseGraphHash('#/work/chats')).toBeNull();
    expect(parseGraphHash('#/work/graphs')).toBeNull();
    expect(parseGraphHash('')).toBeNull();
  });

  it('round-trips through graphHref with a stable key order and encoding', () => {
    const query = { q: 'a b&c', objectId: 'o-1', at: '2026-09-19T10:00:00.000Z' };
    const href = graphHref(query);
    expect(href.startsWith(`${GRAPH_PATH}?objectId=`)).toBe(true);
    expect(parseGraphHash(href)).toEqual(query);
    expect(graphHref({})).toBe(GRAPH_PATH);
    expect(graphHref({ q: '' })).toBe(GRAPH_PATH);
  });

  it('builds the audit deep link on the router’s audit href', () => {
    expect(auditHrefForNode('f/1')).toBe('#/govern/audit?nodeId=f%2F1');
  });
});
