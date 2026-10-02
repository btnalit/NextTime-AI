import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type HumanCaller,
  _resetSessionKicksForTests,
  publishSessionKick,
  sessionKickVerdict,
  subscribeToSessionKicks,
} from './session-revocation.js';

/**
 * session-revocation.test: the pure half of R-05 — which kick reaches which socket, and with
 * which verdict — plus the bus itself. The per-call recheck's SQL is exercised end to end by
 * interfaces/ws/server.test.ts (DB-gated).
 */

function apiKeyCaller(principalId: string): HumanCaller {
  return {
    channel: 'human',
    principal: {
      workspaceId: 'ws-1',
      id: principalId,
      kind: 'human',
      role: 'member',
      displayName: null,
    },
    session: {
      workspaceId: 'ws-1',
      id: 'web-session',
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

function cookieCaller(principalId: string, userId: string, consoleSessionId: string): HumanCaller {
  return {
    ...apiKeyCaller(principalId),
    user: {
      id: userId,
      login: 'bob',
      displayName: 'Bob',
      platformRole: 'user',
      mustChangePassword: false,
      consoleSessionId,
    },
  };
}

afterEach(() => {
  _resetSessionKicksForTests();
});

describe('sessionKickVerdict', () => {
  it('logout reaches only the sockets of that console session', () => {
    const caller = cookieCaller('p-1', 'u-1', 'cs-1');
    expect(sessionKickVerdict(caller, { consoleSessionId: 'cs-1' })).toBe('session_invalid');
    expect(sessionKickVerdict(caller, { consoleSessionId: 'cs-2' })).toBeUndefined();
    expect(sessionKickVerdict(apiKeyCaller('p-1'), { consoleSessionId: 'cs-1' })).toBeUndefined();
  });

  it('a user-wide kick (reset, user disabled) reaches every console socket of the user, never an API-key socket by user alone', () => {
    expect(sessionKickVerdict(cookieCaller('p-1', 'u-1', 'cs-1'), { userId: 'u-1' })).toBe(
      'session_invalid',
    );
    expect(sessionKickVerdict(cookieCaller('p-2', 'u-1', 'cs-9'), { userId: 'u-1' })).toBe(
      'session_invalid',
    );
    expect(
      sessionKickVerdict(cookieCaller('p-1', 'u-2', 'cs-1'), { userId: 'u-1' }),
    ).toBeUndefined();
    expect(sessionKickVerdict(apiKeyCaller('p-1'), { userId: 'u-1' })).toBeUndefined();
  });

  it('a principal kick: an API-key socket loses its session, a cookie socket only its membership', () => {
    expect(sessionKickVerdict(apiKeyCaller('p-1'), { principalIds: ['p-1'] })).toBe(
      'session_invalid',
    );
    expect(sessionKickVerdict(cookieCaller('p-1', 'u-1', 'cs-1'), { principalIds: ['p-1'] })).toBe(
      'membership_gone',
    );
    expect(sessionKickVerdict(apiKeyCaller('p-2'), { principalIds: ['p-1'] })).toBeUndefined();
  });

  it('user disabled ({userId, principalIds}): the cookie socket is session_invalid, not membership_gone', () => {
    const kick = { userId: 'u-1', principalIds: ['p-1'] };
    expect(sessionKickVerdict(cookieCaller('p-1', 'u-1', 'cs-1'), kick)).toBe('session_invalid');
    expect(sessionKickVerdict(apiKeyCaller('p-1'), kick)).toBe('session_invalid');
  });
});

describe('session kick bus', () => {
  it('delivers to every subscriber until it unsubscribes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToSessionKicks(first);
    subscribeToSessionKicks(second);

    publishSessionKick({ userId: 'u-1' });
    expect(first).toHaveBeenCalledWith({ userId: 'u-1' });
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    publishSessionKick({ userId: 'u-2' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('a throwing listener neither stops the others nor reaches the publisher', () => {
    const after = vi.fn();
    subscribeToSessionKicks(() => {
      throw new Error('socket already gone');
    });
    subscribeToSessionKicks(after);

    expect(() => publishSessionKick({ principalIds: ['p-1'] })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('a listener may unsubscribe itself while being delivered to', () => {
    const later = vi.fn();
    const unsubscribe = subscribeToSessionKicks(() => unsubscribe());
    subscribeToSessionKicks(later);

    publishSessionKick({ userId: 'u-1' });
    publishSessionKick({ userId: 'u-1' });
    expect(later).toHaveBeenCalledTimes(2);
  });
});
