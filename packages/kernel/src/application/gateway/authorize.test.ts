import type { Capability, Role } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ForbiddenError, authorizeCapabilityCall, roleSatisfiesMinRole } from './authorize.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/authorize.test: pure unit tests — no DB, no fake `pg` client needed since
 * `authorizeCapabilityCall`/`roleSatisfiesMinRole` take already-resolved values.
 */

function capability(overrides: Partial<Capability> = {}): Capability {
  return {
    name: 'test_capability',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: z.object({}).strict(),
    description: 'test',
    ...overrides,
  };
}

function humanCaller(role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId: 'ws1', id: 'p1', kind: 'human', role, displayName: null },
    session: {
      workspaceId: 'ws1',
      id: 's1',
      principalId: 'p1',
      kind: 'web',
      onBehalfOf: 'p1',
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

function handleCaller(capabilities: readonly string[]): ResolvedCaller {
  return {
    channel: 'handle',
    claims: {
      ws: 'ws1',
      sid: 's1',
      obo: 'p1',
      scope: { capabilities: [...capabilities], resources: {} },
      jti: 'jti1',
      iat: 0,
      exp: 999999999999,
    },
  };
}

describe('roleSatisfiesMinRole', () => {
  it('undefined minRole is satisfied by every role', () => {
    for (const role of ['owner', 'builder', 'operator', 'member', 'auditor'] as const) {
      expect(roleSatisfiesMinRole(role, undefined)).toBe(true);
    }
  });

  it('owner satisfies every minRole (super-role)', () => {
    for (const minRole of ['owner', 'builder', 'operator', 'member', 'auditor'] as const) {
      expect(roleSatisfiesMinRole('owner', minRole)).toBe(true);
    }
  });

  it('every role satisfies minRole:member (the operational floor)', () => {
    for (const role of ['owner', 'builder', 'operator', 'member', 'auditor'] as const) {
      expect(roleSatisfiesMinRole(role, 'member')).toBe(true);
    }
  });

  it('non-owner roles require an exact match for non-member minRole', () => {
    expect(roleSatisfiesMinRole('member', 'owner')).toBe(false);
    expect(roleSatisfiesMinRole('builder', 'operator')).toBe(false);
    expect(roleSatisfiesMinRole('operator', 'builder')).toBe(false);
    expect(roleSatisfiesMinRole('builder', 'builder')).toBe(true);
  });

  it('member does not satisfy minRole:auditor — auditor is not "below" member', () => {
    expect(roleSatisfiesMinRole('member', 'auditor')).toBe(false);
    expect(roleSatisfiesMinRole('builder', 'auditor')).toBe(false);
    expect(roleSatisfiesMinRole('operator', 'auditor')).toBe(false);
    expect(roleSatisfiesMinRole('auditor', 'auditor')).toBe(true);
  });
});

describe('authorizeCapabilityCall', () => {
  it('allows a human caller whose role satisfies minRole', () => {
    const cap = capability({ channel: 'human', minRole: 'owner' });
    expect(() => authorizeCapabilityCall(humanCaller('owner'), cap)).not.toThrow();
  });

  it('rejects a human caller whose role does not satisfy minRole (member calling grant_capability)', () => {
    const cap = capability({ name: 'grant_capability', channel: 'human', minRole: 'owner' });
    expect(() => authorizeCapabilityCall(humanCaller('member'), cap)).toThrow(ForbiddenError);
  });

  it('rejects a handle caller on a human-only capability', () => {
    const cap = capability({ name: 'grant_capability', channel: 'human', minRole: 'owner' });
    expect(() => authorizeCapabilityCall(handleCaller(['grant_capability']), cap)).toThrow(
      ForbiddenError,
    );
  });

  it('allows a human caller on a handle-channel capability (human is a superset)', () => {
    const cap = capability({ name: 'get_object', channel: 'handle', minRole: 'member' });
    expect(() => authorizeCapabilityCall(humanCaller('member'), cap)).not.toThrow();
  });

  it('allows a handle caller whose scope includes the capability', () => {
    const cap = capability({ name: 'get_object', channel: 'handle' });
    expect(() => authorizeCapabilityCall(handleCaller(['get_object']), cap)).not.toThrow();
  });

  it('rejects a handle caller whose scope excludes the capability', () => {
    const cap = capability({ name: 'get_object', channel: 'handle' });
    expect(() => authorizeCapabilityCall(handleCaller(['traverse']), cap)).toThrow(ForbiddenError);
  });

  it('does not apply minRole to handle callers — scope alone governs', () => {
    const cap = capability({ name: 'get_object', channel: 'handle', minRole: 'owner' });
    // The handle's own scope grants it, even though a Handle has no "role" of its own.
    expect(() => authorizeCapabilityCall(handleCaller(['get_object']), cap)).not.toThrow();
  });
});
