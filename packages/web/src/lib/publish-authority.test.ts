import { describe, expect, it } from 'vitest';
import { provenNotDraftReviewer, provenNotProposer } from './publish-authority.js';
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

describe('provenNotDraftReviewer (E2-0b reject_draft mirror)', () => {
  it('withholds a known non-owner who did not propose the version in use', () => {
    expect(provenNotDraftReviewer({ inUse: { proposedBy: 'p-o' } }, builder, 'p-me')).toBe(true);
    expect(provenNotDraftReviewer({ inUse: { proposedBy: 'p-me' } }, builder, 'p-me')).toBe(false);
    expect(provenNotDraftReviewer({ inUse: { proposedBy: 'p-o' } }, owner, 'p-me')).toBe(false);
  });

  it('leaves a family with no version in use to the owner', () => {
    expect(provenNotDraftReviewer({}, builder, 'p-me')).toBe(true);
    expect(provenNotDraftReviewer({}, owner, 'p-me')).toBe(false);
  });

  it('stays permissive while the role, the caller or the in-use proposer is unknown', () => {
    expect(provenNotDraftReviewer({ inUse: { proposedBy: 'p-o' } }, inferred, 'p-me')).toBe(false);
    expect(provenNotDraftReviewer({}, inferred, 'p-me')).toBe(false);
    expect(provenNotDraftReviewer({ inUse: { proposedBy: 'p-o' } }, builder, null)).toBe(false);
    expect(provenNotDraftReviewer({ inUse: {} }, builder, 'p-me')).toBe(false);
  });
});
