import { describe, expect, it } from 'vitest';
import { absentAnswersText, principalDisplayRole } from './governance.js';
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

describe('absentAnswersText (S11 gate-confirmed absence, part A)', () => {
  const enT: Translate = (_zh, en) => en;

  it('says which http statuses or exit statuses mean the thing is not there', () => {
    expect(absentAnswersText({ statuses: [404] }, zhT)).toBe(
      '目标回答 404 时，表示要查的东西不存在：这次观察记为“不存在”，不算调用失败。',
    );
    expect(absentAnswersText({ statuses: [404, 410] }, zhT)).toContain('目标回答 404 或 410 时');
    expect(absentAnswersText({ exitCodes: [1, 4] }, zhT)).toContain('命令以退出码 1 或 4 结束时');
    expect(absentAnswersText({ exitCodes: [2] }, enT)).toBe(
      'When the command exits with 2, the thing looked up does not exist: the observation is recorded as “not there”, not as a failed call.',
    );
  });
});
