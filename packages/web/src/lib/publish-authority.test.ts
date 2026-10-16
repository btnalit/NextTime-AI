import { describe, expect, it } from 'vitest';
import { provenNotProposer } from './publish-authority.js';
import type { WorkspaceRole } from './role.js';

const builder: WorkspaceRole = { kind: 'known', role: 'builder' };
const owner: WorkspaceRole = { kind: 'known', role: 'owner' };
const inferred: WorkspaceRole = { kind: 'inferred', role: 'operator+' };

describe('provenNotProposer (D-24 mirror)', () => {
  it('withholds only a known non-owner on a row someone else proposed', () => {
    expect(provenNotProposer({ proposedBy: 'p-o' }, builder, 'p-me')).toBe(true);
    expect(provenNotProposer({ proposedBy: 'p-me' }, builder, 'p-me')).toBe(false);
    expect(provenNotProposer({ proposedBy: 'p-o' }, owner, 'p-me')).toBe(false);
  });

  it('stays permissive while the role, the caller or the proposer is unknown', () => {
    expect(provenNotProposer({ proposedBy: 'p-o' }, inferred, 'p-me')).toBe(false);
    expect(provenNotProposer({ proposedBy: 'p-o' }, builder, null)).toBe(false);
    expect(provenNotProposer({}, builder, 'p-me')).toBe(false);
    expect(provenNotProposer({ proposedBy: null }, builder, 'p-me')).toBe(false);
  });
});
