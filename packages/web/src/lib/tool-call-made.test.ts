import { describe, expect, it } from 'vitest';
import { madeResourceOf } from './tool-call-made.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSAL = { id: ID, title: 'Disk triage', status: 'proposed', segments: [] };

describe('madeResourceOf: propose_admin_proposal (S11 AA4e)', () => {
  it("reads a live row's pi result: details first, else its text part", () => {
    const text = JSON.stringify(PROPOSAL, null, 2);
    expect(
      madeResourceOf('propose_admin_proposal', {
        content: [{ type: 'text', text }],
        details: PROPOSAL,
      }),
    ).toEqual({ kind: 'admin_proposal', id: ID, title: 'Disk triage' });
    expect(madeResourceOf('propose_admin_proposal', { content: [{ type: 'text', text }] })).toEqual(
      { kind: 'admin_proposal', id: ID, title: 'Disk triage' },
    );
  });

  it("reads a persisted record's text, and a preview cut short by its leading id", () => {
    const text = JSON.stringify(PROPOSAL, null, 2);
    expect(madeResourceOf('propose_admin_proposal', text)).toEqual({
      kind: 'admin_proposal',
      id: ID,
      title: 'Disk triage',
    });
    expect(madeResourceOf('propose_admin_proposal', text.slice(0, 60))).toEqual({
      kind: 'admin_proposal',
      id: ID,
      title: null,
    });
  });

  it("reads the CI fake runtime's proposalId", () => {
    expect(
      madeResourceOf('propose_admin_proposal', {
        proposalId: ID,
        title: 'Fake',
        status: 'proposed',
      }),
    ).toEqual({ kind: 'admin_proposal', id: ID, title: 'Fake' });
    expect(
      madeResourceOf('propose_admin_proposal', JSON.stringify({ proposalId: ID, title: 'Fake' })),
    ).toEqual({ kind: 'admin_proposal', id: ID, title: 'Fake' });
  });

  it('nothing for another tool, an error result or an id not shaped like one', () => {
    expect(madeResourceOf('agent_get_admin_proposal', PROPOSAL)).toBeNull();
    expect(madeResourceOf(null, PROPOSAL)).toBeNull();
    expect(
      madeResourceOf('propose_admin_proposal', { error: 'no proposal targets chosen' }),
    ).toBeNull();
    expect(madeResourceOf('propose_admin_proposal', { id: '../x', title: 't' })).toBeNull();
    expect(madeResourceOf('propose_admin_proposal', 'not json')).toBeNull();
    expect(madeResourceOf('propose_admin_proposal', undefined)).toBeNull();
  });
});

const TASK = { id: ID, workerRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'running' };
const REQUEST = {
  id: ID,
  status: 'requested',
  kind: 'http',
  target: 'https://tickets.example.test',
  requestedBy: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  requestedAt: '2026-11-05T10:00:00.000Z',
  adminAgentSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

describe('madeResourceOf: invoke_worker and request_connection (S11 AA5b)', () => {
  it("reads invoke_worker's Task from a live row, a persisted record and a cut preview", () => {
    const text = JSON.stringify(TASK, null, 2);
    expect(
      madeResourceOf('invoke_worker', { content: [{ type: 'text', text }], details: TASK }),
    ).toEqual({
      kind: 'task',
      id: ID,
    });
    expect(madeResourceOf('invoke_worker', text)).toEqual({ kind: 'task', id: ID });
    expect(madeResourceOf('invoke_worker', text.slice(0, 50))).toEqual({ kind: 'task', id: ID });
  });

  it("reads request_connection's request with its connection kind while the result carries it", () => {
    const text = JSON.stringify(REQUEST, null, 2);
    expect(madeResourceOf('request_connection', { details: REQUEST })).toEqual({
      kind: 'connection_request',
      id: ID,
      connectionKind: 'http',
    });
    expect(madeResourceOf('request_connection', text)).toEqual({
      kind: 'connection_request',
      id: ID,
      connectionKind: 'http',
    });
    expect(madeResourceOf('request_connection', text.slice(0, 50))).toEqual({
      kind: 'connection_request',
      id: ID,
      connectionKind: null,
    });
  });

  it('takes `proposalId` only for an admin proposal, and nothing from a refusal', () => {
    expect(madeResourceOf('invoke_worker', { proposalId: ID })).toBeNull();
    expect(madeResourceOf('request_connection', { proposalId: ID })).toBeNull();
    expect(
      madeResourceOf('request_connection', { error: 'connector_not_self_serve', status: 409 }),
    ).toBeNull();
    expect(madeResourceOf('invoke_worker', { id: 'not-a-task-id' })).toBeNull();
    expect(madeResourceOf('get_task', TASK)).toBeNull();
    expect(madeResourceOf('toString', TASK)).toBeNull();
  });
});
