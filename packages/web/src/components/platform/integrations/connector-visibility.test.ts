import { describe, expect, it } from 'vitest';
import type { Translate } from '../../../lib/i18n.js';
import { hiddenInstanceExplanation } from './connector-visibility.js';

const zh: Translate = (text) => text;
const en: Translate = (_text, english) => english;

describe('hiddenInstanceExplanation (S11 AA5b)', () => {
  it('a generic connector: presetting it ends self-connection, except in a trial workspace', () => {
    const http = { name: 'http', packaged: false };
    expect(hiddenInstanceExplanation(http, 'self_serve', zh)).toContain(
      '之后工作区不能再自己接入这一类系统（试验工作区里的平台管理员除外）',
    );
    expect(hiddenInstanceExplanation(http, 'disabled', en)).toContain(
      'a platform administrator in a trial workspace still can',
    );
  });

  it("a system's own connector governs no self-connection, so no exception is named", () => {
    const widgets = { name: 'widgets', packaged: false };
    expect(hiddenInstanceExplanation(widgets, 'self_serve', zh)).not.toContain('试验工作区');
  });
});
