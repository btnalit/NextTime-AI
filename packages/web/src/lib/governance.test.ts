import { describe, expect, it } from 'vitest';
import { healthView, principalDisplayRole } from './governance.js';
import type { Translate } from './i18n.js';

/** A `Translate` stub that always picks the zh half — `principalDisplayRole` is a pure helper
 *  (not a component), so its tests supply their own `t` rather than rendering under a
 *  `LangProvider`. */
const zhT: Translate = (zh) => zh;

describe('healthView', () => {
  it('reads a bare boolean', () => {
    expect(healthView(true, zhT)).toEqual({ tone: 'ok', label: '健康' });
    expect(healthView(false, zhT)).toEqual({ tone: 'danger', label: '不健康' });
  });

  it('reads {ok: boolean}', () => {
    expect(healthView({ ok: true }, zhT)).toEqual({ tone: 'ok', label: '健康' });
    expect(healthView({ ok: false }, zhT)).toEqual({ tone: 'danger', label: '不健康' });
  });

  it('reads {status: string} by keyword, case-insensitively — the kernel-provided string is shown verbatim, not translated', () => {
    expect(healthView({ status: 'Healthy' }, zhT)).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthView({ status: 'unhealthy' }, zhT)).toEqual({
      tone: 'danger',
      label: 'unhealthy',
    });
    expect(healthView({ status: 'degraded' }, zhT)).toEqual({ tone: 'neutral', label: 'degraded' });
  });

  it('falls back to neutral "Unknown" for anything unrecognized — never throws', () => {
    expect(healthView(undefined, zhT)).toEqual({ tone: 'neutral', label: '未知' });
    expect(healthView(null, zhT)).toEqual({ tone: 'neutral', label: '未知' });
    expect(healthView({ foo: 'bar' }, zhT)).toEqual({ tone: 'neutral', label: '未知' });
    expect(healthView('healthy', zhT)).toEqual({ tone: 'neutral', label: '未知' });
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
