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

// Legacy 287: a failed `request_action` says whether the call left the platform — not sent (it
// ran nothing, request it again) or outcome unknown (it may have run, check before retrying).
describe('legacy 287: not sent, or outcome unknown', () => {
  it.each([
    [
      'gate_unreachable: gatekeeper client: gate/apply not sent — could not connect to the gate (ECONNREFUSED); nothing reached it',
      'gate_unreachable',
      '没发出：连不上门',
    ],
    [
      'apply_not_received: the gate holds no record of this request having run, so nothing ran. Request it again if it is still wanted.',
      'apply_not_received',
      '没执行：门上没有执行记录',
    ],
    [
      'outcome_unknown: apply for actionRequestId "a1" has an unknown outcome: … (409 apply_outcome_unknown)',
      'outcome_unknown',
      '结果不明',
    ],
  ])('reads the reason %j', (reason, code, title) => {
    const step = gateReasonNextStep(JSON.stringify({ status: 'failed', reason }), zh);
    expect(step).toMatchObject({ code, title });
    expect(gateReasonNextStep(reason, en)?.title).toBe(CODE_TITLES[code]);
  });

  it('tells the two apart: not sent ran nothing, outcome unknown says not to retry blindly', () => {
    expect(ERROR_NEXT_STEPS.gate_unreachable?.zh).toContain('什么都没有执行');
    // Review of #586 (#493 P3): the gate's record is about what ran, not what arrived.
    expect(ERROR_NEXT_STEPS.apply_not_received?.zh).toBe(
      '门上没有这次请求执行过的记录，所以什么都没跑。仍然需要的话，重新发起。',
    );
    for (const code of ['gate_unreachable', 'apply_not_received']) {
      expect(ERROR_NEXT_STEPS[code]?.zh).toContain('重新发起');
    }
    expect(ERROR_NEXT_STEPS.outcome_unknown?.zh).toContain('不要直接重试');
    expect(ERROR_NEXT_STEPS.outcome_unknown?.zh).toContain('目标系统');
  });

  it('not sent is a plain note, outcome unknown the loudest, a gate refusal asks for care (UX acceptance of #586)', () => {
    const tone = (reason: string) => gateReasonNextStep(reason, zh)?.tone;
    expect(tone('gate_unreachable: …')).toBe('info');
    expect(tone('apply_not_received: …')).toBe('info');
    expect(tone('outcome_unknown: …')).toBe('danger');
    expect(tone('operation_refused: …')).toBe('warn');
  });

  it('an outcome-unknown note names what to check when it is given', () => {
    expect(
      gateReasonNextStep('outcome_unknown: …', zh, 'container.restart（name: media）')?.message,
    ).toContain('先到目标系统核对 container.restart（name: media）是否已生效');
    expect(
      gateReasonNextStep('outcome_unknown: …', en, 'container.restart (name: media)')?.message,
    ).toContain('whether container.restart (name: media) took effect');
    // Without one, the general sentence; the target only changes outcome unknown.
    expect(gateReasonNextStep('outcome_unknown: …', zh)?.message).toBe(
      ERROR_NEXT_STEPS.outcome_unknown?.zh,
    );
    expect(gateReasonNextStep('gate_unreachable: …', zh, 'x')?.message).toBe(
      ERROR_NEXT_STEPS.gate_unreachable?.zh,
    );
  });

  it('the gate’s own error code inside another word is not a reason', () => {
    expect(gateReasonNextStep('{"code":"apply_outcome_unknown"}', zh)).toBeNull();
    expect(gateReasonNextStep('outcome unknown: the gate may still complete it', zh)).toBeNull();
  });
});
