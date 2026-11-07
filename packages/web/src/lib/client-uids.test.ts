import { describe, expect, it } from 'vitest';
import { newProcedureBinding, nextStepKey } from './catalog.js';
import { createUidCounter, reserveClientUidsIn } from './client-uids.js';

/** client-uids.test.ts: legacy 662 — a restored draft's row keys are never handed out again. */
describe('lib/client-uids', () => {
  it('counts 1, 2, 3 per counter', () => {
    const counter = createUidCounter();
    expect([counter.next(), counter.next(), counter.next()]).toEqual([1, 2, 3]);
  });

  it('after a restore, every counter starts past the highest key the value carries', () => {
    reserveClientUidsIn({
      steps: [{ key: 'step-41', bindings: [{ uid: 'binding-7' }] }, { key: 'step-3' }],
      text: 'not-a-key 99',
    });
    const step = Number(nextStepKey().slice('step-'.length));
    const binding = Number(newProcedureBinding().uid.slice('binding-'.length));
    expect(step).toBeGreaterThan(41);
    expect(binding).toBeGreaterThan(41);
  });

  it('never moves a counter back', () => {
    const counter = createUidCounter();
    reserveClientUidsIn(['field-10']);
    expect(counter.next()).toBe(11);
    reserveClientUidsIn(['field-2']);
    expect(counter.next()).toBe(12);
  });
});
