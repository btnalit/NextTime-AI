import { describe, expect, it } from 'vitest';
import {
  FRESHNESS_LEGEND,
  OBSERVATION_WINDOW_MS,
  formatWindow,
  freshnessOf,
} from './graph-freshness.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

describe('freshnessOf', () => {
  it('is fresh (ok) when observed inside the window', () => {
    const f = freshnessOf({ lastObservedAt: iso(-10 * 60 * 1000) }, NOW);
    expect(f.kind).toBe('fresh');
    expect(f.tone).toBe('ok');
    expect(f.ageMs).toBe(10 * 60 * 1000);
  });

  it('is fresh exactly at the window edge, aging (warn) one millisecond past it', () => {
    expect(freshnessOf({ lastObservedAt: iso(-OBSERVATION_WINDOW_MS) }, NOW).kind).toBe('fresh');
    const aging = freshnessOf({ lastObservedAt: iso(-OBSERVATION_WINDOW_MS - 1) }, NOW);
    expect(aging.kind).toBe('aging');
    expect(aging.tone).toBe('warn');
  });

  it('is unobserved (neutral, never warn) without an observation clock — an asserted Fact', () => {
    const f = freshnessOf({ lastObservedAt: null, epistemicStatus: 'asserted' }, NOW);
    expect(f.kind).toBe('unobserved');
    expect(f.tone).toBe('neutral');
    expect(f.ageMs).toBeNull();
  });

  it('maps not_reobserved / invalidated / superseded to grey, in precedence order', () => {
    const notReobserved = freshnessOf(
      {
        lastObservedAt: iso(-3 * HOUR),
        invalidatedAt: iso(-HOUR),
        invalidationReason: 'not_reobserved',
      },
      NOW,
    );
    expect(notReobserved.kind).toBe('not_reobserved');
    expect(notReobserved.tone).toBe('neutral');

    const invalidated = freshnessOf(
      { lastObservedAt: iso(-1000), invalidatedAt: iso(-HOUR), invalidationReason: 'manual' },
      NOW,
    );
    expect(invalidated.kind).toBe('invalidated');

    // Superseded outranks invalidated, and both outrank a fresh observation clock.
    const superseded = freshnessOf(
      { lastObservedAt: iso(-1000), supersededAt: iso(-HOUR), invalidatedAt: iso(-HOUR) },
      NOW,
    );
    expect(superseded.kind).toBe('superseded');
    expect(superseded.tone).toBe('neutral');
  });

  it('is conflict (danger) for an open-Conflict side or a contradicted Fact, above everything', () => {
    expect(freshnessOf({ lastObservedAt: iso(-1000), inConflict: true }, NOW).tone).toBe('danger');
    const contradicted = freshnessOf(
      { lastObservedAt: null, supersededAt: iso(-HOUR), epistemicStatus: 'contradicted' },
      NOW,
    );
    expect(contradicted.kind).toBe('conflict');
  });

  it('ignores a lifecycle end after asOf (time travel: the Fact was still active then)', () => {
    const asOf = NOW - 5 * HOUR;
    const f = freshnessOf(
      { lastObservedAt: iso(-5 * HOUR - 1000), supersededAt: iso(-HOUR) },
      asOf,
    );
    expect(f.kind).toBe('fresh');
  });

  it('never reports a negative age for an observation after asOf', () => {
    expect(freshnessOf({ lastObservedAt: iso(+HOUR) }, NOW).ageMs).toBe(0);
  });

  it('treats an unparseable timestamp as no clock', () => {
    expect(freshnessOf({ lastObservedAt: 'not-a-date' }, NOW).kind).toBe('unobserved');
  });

  it('uses only the four semantic tones freshness is allowed (ok / warn / neutral / danger)', () => {
    const tones = new Set(FRESHNESS_LEGEND.map((row) => row.tone));
    expect([...tones].sort()).toEqual(['danger', 'neutral', 'ok', 'warn']);
    // Every kind the mapper can produce is in the legend with the same tone.
    for (const row of FRESHNESS_LEGEND) {
      // S8 W1-A10: bilingual as a {zh, en} pair now, not a combined "中文 English" string.
      expect(row.label.zh.length).toBeGreaterThan(0);
      expect(row.label.en.length).toBeGreaterThan(0);
    }
  });
});

describe('formatWindow', () => {
  it('prints whole hours, else minutes', () => {
    expect(formatWindow(2 * HOUR)).toBe('2 小时 2 h');
    expect(formatWindow(90 * 60 * 1000)).toBe('90 分钟 90 min');
  });
});
