import { describe, expect, it } from 'vitest';
import {
  EMPTY_STEP,
  issueMessage,
  opsRunnerTemplateForm,
  parseJsonObject,
  parseMarkdownBlocks,
  procedureContentFromForm,
  procedureStepFromWire,
  skillContentFromForm,
  skillNamePublishWarning,
  splitList,
  validateProcedure,
  validateSkill,
  validateWorkerDefinition,
  workerDefinitionContentFromForm,
  workerDefinitionFormFromWire,
} from './catalog.js';
import type { Translate } from './i18n.js';

/** `parseJsonObject` is a pure helper (not a component) that takes `t` from its caller. */
const zhT: Translate = (zh) => zh;

describe('skill form → propose_skill{skill}', () => {
  it('builds the SKILL content and omits `applicable` when both lists are empty', () => {
    expect(
      skillContentFromForm({
        name: ' restart-web ',
        description: 'Restarts web.',
        markdown: '# Steps\n1. go',
        gateKinds: '',
        objectTypes: '',
      }),
    ).toEqual({ name: 'restart-web', description: 'Restarts web.', markdown: '# Steps\n1. go' });
    expect(
      skillContentFromForm({
        name: 'x',
        description: 'y',
        markdown: 'z',
        gateKinds: 'http, ssh',
        objectTypes: 'Container\nHost',
      }).applicable,
    ).toEqual({ gateKinds: ['http', 'ssh'], objectTypes: ['Container', 'Host'] });
  });

  it('validates against ProposeSkillContentSchema with field-level errors', () => {
    const invalid = validateSkill(
      {
        name: '',
        description: 'd',
        markdown: '',
        gateKinds: '',
        objectTypes: '',
      },
      zhT,
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(Object.keys(invalid.errors).sort()).toEqual(['markdown', 'name']);
      // zod's default English never reaches the field (console audit P1-1 follow-up).
      expect(invalid.errors.name).toBe('必填');
    }
    const valid = validateSkill(
      {
        name: 'a',
        description: 'b',
        markdown: 'c',
        gateKinds: '',
        objectTypes: '',
      },
      zhT,
    );
    expect(valid.ok).toBe(true);
  });

  it('warns about the publish-time pi name rule without blocking the draft', () => {
    expect(skillNamePublishWarning('Restart Web', zhT)).toMatch(/小写字母/);
    expect(skillNamePublishWarning('restart-web', zhT)).toBeUndefined();
    expect(skillNamePublishWarning('', zhT)).toBeUndefined();
  });
});

describe('procedure form → propose_procedure{procedure}', () => {
  it('serializes each step with only its kind’s fields and validates the discriminated union', () => {
    const form = {
      name: 'Deploy',
      description: 'Deploy web',
      steps: [
        {
          ...EMPTY_STEP,
          kind: 'operation' as const,
          gatekeeperId: 'gk-1',
          operationName: 'restart',
        },
        {
          ...EMPTY_STEP,
          kind: 'worker' as const,
          definitionId: 'wd-1',
          version: '2',
          description: 'run',
        },
        { ...EMPTY_STEP, kind: 'approval' as const, description: 'ops signs off' },
        { ...EMPTY_STEP, kind: 'verify' as const, description: 'health ok' },
      ],
    };
    expect(procedureContentFromForm(form)).toEqual({
      name: 'Deploy',
      description: 'Deploy web',
      steps: [
        { kind: 'operation', gatekeeperId: 'gk-1', operationName: 'restart' },
        { kind: 'worker', definitionId: 'wd-1', version: 2, description: 'run' },
        { kind: 'approval', description: 'ops signs off' },
        { kind: 'verify', description: 'health ok' },
      ],
    });
    expect(validateProcedure(form, zhT).ok).toBe(true);
    const invalid = validateProcedure(
      {
        ...form,
        steps: [{ ...EMPTY_STEP, kind: 'approval', description: '' }],
      },
      zhT,
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(Object.keys(invalid.errors)).toEqual(['steps.0.description']);
  });

  it('reads a wire step back into the form leniently', () => {
    expect(procedureStepFromWire({ kind: 'worker', definitionId: 'wd', version: 3 })).toMatchObject(
      {
        kind: 'worker',
        definitionId: 'wd',
        version: '3',
      },
    );
    expect(procedureStepFromWire({ kind: 'bogus' }).kind).toBe('approval');
  });
});

describe('worker definition form → propose_worker_definition{definition}', () => {
  it('always sends `capabilities` for entry, and only non-empty lists for worker', () => {
    expect(
      workerDefinitionContentFromForm({
        kind: 'entry',
        name: '',
        description: '',
        systemPrompt: 'You are the entry agent.',
        model: '',
        capabilities: '',
        gates: 'gk-1',
        skills: 's',
        egressDeny: '',
      }),
    ).toEqual({ systemPrompt: 'You are the entry agent.', capabilities: [] });
    expect(
      workerDefinitionContentFromForm({
        kind: 'worker',
        name: 'Restarter',
        description: '',
        systemPrompt: 'p',
        model: 'provider/model',
        capabilities: 'search\ntraverse',
        gates: 'gk-1',
        skills: '',
        egressDeny: '.internal',
      }),
    ).toEqual({
      systemPrompt: 'p',
      model: 'provider/model',
      name: 'Restarter',
      capabilities: ['search', 'traverse'],
      gates: ['gk-1'],
      egressDeny: ['.internal'],
    });
  });

  it('validates with the kind-specific schema and round-trips a wire definition into the form', () => {
    const form = workerDefinitionFormFromWire('worker', {
      systemPrompt: 'p',
      name: 'n',
      skills: ['a', 'b'],
      capabilities: ['search'],
      bogus: 1,
    });
    expect(form).toMatchObject({ kind: 'worker', systemPrompt: 'p', name: 'n', skills: 'a\nb' });
    expect(validateWorkerDefinition(form, zhT).ok).toBe(true);
    const invalid = validateWorkerDefinition({ ...form, systemPrompt: '' }, zhT);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(Object.keys(invalid.errors)).toEqual(['systemPrompt']);
  });
});

describe('helpers', () => {
  it('splitList / parseJsonObject', () => {
    expect(splitList(' a, b \n\nc ')).toEqual(['a', 'b', 'c']);
    expect(parseJsonObject('{"a":1}', zhT)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('[1]', zhT).ok).toBe(false);
    expect(parseJsonObject('{', zhT).ok).toBe(false);
  });

  it('parseMarkdownBlocks: headings, fenced code, lists, paragraphs', () => {
    const blocks = parseMarkdownBlocks(
      '# Title\n\nFirst line\nsecond line\n\n- a\n- b\n\n1. one\n2) two\n\n```sh\nls -la\n```\n',
    );
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'First line second line' },
      { kind: 'list', ordered: false, items: ['a', 'b'] },
      { kind: 'list', ordered: true, items: ['one', 'two'] },
      { kind: 'code', lang: 'sh', text: 'ls -la' },
    ]);
    expect(parseMarkdownBlocks('```\nunclosed')).toEqual([
      { kind: 'code', lang: '', text: 'unclosed' },
    ]);
  });
});

// S8 W3 K2 (leftover 84): opsRunnerTemplateForm's own capabilities-prefill rule — no hardcoded
// capability list, driven purely by `list_capability_names`' own `mode` field.
describe('opsRunnerTemplateForm (leftover 84 — capabilities prefill)', () => {
  it('preselects every non-execute-mode name plus request_action, in that order', () => {
    const form = opsRunnerTemplateForm([
      { name: 'assert_fact', mode: 'write' },
      { name: 'find_workers', mode: 'observe' },
      { name: 'propose_skill', mode: 'propose' },
      { name: 'request_action', mode: 'execute' },
    ]);
    expect(form.name).toBe('ops-runner');
    expect(form.kind).toBe('worker');
    expect(splitList(form.capabilities)).toEqual([
      'assert_fact',
      'find_workers',
      'propose_skill',
      'request_action',
    ]);
  });

  it('never submits only request_action — an empty directory still yields request_action alone, not an empty list', () => {
    const form = opsRunnerTemplateForm([]);
    expect(splitList(form.capabilities)).toEqual(['request_action']);
  });

  it('does not double-list request_action when the directory already reports it', () => {
    const form = opsRunnerTemplateForm([
      { name: 'get_object', mode: 'observe' },
      { name: 'request_action', mode: 'execute' },
    ]);
    expect(splitList(form.capabilities)).toEqual(['get_object', 'request_action']);
  });

  it('excludes every execute-mode name except request_action', () => {
    const form = opsRunnerTemplateForm([
      { name: 'get_object', mode: 'observe' },
      { name: 'publish_skill', mode: 'execute' },
      { name: 'request_action', mode: 'execute' },
    ]);
    const capabilities = splitList(form.capabilities);
    expect(capabilities).not.toContain('publish_skill');
    expect(capabilities.filter((name) => name === 'request_action')).toHaveLength(1);
  });

  it('audit P1-7: the gates granted to the reader start ticked; none granted leaves none', () => {
    expect(splitList(opsRunnerTemplateForm([], ['g-1', 'g-2']).gates)).toEqual(['g-1', 'g-2']);
    expect(splitList(opsRunnerTemplateForm([]).gates)).toEqual([]);
  });
});

describe('issueMessage', () => {
  it('turns zod default issues into the viewer’s language', () => {
    expect(
      issueMessage(
        {
          path: ['x'],
          message: 'String must contain at most 64 character(s)',
          code: 'too_big',
          type: 'string',
          maximum: 64,
        },
        zhT,
      ),
    ).toBe('最多 64 个字符');
    expect(
      issueMessage(
        { path: ['x'], message: 'Required', code: 'invalid_type', received: 'undefined' },
        zhT,
      ),
    ).toBe('必填');
    expect(
      issueMessage(
        {
          path: ['x'],
          message: 'Invalid enum value',
          code: 'invalid_enum_value',
          options: ['只读', '读写'],
        },
        zhT,
      ),
    ).toBe('只能是：只读、读写');
    expect(
      issueMessage(
        { path: ['x'], message: 'egressDeny entry "1.2.3.4" is an IP address', code: 'custom' },
        zhT,
      ),
    ).toBe('「1.2.3.4」是 IP 地址：这里只填主机名（私有网段已经按地址拦截）');
    expect(
      issueMessage(
        { path: ['x'], message: 'egressDeny entry "a b" is not a host name (…)', code: 'custom' },
        zhT,
      ),
    ).toContain('不是合法的主机名');
    expect(issueMessage({ path: ['x'], message: 'something else', code: 'custom' }, zhT)).toBe(
      '这一项的值不被接受',
    );
  });
});
