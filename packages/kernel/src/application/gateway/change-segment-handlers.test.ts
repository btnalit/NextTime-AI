import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './authorize.js';
import { rollBackChangeSegmentHandler } from './change-segment-handlers.js';

/**
 * application/gateway/change-segment-handlers.test: pure unit tests (no database) for who may
 * confirm an authority-widening rollback item (I-A4, review of #663): a person only. A *service*
 * Principal's API key also authenticates on the human channel, and is refused before anything is
 * read. The DB-backed flow is `change-segments-flow.integration.test.ts`.
 */

const WS = '00000000-0000-4000-8000-00000000000a';
const CALLER = '00000000-0000-4000-8000-00000000000b';
const SEGMENT = '00000000-0000-4000-8000-00000000000c';

/** Fails the test the moment anything queries it — proves a refusal came before any read. */
const untouchableClient = {
  query: () => {
    throw new Error('the client must not be touched');
  },
} as unknown as PoolClient;

describe('roll_back_change_segment: confirming a widening item is a person’s', () => {
  it('refuses confirmedOrdinals from a service Principal on the human channel', async () => {
    await expect(
      rollBackChangeSegmentHandler(
        untouchableClient,
        WS,
        { segmentId: SEGMENT, confirmedOrdinals: [1] },
        {
          channel: 'human',
          principalId: CALLER,
          principal: { id: CALLER, kind: 'service', role: 'owner', displayName: 'ci-bot' },
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses confirmedOrdinals when no Principal was resolved', async () => {
    await expect(
      rollBackChangeSegmentHandler(
        untouchableClient,
        WS,
        { segmentId: SEGMENT, confirmedOrdinals: [1] },
        { channel: 'human', principalId: CALLER },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a service owner through when it confirms nothing (the domain refuses a widening item)', async () => {
    await expect(
      rollBackChangeSegmentHandler(
        untouchableClient,
        WS,
        { segmentId: SEGMENT },
        {
          channel: 'human',
          principalId: CALLER,
          principal: { id: CALLER, kind: 'service', role: 'owner', displayName: 'ci-bot' },
        },
      ),
    ).rejects.toThrow('the client must not be touched');
  });
});
