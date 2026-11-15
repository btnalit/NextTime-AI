import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { callingTurnId } from './calling-turn.js';
import type { CapabilityHandlerContext } from './capability-handler.js';

/** A client that answers `sessions` reads with `kind` and records every query it is sent. */
function recordingClient(kind: string | undefined) {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes('from sessions')) return { rows: kind === undefined ? [] : [{ kind }] };
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as PoolClient;
  return { client, queries };
}

const workspaceId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const sid = '00000000-0000-4000-8000-000000000003';

function handleCtx(handleSessionKind?: string | null): CapabilityHandlerContext {
  return {
    channel: 'handle',
    principalId,
    claims: {
      ws: workspaceId,
      sid,
      obo: principalId,
      scope: { capabilities: ['propose_goal'], resources: {} },
      jti: '00000000-0000-4000-8000-000000000004',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    ...(handleSessionKind !== undefined ? { handleSessionKind } : {}),
  };
}

describe('callingTurnId (legacy 443, 759)', () => {
  it('takes the session kind dispatch read and reads no session itself', async () => {
    for (const kind of ['mcp_session', 'worker_run', null] as const) {
      // The table says entry; the call's own kind, read by dispatch, decides.
      const { client, queries } = recordingClient('entry');
      expect(
        await callingTurnId(client, workspaceId, principalId, handleCtx(kind)),
      ).toBeUndefined();
      expect(queries).toEqual([]);
    }
  });

  it('reads the session itself when the context does not carry its kind', async () => {
    for (const kind of ['mcp_session', undefined] as const) {
      const { client, queries } = recordingClient(kind);
      expect(await callingTurnId(client, workspaceId, principalId, handleCtx())).toBeUndefined();
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('from sessions');
    }
  });

  it('comes from no Turn on the human channel, and reads nothing', async () => {
    const { client, queries } = recordingClient('entry');
    expect(
      await callingTurnId(client, workspaceId, principalId, { channel: 'human', principalId }),
    ).toBeUndefined();
    expect(queries).toEqual([]);
  });
});
