import { describe, expect, it } from 'vitest';
import { GATEKEEPER_GRANT_RESOURCE_TYPE } from '../../substrate/epistemic/index.js';
import { GATEKEEPER_GRANT_CAPABILITY } from './grants.js';

describe('GATEKEEPER_GRANT_CAPABILITY', () => {
  it('is the grant type substrate reads a request’s visibility with (legacy 421)', () => {
    expect(GATEKEEPER_GRANT_RESOURCE_TYPE).toBe(GATEKEEPER_GRANT_CAPABILITY);
  });
});
