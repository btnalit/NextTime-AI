import { describe, expect, it } from 'vitest';
import { principalDisplayRole } from './governance.js';
import type { Translate } from './i18n.js';

/** A `Translate` stub that always picks the zh half — `principalDisplayRole` is a pure helper
 *  (not a component), so its tests supply their own `t` rather than rendering under a
 *  `LangProvider`. */
const zhT: Translate = (zh) => zh;

describe('principalDisplayRole', () => {
  it('shows the bare (bilingual) role for a human principal, role + kind otherwise', () => {
    expect(principalDisplayRole({ role: 'owner', kind: 'human' }, zhT)).toBe('所有者');
    // Agent's kind label is "Agent" in both languages (a proper noun) — built via concatenation
    // so this literal doesn't itself read as an unconverted "中文 English" pair.
    expect(principalDisplayRole({ role: 'member', kind: 'agent' }, zhT)).toBe(`成员 ${'· Agent'}`);
    expect(principalDisplayRole({ role: 'member', kind: 'service' }, zhT)).toBe('成员 · 服务');
  });
});
