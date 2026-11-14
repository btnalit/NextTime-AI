import { describe, expect, it } from 'vitest';
import { sameScope } from './role-change.js';

// application/task/role-change: a running Worker is ended when the role change leaves any of its
// Handles outside what the person may hold now — compared as sets (legacy 699).
describe('sameScope', () => {
  it('ignores the order capabilities and ids were written in, and a repeated name', () => {
    expect(
      sameScope(
        { capabilities: ['search', 'get_object'], resources: { gatekeeper: ['g1', 'g2'] } },
        {
          capabilities: ['get_object', 'search', 'search'],
          resources: { gatekeeper: ['g2', 'g1'] },
        },
      ),
    ).toBe(true);
  });

  it('reads an empty axis and a missing one as the same', () => {
    expect(
      sameScope(
        { capabilities: ['search'], resources: { gatekeeper: [] } },
        { capabilities: ['search'], resources: {} },
      ),
    ).toBe(true);
  });

  it('a capability or an id dropped on any axis is a difference', () => {
    const held = {
      capabilities: ['search', 'request_action'],
      resources: { gatekeeper: ['g1', 'g2'] },
    };
    expect(sameScope(held, { ...held, capabilities: ['search'] })).toBe(false);
    expect(sameScope(held, { ...held, resources: { gatekeeper: ['g1'] } })).toBe(false);
    expect(sameScope(held, { ...held, resources: {} })).toBe(false);
    expect(
      sameScope(
        { capabilities: ['search'], resources: { workerDefinition: ['w1'] } },
        { capabilities: ['search'], resources: { workerDefinition: ['w2'] } },
      ),
    ).toBe(false);
  });
});
