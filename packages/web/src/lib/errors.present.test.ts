import { describe, expect, it } from 'vitest';
import {
  CODE_TITLES,
  CODE_TITLES_ZH,
  ERROR_NEXT_STEPS,
  errorToastText,
  gateReasonNextStep,
  presentError,
} from './errors.js';
import { GateHostError } from './gate-host.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { LlmAdminError } from './llm-admin.js';
import { LocalizedError } from './localized-error.js';

/** errors.present.test (console audit P1-1): the readable body for an error, never the kernel's
 *  own text, which moves to the technical details with the code. */

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

describe('presentError', () => {
  it('a known code reads as its next step in the viewer’s language; the kernel text is kept raw', () => {
    const err = new HttpError(
      'capability_error',
      'list_models: "/data/models/models.json" does not match the schema',
      'service_unavailable',
    );
    const shown = presentError(err, zh);
    expect(shown).toMatchObject({
      code: 'service_unavailable',
      title: '服务暂时不可用',
      curated: true,
    });
    expect(shown.message).toContain('稍后重试');
    expect(shown.message).not.toContain('models.json');
    expect(shown.raw).toContain('models.json');
    expect(presentError(err, en).message).toContain('Retry later');
  });

  it('a platform code keeps its own copy; a page override wins over both', () => {
    const err = new HttpError(
      'capability_error',
      'password must be 8–256 characters',
      'weak_password',
    );
    expect(presentError(err, zh).message).toBe('密码不满足平台的最短长度要求');
    expect(presentError(err, zh, { weak_password: '密码至少 8 位' }).message).toBe('密码至少 8 位');
    expect(presentError(err, zh).raw).toBe('password must be 8–256 characters');
  });

  it('a forbidden refusal says who can act, not the capability name', () => {
    const err = new HttpError(
      'capability_error',
      'get_agent_profile: member 只能看自己',
      'forbidden',
    );
    const shown = presentError(err, zh);
    expect(shown.message).toContain('工作区所有者或平台管理员');
    expect(shown.message).not.toContain('get_agent_profile');
    expect(shown.raw).toContain('get_agent_profile');
  });

  it('an unknown code points at the technical details and the toast falls back to the raw text', () => {
    const err = new HttpError('capability_error', 'something specific', 'brand_new_code');
    const shown = presentError(err, zh);
    expect(shown.curated).toBe(false);
    expect(shown.message).toContain('技术细节');
    expect(shown.raw).toBe('something specific');
    expect(errorToastText(err, zh)).toBe('something specific (brand_new_code)');
    expect(errorToastText(new HttpError('capability_error', 'x', 'forbidden'), zh)).toContain(
      '(forbidden)',
    );
  });

  it('the gate-side codes have copy ready before the kernel relays them', () => {
    expect(
      presentError(new HttpError('capability_error', 'x', 'operation_refused'), zh).message,
    ).toContain('去掉这个参数后重新导入');
    expect(
      presentError(new HttpError('capability_error', 'x', 'connection_target_refused'), zh).message,
    ).toContain('最终地址');
  });

  it('a model proxy admin error uses its own code and copy', () => {
    const err = new LlmAdminError(409, 'provider_exists', 'provider "x" already exists');
    const shown = presentError(err, zh);
    expect(shown.code).toBe('provider_exists');
    expect(shown.message).toBe('已存在同名供应商。');
    expect(shown.raw).toBe('provider "x" already exists');
  });

  it('every next step and every title exists in both languages and for every titled code', () => {
    for (const [code, step] of Object.entries(ERROR_NEXT_STEPS)) {
      expect(step.zh.length, code).toBeGreaterThan(0);
      expect(step.en.length, code).toBeGreaterThan(0);
      expect(
        CODE_TITLES_ZH[code] ?? (code === 'invalid_request' ? 'x' : undefined),
        code,
      ).toBeTruthy();
    }
    expect(Object.keys(CODE_TITLES).sort()).toEqual(Object.keys(CODE_TITLES_ZH).sort());
  });

  it('a sentence the console wrote itself stays the body, never folded away (review R1)', () => {
    const shown = presentError(new LocalizedError('请填写理由。'), zh);
    expect(shown).toMatchObject({
      code: 'invalid_input',
      title: '请检查输入',
      message: '请填写理由。',
      raw: null,
      curated: true,
    });
  });

  it('a gate host refusal keeps its sentence as the body and the browser text in the fold', () => {
    const shown = presentError(
      new GateHostError('无法连接门宿主：检查网络。', 'Failed to fetch'),
      zh,
    );
    expect(shown).toMatchObject({
      code: 'gate_host_error',
      message: '无法连接门宿主：检查网络。',
      raw: 'Failed to fetch',
      curated: true,
    });
  });

  it('page overrides still win over a console-written sentence for the same code', () => {
    const shown = presentError(new LocalizedError('x'), zh, { invalid_input: 'y' });
    expect(shown.message).toBe('y');
  });
});

describe('legacy K / J codes (review of #538, G3)', () => {
  it.each(['operation_definition_mismatch', 'gate_owned_params'])(
    '%s reads as its next step, with a title in both languages',
    (code) => {
      const err = new HttpError('capability_error', 'kernel text in English', code);
      const shown = presentError(err, zh);
      expect(shown).toMatchObject({ code, curated: true });
      expect(shown.title).toBe(CODE_TITLES_ZH[code]);
      expect(shown.message).not.toContain('kernel text');
      expect(shown.raw).toBe('kernel text in English');
      expect(presentError(err, en).title).toBe(CODE_TITLES[code]);
    },
  );

  it('the mismatch says how to get calls through again: align, publish the revision, request again', () => {
    const step = ERROR_NEXT_STEPS.operation_definition_mismatch;
    expect(step?.zh).toContain('与门公告对齐');
    expect(step?.zh).toContain('修订草稿');
  });

  it('reads a failure reason’s gate code out of a tool result, and nothing out of one without', () => {
    expect(
      gateReasonNextStep('{"status":"failed","reason":"operation_definition_unavailable: …"}', zh),
    ).toMatchObject({ code: 'operation_definition_unavailable', title: '没有批准过的定义' });
    expect(gateReasonNextStep('operation_definition_mismatch: operation "x": …', en)?.title).toBe(
      'The gate runs another definition',
    );
    expect(gateReasonNextStep('{"status":"executed"}', zh)).toBeNull();
    expect(gateReasonNextStep('my_operation_definition_mismatch_field', zh)).toBeNull();
  });
});
