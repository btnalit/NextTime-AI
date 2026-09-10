import { describe, expect, it } from 'vitest';
import { MCP_TOOL_ALIASES } from './reference-tool-aliases.js';

function findAlias(aliasName: string) {
  const alias = MCP_TOOL_ALIASES.find((a) => a.aliasName === aliasName);
  if (!alias) throw new Error(`fixture: no alias registered for "${aliasName}"`);
  return alias;
}

describe('MCP_TOOL_ALIASES', () => {
  it('has exactly the 5 aliases documented in this module’s own table (no native-name collisions)', () => {
    const names = MCP_TOOL_ALIASES.map((a) => a.aliasName).sort();
    expect(names).toEqual(
      [
        'add_relationship',
        'analyze_decision_impact',
        'get_causal_chain',
        'get_provenance',
        'search_graph',
      ].sort(),
    );
  });

  it('get_provenance → explain: entity_id → nodeId', () => {
    const alias = findAlias('get_provenance');
    expect(alias.capability).toBe('explain');
    expect(alias.translate({ entity_id: 'obj-1' })).toEqual({ nodeId: 'obj-1' });
    expect(alias.translate({})).toEqual({});
  });

  it('get_causal_chain → causal_chain: decision_id → decisionId (direction/max_depth dropped)', () => {
    const alias = findAlias('get_causal_chain');
    expect(alias.capability).toBe('causal_chain');
    expect(alias.translate({ decision_id: 'dec-1', direction: 'upstream', max_depth: 5 })).toEqual({
      decisionId: 'dec-1',
    });
  });

  it('analyze_decision_impact → decision_impact: decision_id → decisionId', () => {
    const alias = findAlias('analyze_decision_impact');
    expect(alias.capability).toBe('decision_impact');
    expect(alias.translate({ decision_id: 'dec-1' })).toEqual({ decisionId: 'dec-1' });
  });

  it('search_graph → search: query passthrough, node_type → objectType, limit → limit', () => {
    const alias = findAlias('search_graph');
    expect(alias.capability).toBe('search');
    expect(alias.translate({ query: 'foo', node_type: 'test.thing', limit: 20 })).toEqual({
      query: 'foo',
      objectType: 'test.thing',
      limit: 20,
    });
    expect(alias.translate({ query: 'foo' })).toEqual({ query: 'foo' });
    expect(alias.inputSchema.properties).toHaveProperty('limit');
  });

  it('add_relationship → assert_fact: source → objectId, target → value, type → linkType (optional)', () => {
    const alias = findAlias('add_relationship');
    expect(alias.capability).toBe('assert_fact');
    expect(alias.translate({ source: 'a', target: 'b', type: 'depends_on' })).toEqual({
      objectId: 'a',
      value: 'b',
      linkType: 'depends_on',
    });
    // Semantica's `type` is optional; ours (`linkType`) is required — omitting it is not faked
    // here, it is simply left out, and the underlying assert_fact call will 400 on its own.
    expect(alias.translate({ source: 'a', target: 'b' })).toEqual({ objectId: 'a', value: 'b' });
  });

  it('every inputSchema is a well-formed JSON Schema object type with a properties map', () => {
    for (const alias of MCP_TOOL_ALIASES) {
      expect(alias.inputSchema.type).toBe('object');
      expect(typeof alias.inputSchema.properties).toBe('object');
    }
  });
});
