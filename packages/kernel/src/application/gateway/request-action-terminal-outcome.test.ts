import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { SHOWN_REASON_MAX } from '../../governance/approval/service.js';
import type { WithTransactionFn } from './action-executor.js';
import { readTerminalOutcome } from './request-action-handler.js';

/**
 * Review of #549 (B4): `request_action` reads a terminal ActionRequest's result back from its
 * audit row. A row written before legacy 187 was fixed holds the gate's output and error text as
 * given and is never rewritten (I11), so the read-back applies the audit copy's rule again.
 */

/** Synthetic: a plain word only the field name gives away, and an alphabet-spelled key. */
const PLAIN = 'hunter2-plain-word';
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

function withRows(action: string, payload: Record<string, unknown>): WithTransactionFn {
  const client = {
    query: async () => ({
      rows: [
        {
          workspace_id: 'ws',
          id: 'audit-1',
          actor_principal_id: 'p',
          action,
          resource_type: 'action_request',
          resource_id: 'ar-1',
          payload,
          created_at: new Date(),
        },
      ],
    }),
  } as unknown as PoolClient;
  return (async (_workspaceId, _principalId, fn) => fn(client)) as WithTransactionFn;
}

describe('readTerminalOutcome (review of #549, B4)', () => {
  it('masks the data of a complete row written before the fix', async () => {
    const outcome = await readTerminalOutcome(
      withRows('action_request.complete', {
        resultingStatus: 'executed',
        resultMetadata: {
          data: { issued: { token: PLAIN }, note: `use PGPASSWORD=${FAKE}`, id: 7 },
        },
      }),
      'ws',
      'p',
      'ar-1',
    );
    expect(outcome.data).toEqual({
      issued: { token: '[redacted]' },
      note: 'use PGPASSWORD=[redacted]',
      id: 7,
    });
  });

  it('masks the reason of a fail row written before the fix', async () => {
    const outcome = await readTerminalOutcome(
      withRows('action_request.fail', {
        resultingStatus: 'failed',
        reason: `mysql: PGPASSWORD=${FAKE} rejected`,
      }),
      'ws',
      'p',
      'ar-1',
    );
    expect(outcome.reason).toBe('mysql: PGPASSWORD=[redacted] rejected');
  });

  it('legacy 338: shows the reason as the console shows a failure reason — clipped, unseen characters made visible', async () => {
    const outcome = await readTerminalOutcome(
      withRows('action_request.fail', {
        resultingStatus: 'failed',
        reason: `gate said no\u202E\r\n${'x'.repeat(2000)}`,
      }),
      'ws',
      'p',
      'ar-1',
    );
    // 15 code points before the x's (the CR among them, dropped after the cut).
    expect(outcome.reason).toBe(`gate said no\\u{202E}\n${'x'.repeat(SHOWN_REASON_MAX - 15)}…`);

    const blank = await readTerminalOutcome(
      withRows('action_request.fail', { resultingStatus: 'failed', reason: '  ' }),
      'ws',
      'p',
      'ar-1',
    );
    expect(blank.reason).toBeUndefined();
  });

  it('returns a row written since as it is', async () => {
    const data = { issued: { token: '[redacted]' }, rows: [1, 2] };
    const outcome = await readTerminalOutcome(
      withRows('action_request.complete', {
        resultingStatus: 'executed',
        resultMetadata: { data },
        resultRedaction: { redactedValues: 1, paths: ['data.issued.token'] },
      }),
      'ws',
      'p',
      'ar-1',
    );
    expect(outcome.data).toEqual(data);
    expect(outcome.reason).toBeUndefined();
  });
});
