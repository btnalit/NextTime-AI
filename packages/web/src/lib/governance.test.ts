import { describe, expect, it } from 'vitest';
import { healthView, principalDisplayRole } from './governance.js';
import type { Translate } from './i18n.js';

/** A `Translate` stub that always picks the zh half — `principalDisplayRole` is a pure helper
 *  (not a component), so its tests supply their own `t` rather than rendering under a
 *  `LangProvider`. */
const zhT: Translate = (zh) => zh;

describe('healthView', () => {
  it('reads a bare boolean', () => {
    expect(healthView(true)).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthView(false)).toEqual({ tone: 'danger', label: 'Unhealthy' });
  });

  it('reads {ok: boolean}', () => {
    expect(healthView({ ok: true })).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthView({ ok: false })).toEqual({ tone: 'danger', label: 'Unhealthy' });
  });

  it('reads {status: string} by keyword, case-insensitively', () => {
    expect(healthView({ status: 'Healthy' })).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthView({ status: 'unhealthy' })).toEqual({ tone: 'danger', label: 'unhealthy' });
    expect(healthView({ status: 'degraded' })).toEqual({ tone: 'neutral', label: 'degraded' });
  });

  it('falls back to neutral "Unknown" for anything unrecognized — never throws', () => {
    expect(healthView(undefined)).toEqual({ tone: 'neutral', label: 'Unknown' });
    expect(healthView(null)).toEqual({ tone: 'neutral', label: 'Unknown' });
    expect(healthView({ foo: 'bar' })).toEqual({ tone: 'neutral', label: 'Unknown' });
    expect(healthView('healthy')).toEqual({ tone: 'neutral', label: 'Unknown' });
  });
});

describe('principalDisplayRole', () => {
  it('shows the bare (bilingual) role for a human principal, role + kind otherwise', () => {
    expect(principalDisplayRole({ role: 'owner', kind: 'human' }, zhT)).toBe('所有者');
    // Agent's kind label is "Agent" in both languages (a proper noun) — built via concatenation
    // so this literal doesn't itself read as an unconverted "中文 English" pair.
    expect(principalDisplayRole({ role: 'member', kind: 'agent' }, zhT)).toBe(`成员 ${'· Agent'}`);
    expect(principalDisplayRole({ role: 'member', kind: 'service' }, zhT)).toBe('成员 · 服务');
  });
});
