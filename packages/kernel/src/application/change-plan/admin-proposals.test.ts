import { type AdminProposalWire, AgentAdminProposalWireSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { agentProposalOf } from './admin-proposals.js';

// #933 review R-1: what the agent reads of a platform `gate_instance` item is built field by field.
// Production does not validate results, so a field the intent gains later must not reach the agent
// until `agentProposalOf` names it.

function proposalWith(items: AdminProposalWire['segments'][number]['items']): AdminProposalWire {
  return {
    proposalId: '00000000-0000-4000-8000-000000000001',
    trialWorkspaceId: '00000000-0000-4000-8000-000000000002',
    proposedBy: { userId: '00000000-0000-4000-8000-000000000003', login: 'admin' },
    title: 'Add the docs instance',
    description: null,
    sourceName: 'docs-tools',
    contentDigest: 'a'.repeat(64),
    status: 'proposed',
    createdAt: '2026-11-02T00:00:00.000Z',
    segments: [
      {
        segmentId: '00000000-0000-4000-8000-000000000004',
        authority: 'platform',
        targetWorkspaceId: null,
        position: 0,
        items,
        status: 'proposed',
        decidedAt: null,
        withdrawnReason: null,
      },
    ],
  } as unknown as AdminProposalWire;
}

describe('agentProposalOf (#933 review R-1)', () => {
  it('reads a gate_instance item back with the fields it names, marked addressWithheld, and nothing else', () => {
    const item = {
      kind: 'gate_instance',
      gateId: 'docs',
      displayName: 'Docs',
      transportKind: 'http',
      target: 'https://docs.internal.example/api',
      credentialMode: 'shared',
      manifestSource: 'https://docs.internal.example/openapi.json',
      connector: 'docs',
      // A field the intent might gain later: never named, so never read back.
      caTarget: 'https://ca.internal.example/root.pem',
    };
    const read = agentProposalOf(proposalWith([item] as never));
    expect(read.segments[0]?.items).toEqual([
      {
        kind: 'gate_instance',
        gateId: 'docs',
        displayName: 'Docs',
        transportKind: 'http',
        credentialMode: 'shared',
        connector: 'docs',
        addressWithheld: true,
      },
    ]);
    expect(JSON.stringify(read)).not.toContain('internal.example');
  });

  it('leaves out the optional fields an item does not carry; the result is the agent wire', () => {
    const item = {
      kind: 'gate_instance',
      gateId: 'kb',
      preset: 'ragflow',
      target: 'https://kb.example',
    };
    const read = agentProposalOf(proposalWith([item] as never));
    expect(read.segments[0]?.items).toEqual([
      { kind: 'gate_instance', gateId: 'kb', preset: 'ragflow', addressWithheld: true },
    ]);
    expect(
      AgentAdminProposalWireSchema.shape.segments.element.shape.items.safeParse(
        read.segments[0]?.items,
      ).success,
    ).toBe(true);
  });
});
