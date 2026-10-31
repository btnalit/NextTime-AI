import { describe, expect, it } from 'vitest';
import {
  definitionReferenceFieldLabel,
  definitionReferenceFieldText,
  definitionReferenceRefusalOf,
  definitionReferenceText,
  packInstallReferenceText,
} from './definition-reference.js';
import { presentError } from './errors.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/** definition-reference.test (legacy 302): `publish_worker_definition`'s 400
 *  `unresolved_references`, read field by field from the kernel's `details.unresolved`. */

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

const refusalError = (unresolved: unknown) =>
  new HttpError(
    'capability_error',
    'WorkerDefinition wd@2 names what is not there, so it is not published (...)',
    'unresolved_references',
    { unresolved },
  );

describe('definitionReferenceRefusalOf', () => {
  it('reads each field the kernel names, and only strings', () => {
    expect(
      definitionReferenceRefusalOf(
        refusalError({
          capabilities: ['no_such_capability'],
          gates: ['gk-1', 7],
          skills: [],
          model: ['fake/gone'],
          somethingNew: ['ignored'],
        }),
      ),
    ).toEqual({ capabilities: ['no_such_capability'], gates: ['gk-1'], model: ['fake/gone'] });
  });

  it('is null for another code, a missing or empty details, or another error', () => {
    expect(
      definitionReferenceRefusalOf(
        new HttpError('capability_error', 'x', 'invalid_params', { unresolved: { gates: ['g'] } }),
      ),
    ).toBeNull();
    expect(
      definitionReferenceRefusalOf(new HttpError('capability_error', 'x', 'unresolved_references')),
    ).toBeNull();
    expect(definitionReferenceRefusalOf(refusalError({ skills: [] }))).toBeNull();
    expect(definitionReferenceRefusalOf(refusalError(['skills']))).toBeNull();
    expect(definitionReferenceRefusalOf(new Error('unresolved_references'))).toBeNull();
  });
});

describe('the words for a refusal', () => {
  it('each field says what is wrong with its values and what to do, in both languages', () => {
    expect(definitionReferenceFieldText('skills', ['draft-only'], zh)).toBe(
      '「draft-only」没有已发布的版本（不存在、还是草稿，或已弃用），Worker 装不上。取消勾选；要用它，先在 Skill 页让它有一个已发布的版本。',
    );
    expect(definitionReferenceFieldText('gates', ['gk-1', 'gk-2'], en)).toContain('“gk-1”, “gk-2”');
    expect(definitionReferenceFieldText('model', ['fake/gone'], zh)).toContain('不在模型目录里');
    expect(definitionReferenceFieldText('capabilities', ['x'], en)).toContain('Worker ceiling');
    expect(definitionReferenceFieldLabel('gates', zh)).toBe('可作用的门');
    // UX acceptance of #848 P3-3: more than one value reads as more than one.
    expect(definitionReferenceFieldText('skills', ['a', 'b'], en)).toBe(
      '“a”, “b” have no published version (they do not exist, are still drafts, or were deprecated), so a Worker cannot mount them. Uncheck them; to use them, first give each a published version on the Skills tab.',
    );
    expect(definitionReferenceFieldText('skills', ['a'], en)).toContain('has no published version');
    expect(definitionReferenceFieldText('capabilities', ['a', 'b'], en)).toContain(
      'are not capabilities a Worker can hold',
    );
    expect(definitionReferenceFieldText('gates', ['g1', 'g2'], zh)).toContain(
      '这个工作区没有「g1」、「g2」这些门，Worker 拿它们作用不到任何系统。',
    );
  });

  it('the one-paragraph form names every field, in the order the editor shows them', () => {
    const text = definitionReferenceText(
      { skills: ['s'], model: ['m'], gates: ['g'], capabilities: ['c'] },
      zh,
    );
    expect(text.startsWith('这份 Worker 定义引用了不存在的东西，所以没有发布。')).toBe(true);
    const order = ['模型：', '能力：', '可作用的门：', '使用的 Skill：'].map((label) =>
      text.indexOf(label),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('presentError reads the refusal as its fields, never the kernel text', () => {
    const shown = presentError(refusalError({ skills: ['draft-only'] }), zh);
    expect(shown).toMatchObject({
      code: 'unresolved_references',
      title: '引用了不存在的东西',
      curated: true,
    });
    expect(shown.message).toContain('「draft-only」没有已发布的版本');
    expect(shown.message).not.toContain('WorkerDefinition wd@2');
    expect(presentError(refusalError({ model: ['m'] }), en).title).toBe('Names what is not there');

    // No details (an older kernel): the code's own next step, still curated.
    const bare = presentError(
      new HttpError('capability_error', 'kernel words', 'unresolved_references'),
      zh,
    );
    expect(bare.curated).toBe(true);
    expect(bare.message).toContain('没有发布');
  });
});

describe('packInstallReferenceText', () => {
  it('says nothing was installed and, per field, what to fix in the workspace — never to propose a version', () => {
    const text = packInstallReferenceText(
      { gates: ['gk-gone'], skills: ['crew-fix'], model: ['m'], capabilities: ['c'] },
      zh,
    );
    expect(
      text.startsWith(
        '这个能力包要发布的 Worker 引用了工作区里现在没有的东西，所以整次安装都没有写入。',
      ),
    ).toBe(true);
    expect(text).toContain('可作用的门：这个工作区没有「gk-gone」这个门，Worker 沿用了它。');
    expect(text).toContain('使用的 Skill：「crew-fix」没有已发布的版本');
    expect(text).toContain('模型：「m」不在模型目录里，Worker 沿用了它。');
    expect(text).toContain('这是能力包本身的问题');
    expect(text).not.toContain('改一版再发布');
    expect(packInstallReferenceText({ skills: ['crew-fix'] }, en)).toContain(
      'nothing of the install was written',
    );
  });
});
