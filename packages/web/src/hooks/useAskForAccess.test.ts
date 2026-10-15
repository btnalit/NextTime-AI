import { ROLE_VALUES } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { askForAccess } from './useAskForAccess.js';

const zh = <T>(value: T) => value;

describe('askForAccess (UX acceptance of #541, P2)', () => {
  it('a member is told to ask the owner for the role: an upgrade', () => {
    expect(askForAccess('member', 'operator', 'see', zh)).toBe(
      '要查看，请工作区所有者把你的角色改为操作员。',
    );
    expect(askForAccess('member', 'operator', 'approve', zh)).toBe(
      '要参与审批，请工作区所有者把你的角色改为操作员。',
    );
    expect(askForAccess('member', 'auditor', 'reconstruct', zh)).toBe(
      '要重建，请工作区所有者把你的角色改为审计员。',
    );
  });

  it('no other role is told to switch roles: it would lose the one it has', () => {
    for (const role of [...ROLE_VALUES.filter((r) => r !== 'member'), null]) {
      for (const holder of ['operator', 'auditor'] as const) {
        for (const verb of ['see', 'approve', 'export', 'reconstruct'] as const) {
          const hint = askForAccess(role, holder, verb, zh);
          expect(hint, `${role} / ${holder} / ${verb}`).not.toMatch(/角色改为/);
          expect(hint).toMatch(/工作区所有者/);
        }
      }
    }
    expect(askForAccess('operator', 'auditor', 'see', zh)).toBe(
      '要查看，请审计员或工作区所有者帮你查看。',
    );
    expect(askForAccess('builder', 'operator', 'see', zh)).toBe(
      '要查看，请操作员或工作区所有者帮你查看。',
    );
  });
});
