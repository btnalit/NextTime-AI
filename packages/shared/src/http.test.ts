import { describe, expect, it } from 'vitest';
import { CAPABILITY_REGISTRY } from './capabilities.js';
import { capabilityRoute } from './http.js';

describe('capabilityRoute', () => {
  it('projects a capability name onto POST /api/cap/<name>', () => {
    expect(capabilityRoute('get_object')).toBe('/api/cap/get_object');
  });

  it('round-trips the S1.6 context and turn-reporting capability names', () => {
    expect(capabilityRoute('get_entry_context')).toBe('/api/cap/get_entry_context');
    expect(capabilityRoute('report_turn')).toBe('/api/cap/report_turn');
  });

  it('projects every registered capability name onto a distinct route', () => {
    const routes = new Set(CAPABILITY_REGISTRY.map((capability) => capabilityRoute(capability.name)));
    expect(routes.size).toBe(CAPABILITY_REGISTRY.length);
  });
});
