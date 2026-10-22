import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './authorize.js';
import { installPackHandler } from './pack-handlers.js';

/**
 * application/gateway/pack-handlers.test: pure unit tests (no database) for who may confirm an
 * authority-widening install item (I-A4): a person only — the same rule as
 * `roll_back_change_segment`. A *service* Principal's API key also authenticates on the human
 * channel, and is refused before anything is read. The DB-backed flow is
 * `pack-flow.integration.test.ts`.
 */

const WS = '00000000-0000-4000-8000-00000000000a';
const CALLER = '00000000-0000-4000-8000-00000000000b';
const INPUT = { name: 'ops-assets', version: 2, reviewedDigest: 'sha256:reviewed' };

/** Fails the test the moment anything queries it — proves a refusal came before any read. */
const untouchableClient = {
  query: () => {
    throw new Error('the client must not be touched');
  },
} as unknown as PoolClient;

const service = {
  channel: 'human' as const,
  principalId: CALLER,
  principal: {
    id: CALLER,
    kind: 'service' as const,
    role: 'owner' as const,
    displayName: 'ci-bot',
  },
};

describe('install_pack: confirming a widening item is a person’s', () => {
  it('refuses confirmedOrdinals from a service Principal on the human channel', async () => {
    await expect(
      installPackHandler(untouchableClient, WS, { ...INPUT, confirmedOrdinals: [1] }, service),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses confirmedOrdinals when no Principal was resolved', async () => {
    await expect(
      installPackHandler(
        untouchableClient,
        WS,
        { ...INPUT, confirmedOrdinals: [1] },
        { channel: 'human', principalId: CALLER },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a service owner through when it confirms nothing (the domain refuses a widening item)', async () => {
    await expect(installPackHandler(untouchableClient, WS, INPUT, service)).rejects.toThrow(
      'the client must not be touched',
    );
  });
});
