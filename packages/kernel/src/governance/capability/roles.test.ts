import { describe, expect, it } from 'vitest';
import { roleSatisfiesMinRole } from './roles.js';

/**
 * governance/capability/roles.test: unit tests only, no Postgres — `roleSatisfiesMinRole` is pure
 * data logic (see roles.ts's own doc comment on the role hierarchy this encodes: `owner` satisfies
 * everything; `minRole: 'member'` is the floor every human role clears; any other `minRole`
 * requires that exact role, since `builder` / `operator` / `auditor` are peers, not a ladder).
 */
describe('roleSatisfiesMinRole', () => {
  it('owner satisfies every minRole, including undefined', () => {
    expect(roleSatisfiesMinRole('owner', undefined)).toBe(true);
    expect(roleSatisfiesMinRole('owner', 'member')).toBe(true);
    expect(roleSatisfiesMinRole('owner', 'builder')).toBe(true);
    expect(roleSatisfiesMinRole('owner', 'operator')).toBe(true);
    expect(roleSatisfiesMinRole('owner', 'auditor')).toBe(true);
    expect(roleSatisfiesMinRole('owner', 'owner')).toBe(true);
  });

  it('minRole undefined is satisfied by every role', () => {
    expect(roleSatisfiesMinRole('member', undefined)).toBe(true);
    expect(roleSatisfiesMinRole('builder', undefined)).toBe(true);
    expect(roleSatisfiesMinRole('operator', undefined)).toBe(true);
    expect(roleSatisfiesMinRole('auditor', undefined)).toBe(true);
  });

  it('minRole: member is the floor every human role clears', () => {
    expect(roleSatisfiesMinRole('member', 'member')).toBe(true);
    expect(roleSatisfiesMinRole('builder', 'member')).toBe(true);
    expect(roleSatisfiesMinRole('operator', 'member')).toBe(true);
    expect(roleSatisfiesMinRole('auditor', 'member')).toBe(true);
  });

  it('builder / operator / auditor are peers, not a ladder: any other minRole requires an exact match', () => {
    expect(roleSatisfiesMinRole('builder', 'builder')).toBe(true);
    expect(roleSatisfiesMinRole('builder', 'operator')).toBe(false);
    expect(roleSatisfiesMinRole('builder', 'auditor')).toBe(false);

    expect(roleSatisfiesMinRole('operator', 'operator')).toBe(true);
    expect(roleSatisfiesMinRole('operator', 'builder')).toBe(false);
    expect(roleSatisfiesMinRole('operator', 'auditor')).toBe(false);

    expect(roleSatisfiesMinRole('auditor', 'auditor')).toBe(true);
    expect(roleSatisfiesMinRole('auditor', 'builder')).toBe(false);
    expect(roleSatisfiesMinRole('auditor', 'operator')).toBe(false);
  });

  it('member never satisfies a non-member, non-undefined minRole', () => {
    expect(roleSatisfiesMinRole('member', 'builder')).toBe(false);
    expect(roleSatisfiesMinRole('member', 'operator')).toBe(false);
    expect(roleSatisfiesMinRole('member', 'auditor')).toBe(false);
    expect(roleSatisfiesMinRole('member', 'owner')).toBe(false);
  });
});
