import { describe, expect, it } from 'vitest';
import { RefusalAuditLimiter, actingContextForHandle, refusedParamKeys } from './call-refusals.js';

/** application/gateway/call-refusals (batch D3): the hourly audit limit and the param names a
 *  refused call is recorded with (unit, no DB; the audit rows themselves are in
 *  `call-refusal-audit.integration.test.ts`). */

describe('RefusalAuditLimiter (unit)', () => {
  function limiter(options: { maxWindows?: number } = {}) {
    let now = 0;
    const closed: Array<{ key: string; heldBack: number; written: number }> = [];
    const instance = new RefusalAuditLimiter({
      limit: 3,
      windowMs: 1000,
      now: () => now,
      onWindowClosed: (key, window) =>
        closed.push({ key, heldBack: window.heldBack, written: window.written }),
      ...options,
    });
    return {
      instance,
      closed,
      at(ms: number) {
        now = ms;
      },
    };
  }

  it('admits the first `limit` refusals of a key in a window, holds back the rest, and says once when the limit is reached', () => {
    const { instance } = limiter();
    const results = Array.from({ length: 5 }, () => instance.admit('a'));
    expect(results.map((result) => result.admit)).toEqual([true, true, true, false, false]);
    expect(results[3]).toEqual({ admit: false, limitReached: true, until: 1000 });
    expect(results[4]).toEqual({ admit: false, limitReached: false, until: 1000 });
    // Another key (another session, capability or reason) has its own window.
    expect(instance.admit('b').admit).toBe(true);
  });

  it('starts a new window after the hour and reports how many the old one held back', () => {
    const { instance, closed, at } = limiter();
    for (let i = 0; i < 5; i += 1) instance.admit('a');
    at(999);
    expect(instance.admit('a').admit).toBe(false);
    at(1000);
    expect(instance.admit('a').admit).toBe(true);
    expect(closed).toEqual([{ key: 'a', heldBack: 3, written: 3 }]);
    // A window that held nothing back closes silently.
    at(2000);
    instance.admit('a');
    expect(closed).toHaveLength(1);
  });

  it('keeps at most `maxWindows`: expired windows go first, then the oldest, each reporting what it held back', () => {
    const { instance, closed, at } = limiter({ maxWindows: 2 });
    for (let i = 0; i < 4; i += 1) instance.admit('old');
    at(10);
    instance.admit('mid');
    at(20);
    // Full: nothing expired yet, so the oldest window ('old') goes.
    instance.admit('new');
    expect(closed).toEqual([{ key: 'old', heldBack: 1, written: 3 }]);
    // 'old' starts afresh.
    expect(instance.admit('old').admit).toBe(true);
  });
});

describe('refusedParamKeys (unit)', () => {
  it('records names only, sorted, only names that read as one, and how many were left out', () => {
    expect(
      refusedParamKeys({
        objectId: 'sk-not-recorded',
        a: 1,
        'not a name!': 2,
        ['x'.repeat(65)]: 3,
      }),
    ).toEqual({ paramKeys: ['a', 'objectId'], paramKeysOmitted: 2 });
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    const recorded = refusedParamKeys(many);
    expect(recorded.paramKeys).toHaveLength(32);
    expect(recorded.paramKeysOmitted).toBe(8);
  });

  it('records nothing of a non-object', () => {
    for (const raw of [undefined, null, 'text', 42, ['a']]) {
      expect(refusedParamKeys(raw)).toEqual({ paramKeys: [] });
    }
  });
});

describe('actingContextForHandle (unit)', () => {
  it('maps each kind a Handle is issued under, with its session, and no other', () => {
    expect(actingContextForHandle('admin_agent', 's')).toEqual({
      actingThrough: 'admin_agent_session',
      actingSessionId: 's',
    });
    expect(actingContextForHandle('entry', 's')?.actingThrough).toBe('entry_agent');
    expect(actingContextForHandle('worker_run', 's')?.actingThrough).toBe('worker_handle');
    expect(actingContextForHandle('service', 's')?.actingThrough).toBe('service_handle');
    expect(actingContextForHandle('mcp_session', 's')?.actingThrough).toBe('member_handle');
    expect(actingContextForHandle('web', 's')).toBeUndefined();
    expect(actingContextForHandle(undefined, 's')).toBeUndefined();
  });
});
