import { CAPABILITY_REGISTRY, capabilityHasSideEffects, getCapability } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  AUDITOR_CONVERSATION_CAPABILITIES,
  AUDITOR_READ_CAPABILITIES,
  roleMayUseCapability,
  roleSatisfiesMinRole,
} from './roles.js';

describe('roleMayUseCapability — R-35 / D-07: the auditor is strictly read-only', () => {
  it('every allowlisted name is a real registry capability the auditor clears by minRole, and every read is side-effect free by the explicit flag', () => {
    for (const name of [...AUDITOR_READ_CAPABILITIES, ...AUDITOR_CONVERSATION_CAPABILITIES]) {
      const capability = getCapability(name);
      expect(capability, name).toBeDefined();
      expect(roleSatisfiesMinRole('auditor', capability?.minRole), name).toBe(true);
      expect(capability?.scope, name).not.toBe('platform');
    }
    for (const name of AUDITOR_READ_CAPABILITIES) {
      const capability = getCapability(name);
      expect(capability && capabilityHasSideEffects(capability), name).toBe(false);
    }
  });

  it('the auditor may use exactly its allowlist — nothing that writes, no gate, no invoke_worker', () => {
    const allowed = CAPABILITY_REGISTRY.filter((capability) =>
      roleMayUseCapability('auditor', capability),
    ).map((capability) => capability.name);
    expect(new Set(allowed)).toEqual(
      new Set([...AUDITOR_READ_CAPABILITIES, ...AUDITOR_CONVERSATION_CAPABILITIES]),
    );
    for (const name of [
      'invalidate_fact',
      'supersede_fact',
      'assert_fact',
      'invoke_worker',
      'cancel_task',
      'resolve_conflict',
      'verify_fact',
      'attest_fact',
      'record_decision',
      'deprecate_operation',
      'publish_operation',
      'update_operation_description',
      'publish_worker_definition',
      'deprecate_skill',
      'observe_operation',
      '<gate>.<op>',
      'request_action',
      'list_allowed_operations',
      'find_operations',
      'execution_readiness',
      'set_agent_profile',
      'request_connection',
    ]) {
      expect(roleMayUseCapability('auditor', getCapability(name)), name).toBe(false);
    }
    expect(roleMayUseCapability('auditor', undefined)).toBe(false);
  });

  it('a read the registry flags as writing never passes, even if someone put it on the read list', () => {
    expect(
      roleMayUseCapability('auditor', {
        name: 'audit_query',
        mode: 'observe',
        minRole: 'auditor',
        sideEffects: true,
      }),
    ).toBe(false);
  });

  it('every other role is decided by minRole alone, unchanged', () => {
    for (const capability of CAPABILITY_REGISTRY) {
      for (const role of ['owner', 'builder', 'operator', 'member'] as const) {
        expect(roleMayUseCapability(role, capability)).toBe(
          roleSatisfiesMinRole(role, capability.minRole),
        );
      }
    }
    expect(roleMayUseCapability('member', undefined)).toBe(true);
  });
});

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
