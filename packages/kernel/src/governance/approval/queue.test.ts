import type { ActionRequestStatus } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { type QueueEntry, planGatekeeperQueue } from './queue.js';

/**
 * governance/approval/queue.test (S11 GO12, I-Q1): what may run next on one Gatekeeper and what
 * holds back each approved row — table-driven, each case saying who holds whom and through what.
 */

type Short = 'ok' | 'pending' | 'executing';
const STATUS: Record<Short, ActionRequestStatus> = {
  ok: 'approved',
  pending: 'pending_approval',
  executing: 'executing',
};

/** `[id, status, instance]`: an instance is a Container's id; `null` acts on the whole gate. */
function queue(...rows: [string, Short, string | null][]): QueueEntry[] {
  return rows.map(([id, status, instance]) => ({
    id,
    status: STATUS[status],
    target: instance === null ? null : { type: 'Container', params: ['id'], identity: [instance] },
  }));
}

function plan(rows: QueueEntry[]) {
  const { next, holds } = planGatekeeperQueue(rows);
  return {
    next: next?.id ?? null,
    holds: Object.fromEntries(
      [...holds].map(([id, hold]) => [id, `${hold.root.id}/${hold.root.status}/${hold.scope}`]),
    ),
  };
}

describe('planGatekeeperQueue (S11 GO12, I-Q1)', () => {
  it('rows that declare no target run as before: one at a time, in order, stopping at a pending row', () => {
    expect(plan(queue(['a', 'ok', null], ['b', 'ok', null]))).toEqual({ next: 'a', holds: {} });
    expect(plan(queue(['p', 'pending', null], ['a', 'ok', null], ['b', 'ok', null]))).toEqual({
      next: null,
      holds: { a: 'p/pending_approval/gate', b: 'p/pending_approval/gate' },
    });
    expect(plan(queue(['x', 'executing', null], ['a', 'ok', null]))).toEqual({
      next: null,
      holds: { a: 'x/executing/gate' },
    });
    // An approved row ahead of a pending one runs; the rows behind the pending one wait for it.
    expect(plan(queue(['a', 'ok', null], ['p', 'pending', null], ['b', 'ok', null]))).toEqual({
      next: 'a',
      holds: { b: 'p/pending_approval/gate' },
    });
  });

  it('the same gate and the same target stay serial', () => {
    expect(plan(queue(['p', 'pending', 'web'], ['a', 'ok', 'web']))).toEqual({
      next: null,
      holds: { a: 'p/pending_approval/target' },
    });
    expect(plan(queue(['x', 'executing', 'web'], ['a', 'ok', 'web']))).toEqual({
      next: null,
      holds: { a: 'x/executing/target' },
    });
    // Two approved rows on one target: the earlier first, the later waits its turn (no hold).
    expect(plan(queue(['a', 'ok', 'web'], ['b', 'ok', 'web']))).toEqual({ next: 'a', holds: {} });
    // A row held back holds back the rows on its target behind it, through it.
    expect(plan(queue(['p', 'pending', 'web'], ['a', 'ok', 'web'], ['b', 'ok', 'web']))).toEqual({
      next: null,
      holds: { a: 'p/pending_approval/target', b: 'p/pending_approval/target' },
    });
  });

  it('the same gate and another target do not hold each other back', () => {
    expect(plan(queue(['p', 'pending', 'web'], ['a', 'ok', 'db']))).toEqual({
      next: 'a',
      holds: {},
    });
    // Outcome unknown on one target holds back that target only.
    expect(plan(queue(['x', 'executing', 'web'], ['a', 'ok', 'web'], ['b', 'ok', 'db']))).toEqual({
      next: 'b',
      holds: { a: 'x/executing/target' },
    });
    // Each target's own first row: the earliest is next.
    expect(plan(queue(['a', 'ok', 'web'], ['b', 'ok', 'db']))).toEqual({ next: 'a', holds: {} });
  });

  it('a request on the whole gate conflicts with every target', () => {
    // Pending on the whole gate holds back every target behind it.
    expect(plan(queue(['p', 'pending', null], ['a', 'ok', 'web'], ['b', 'ok', 'db']))).toEqual({
      next: null,
      holds: { a: 'p/pending_approval/gate', b: 'p/pending_approval/gate' },
    });
    // A whole-gate row waits for every earlier row, whatever its target.
    expect(plan(queue(['p', 'pending', 'web'], ['g', 'ok', null]))).toEqual({
      next: null,
      holds: { g: 'p/pending_approval/gate' },
    });
    // And nothing passes it: a row on another target behind it waits too, held by the same root.
    expect(plan(queue(['p', 'pending', 'web'], ['g', 'ok', null], ['b', 'ok', 'db']))).toEqual({
      next: null,
      holds: { g: 'p/pending_approval/gate', b: 'p/pending_approval/gate' },
    });
    // A row on another target ahead of the whole-gate row still runs.
    expect(plan(queue(['p', 'pending', 'web'], ['b', 'ok', 'db'], ['g', 'ok', null]))).toEqual({
      next: 'b',
      holds: { g: 'p/pending_approval/gate' },
    });
    // An approved whole-gate row with nothing ahead runs first; rows behind it wait their turn.
    expect(plan(queue(['g', 'ok', null], ['a', 'ok', 'web']))).toEqual({ next: 'g', holds: {} });
  });

  it('the hold shown is the earliest one: an approved row ahead does not hide a pending row', () => {
    // a runs first, but after it b still waits for p.
    expect(plan(queue(['a', 'ok', 'web'], ['p', 'pending', 'web'], ['b', 'ok', 'web']))).toEqual({
      next: 'a',
      holds: { b: 'p/pending_approval/target' },
    });
  });

  it('instances of other types, or named by other params, are told apart only when certain', () => {
    const rows: QueueEntry[] = [
      {
        id: 'p',
        status: 'pending_approval',
        target: { type: 'Container', params: ['id'], identity: ['web'] },
      },
      {
        id: 'v',
        status: 'approved',
        target: { type: 'Volume', params: ['id'], identity: ['web'] },
      },
      {
        id: 'n',
        status: 'approved',
        target: { type: 'Container', params: ['name'], identity: ['db'] },
      },
    ];
    // Another type: not held. Same type named by another param: may be the same container, held.
    expect(plan(rows)).toEqual({ next: 'v', holds: { n: 'p/pending_approval/target' } });
  });

  it('legacy 565: a conflicting row that started first holds back an approved row ordered before it', () => {
    // a committed after x (stamped later) had started: a waits for x, though x is behind it.
    expect(plan(queue(['a', 'ok', 'web'], ['x', 'executing', 'web']))).toEqual({
      next: null,
      holds: { a: 'x/executing/target' },
    });
    // And so does every row behind a that conflicts with it.
    expect(plan(queue(['a', 'ok', 'web'], ['x', 'executing', 'web'], ['b', 'ok', 'web']))).toEqual({
      next: null,
      holds: { a: 'x/executing/target', b: 'x/executing/target' },
    });
    // A whole-gate row started behind holds every target; one on another target holds nothing.
    expect(plan(queue(['a', 'ok', 'web'], ['x', 'executing', null]))).toEqual({
      next: null,
      holds: { a: 'x/executing/gate' },
    });
    expect(plan(queue(['a', 'ok', 'web'], ['x', 'executing', 'db']))).toEqual({
      next: 'a',
      holds: {},
    });
    // A pending row behind holds nothing back: it cannot start before a.
    expect(plan(queue(['a', 'ok', 'web'], ['p', 'pending', 'web']))).toEqual({
      next: 'a',
      holds: {},
    });
  });

  it('rows in other statuses are not in the queue and hold nothing back', () => {
    const rows: QueueEntry[] = [
      { id: 'w', status: 'withdrawn', target: null },
      { id: 'e', status: 'executed', target: null },
      { id: 'a', status: 'auto_approved', target: null },
    ];
    expect(plan(rows)).toEqual({ next: 'a', holds: {} });
  });
});
