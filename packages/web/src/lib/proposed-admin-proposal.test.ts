import { describe, expect, it } from 'vitest';
import { proposedAdminProposalOf } from './proposed-admin-proposal.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSAL = { id: ID, title: 'Disk triage', status: 'proposed', segments: [] };

describe('proposedAdminProposalOf (S11 AA4e)', () => {
  it("reads a live row's pi result: details first, else its text part", () => {
    const text = JSON.stringify(PROPOSAL, null, 2);
    expect(
      proposedAdminProposalOf('propose_admin_proposal', {
        content: [{ type: 'text', text }],
        details: PROPOSAL,
      }),
    ).toEqual({ id: ID, title: 'Disk triage' });
    expect(
      proposedAdminProposalOf('propose_admin_proposal', { content: [{ type: 'text', text }] }),
    ).toEqual({ id: ID, title: 'Disk triage' });
  });

  it("reads a persisted record's text, and a preview cut short by its leading id", () => {
    const text = JSON.stringify(PROPOSAL, null, 2);
    expect(proposedAdminProposalOf('propose_admin_proposal', text)).toEqual({
      id: ID,
      title: 'Disk triage',
    });
    expect(proposedAdminProposalOf('propose_admin_proposal', text.slice(0, 60))).toEqual({
      id: ID,
      title: null,
    });
  });

  it("reads the CI fake runtime's proposalId", () => {
    expect(
      proposedAdminProposalOf('propose_admin_proposal', {
        proposalId: ID,
        title: 'Fake',
        status: 'proposed',
      }),
    ).toEqual({ id: ID, title: 'Fake' });
    expect(
      proposedAdminProposalOf(
        'propose_admin_proposal',
        JSON.stringify({ proposalId: ID, title: 'Fake' }),
      ),
    ).toEqual({ id: ID, title: 'Fake' });
  });

  it('nothing for another tool, an error result or an id not shaped like one', () => {
    expect(proposedAdminProposalOf('agent_get_admin_proposal', PROPOSAL)).toBeNull();
    expect(proposedAdminProposalOf(null, PROPOSAL)).toBeNull();
    expect(
      proposedAdminProposalOf('propose_admin_proposal', { error: 'no proposal targets chosen' }),
    ).toBeNull();
    expect(
      proposedAdminProposalOf('propose_admin_proposal', { id: '../x', title: 't' }),
    ).toBeNull();
    expect(proposedAdminProposalOf('propose_admin_proposal', 'not json')).toBeNull();
    expect(proposedAdminProposalOf('propose_admin_proposal', undefined)).toBeNull();
  });
});
