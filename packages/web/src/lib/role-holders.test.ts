import { CAPABILITY_REGISTRY, type CapabilityName, roleMayUseCapability } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import { capabilityHolders, holderRoles } from './role-holders.js';

/** lib/role-holders: "who can do this" read from the registry (#541 review, legacy 243 ③). */
const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

describe('capabilityHolders', () => {
  it('names the roles the kernel lets through, in the console role labels', () => {
    expect(capabilityHolders('approve', zh, 'or')).toBe('操作员或工作区所有者');
    expect(capabilityHolders('approve', en, 'or')).toBe('an operator or the workspace owner');
    expect(capabilityHolders('list_action_requests', zh)).toMatch(/^.+和工作区所有者$/);
  });

  it('agrees with roleMayUseCapability for every workspace capability', () => {
    for (const capability of CAPABILITY_REGISTRY.filter((entry) => entry.scope !== 'platform')) {
      const roles = holderRoles(capability.name as CapabilityName);
      for (const role of roles) expect(roleMayUseCapability(role, capability)).toBe(true);
      expect(roles).not.toContain('owner');
    }
  });

  it('falls back to the owner alone when no other role holds it', () => {
    const ownerOnly = CAPABILITY_REGISTRY.find(
      (entry) =>
        entry.scope !== 'platform' && holderRoles(entry.name as CapabilityName).length === 0,
    );
    expect(ownerOnly).toBeDefined();
    expect(capabilityHolders(ownerOnly?.name as CapabilityName, zh)).toBe('工作区所有者');
  });
});
