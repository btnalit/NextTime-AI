import { UnstorableTextError } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  CODE_TITLES,
  CODE_TITLES_ZH,
  ERROR_NEXT_STEPS,
  composerUnstorableTextStep,
  errorToastText,
  gateReasonNextStep,
  presentError,
} from './errors.js';
import { GateHostError } from './gate-host.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { LlmAdminError } from './llm-admin.js';
import { LocalizedError } from './localized-error.js';
import { RpcError } from './ws-client.js';

/** errors.present.test (console audit P1-1): the readable body for an error, never the kernel's
 *  own text, which moves to the technical details with the code. */

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

describe('presentError', () => {
  it('legacy 320: unstorable_text reads as what happened and what to do; the field stays in raw', () => {
    const err = new HttpError(
      'capability_error',
      'capability "create_chat": the text at params "title" holds U+0000 (NUL), which cannot be stored — nothing was written; send it again without that character',
      'unstorable_text',
    );
    const shown = presentError(err, zh);
    expect(shown).toMatchObject({
      code: 'unstorable_text',
      title: '文字里有存不了的字符',
      curated: true,
    });
    expect(shown.message).toContain('什么也没有写入');
    expect(shown.raw).toContain('params "title"');
    expect(presentError(err, en).title).toBe('Text holds a character that cannot be stored');
  });

  // S10 E3-1c: the evaluation seal's refusal reads the same over HTTP and over WS (the composer),
  // and never as "not permitted".
  it('evaluation_content_withheld says what was stopped and what to do, over HTTP and WS alike', () => {
    const message =
      'this message carries content reserved for evaluation, which no agent may read, so it was not sent — nothing was saved';
    for (const err of [
      new HttpError('capability_error', message, 'evaluation_content_withheld'),
      new RpcError(-32018, message),
    ]) {
      const shown = presentError(err, zh);
      expect(shown).toMatchObject({
        code: 'evaluation_content_withheld',
        title: '含评测保留的内容',
        curated: true,
      });
      expect(shown.message).toContain('没有发出');
      expect(shown.message).toContain('去掉那一段再试');
      expect(shown.message).not.toContain('权限');
      expect(shown.raw).toBe(message);
      expect(presentError(err, en).title).toBe('Reserved for evaluation');
      expect(presentError(err, en).message).toContain('Remove that part and try again');
    }
  });

  // UX acceptance of #602 (P2-1): the note names the field the kernel names, says the character
  // cannot be seen, and says how to get rid of it — the same over HTTP and over WS (the composer).
  it('legacy 320: the unstorable_text note names the field and how to remove an invisible character', () => {
    const message = new UnstorableTextError('capability "send_chat_message"', {
      path: ['text'],
      in: 'value',
    }).message;
    for (const err of [
      new HttpError('capability_error', message, 'unstorable_text'),
      new RpcError(-32017, message),
    ]) {
      const shown = presentError(err, zh);
      expect(shown.code).toBe('unstorable_text');
      expect(shown.message).toMatch(/^字段「text」里有看不见的 U\+0000（空字符）/);
      expect(shown.message).toContain('纯文本编辑器');
      expect(shown.message).not.toContain('数据库');
      expect(presentError(err, en).message).toMatch(/^The field "text" holds invisible U\+0000/);
    }
    const key = new UnstorableTextError('capability "x"', {
      path: ['labels', 'a\u0000b'],
      in: 'key',
    });
    expect(
      presentError(new HttpError('capability_error', key.message, 'unstorable_text'), zh).message,
    ).toMatch(/^键名「labels\.a\\u0000b」里有看不见的 U\+0000/);
    const whole = new UnstorableTextError('capability "x"', { path: [], in: 'value' });
    expect(
      presentError(new HttpError('capability_error', whole.message, 'unstorable_text'), zh).message,
    ).toMatch(/^提交的文字里有看不见的 U\+0000/);
  });

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
    // Legacy 232 (UX acceptance of #593): the MCP text an agent gets for a wrong name.
    const unknown = gateReasonNextStep(
      'unknown_operation: request_action: gatekeeper gk-1 has no Operation by the requested name — nothing was requested. Call list_allowed_operations for what this gate runs.',
      zh,
    );
    expect(unknown).toMatchObject({ code: 'unknown_operation', title: '这个门上没有这个动作' });
    expect(unknown?.message).toContain('不需要你处理');
    expect(unknown?.message).not.toMatch(/list_allowed_operations|gk-1/);
    expect(
      gateReasonNextStep('invalid_operation_name: Operation name "" is empty', en),
    ).toMatchObject({ code: 'invalid_operation_name', title: 'Operation name not allowed' });
    // Legacy 320: the MCP text an agent gets for params holding U+0000.
    const unstorable = gateReasonNextStep(
      'unstorable_text: capability "propose_operation": the text at params "operation.name" holds U+0000 (NUL), which cannot be stored — nothing was written; send it again without that character',
      zh,
    );
    expect(unstorable).toMatchObject({
      code: 'unstorable_text',
      title: '文字里有存不了的字符',
      aboutTheSystem: false,
    });
    expect(unstorable?.message).toContain('不需要你处理');
    expect(unstorable?.message).toMatch(/^字段「operation\.name」里/);
    // The same text inside a tool result shown as JSON: its quotes arrive escaped.
    expect(
      gateReasonNextStep(
        JSON.stringify({
          error: 'unstorable_text: capability "x": the text at params "a.b" holds U+0000 (NUL)',
        }),
        zh,
      )?.message,
    ).toMatch(/^字段「a\.b」里/);
    expect(gateReasonNextStep('operation_refused: no', zh)?.aboutTheSystem).toBe(true);
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

  it('an outcome-unknown note names the system to check when it is given (UX acceptance of #586, P3)', () => {
    expect(
      gateReasonNextStep('outcome_unknown: …', zh, 'container.restart（name: media）', 'docker')
        ?.message,
    ).toContain('先到系统「docker」核对 container.restart（name: media）是否已生效');
    expect(gateReasonNextStep('outcome_unknown: …', zh, undefined, 'docker')?.message).toContain(
      '先到系统「docker」核对它是否生效',
    );
    expect(gateReasonNextStep('outcome_unknown: …', en, 'x', 'docker')?.message).toContain(
      'check on the system "docker" whether x took effect',
    );
  });

  it('names the usual cause of a TLS record-layer error (#501 review of #586)', () => {
    const reason =
      'outcome_unknown: … http transport: POST /x failed after the request may have reached the target (ERR_SSL_WRONG_VERSION_NUMBER) — it may have run';
    expect(gateReasonNextStep(reason, zh)?.message).toMatch(
      /再决定要不要重新发起。常见原因：https 地址指到了只讲明文 HTTP 的端口。$/,
    );
    expect(
      gateReasonNextStep('outcome_unknown: … (ERR_SSL_PACKET_LENGTH_TOO_LONG)', en)?.message,
    ).toContain(
      ' A common cause: an https address pointing at a port that only speaks plain HTTP.',
    );
    expect(gateReasonNextStep('outcome_unknown: … (ECONNRESET)', zh)?.message).not.toContain(
      '常见原因',
    );
  });

  it('the gate’s own error code inside another word is not a reason', () => {
    expect(gateReasonNextStep('{"code":"apply_outcome_unknown"}', zh)).toBeNull();
    expect(gateReasonNextStep('outcome unknown: the gate may still complete it', zh)).toBeNull();
  });
});

// Legacy 333 (UX review of #605, P3-1): WS -32016 read as the generic 「出错了」.
describe('legacy 333: worker_definition_not_enabled', () => {
  it('has a Chinese title and says who turns the Worker back on, and where', () => {
    const err = new RpcError(
      -32016,
      'invoke_worker: WorkerDefinition "wd-1" is excluded by the calling principal\'s AgentProfile (excludedWorkerDefinitions)',
    );
    const shown = presentError(err, zh);
    expect(shown).toMatchObject({
      code: 'worker_definition_not_enabled',
      title: '这个 Worker 没有对你的智能体启用',
      curated: true,
    });
    expect(shown.title).not.toBe('出错了');
    expect(shown.message).toContain('「我的智能体」的「Worker 定义」里重新勾选');
    expect(shown.message).not.toContain('excludedWorkerDefinitions');
    expect(shown.raw).toContain('excludedWorkerDefinitions');
    expect(presentError(err, en).title).toBe('Worker not enabled for your agent');
  });
});

// Legacy 334 (UX review of #605, P3-2): the composer names the message, not the param `text`.
describe('legacy 334: unstorable_text in the chat composer', () => {
  it('names the message content and says nothing about an agent’s call', () => {
    const message = new UnstorableTextError('capability "send_chat_message"', {
      path: ['text'],
      in: 'value',
    }).message;
    const shown = presentError(new RpcError(-32017, message), zh, {
      unstorable_text: composerUnstorableTextStep(zh),
    });
    expect(shown.message).toMatch(/^消息内容里有看不见的 U\+0000（空字符）/);
    expect(shown.message).toContain('这条消息没有发出');
    expect(shown.message).not.toContain('「text」');
    expect(shown.message).not.toContain('agent');
    expect(composerUnstorableTextStep(en)).toMatch(/^The message holds invisible U\+0000/);
    expect(composerUnstorableTextStep(en)).not.toContain('agent');
  });
});

// Legacy 336 (review #493, recorded in #605): WS -32014 stands for three HTTP codes.
describe('legacy 336: WS UPSTREAM_ERROR told apart by its message', () => {
  it.each([
    [
      'create_connection: failed to fetch manifestSource https://gate.example/manifest: HTTP 404',
      'manifest_fetch_failed',
      '拉取清单失败',
      '拿不到接口清单',
    ],
    [
      'gatekeeper client: gate/observe timed out after 10000ms',
      'gatekeeper_timeout',
      '门响应超时',
      '没有及时响应',
    ],
    [
      'gate_connection_lost: gatekeeper client: gate/apply: the connection to the gate failed after the request may have been sent (ECONNRESET) — the gate may have received it',
      'gatekeeper_error',
      '门返回了错误',
      '目标系统返回了错误',
    ],
    // A gate's own message that happens to mention a timeout is still the gate's error.
    [
      'upstream_failed: gatekeeper client: gate/observe timed out after 5ms, said the gate',
      'gatekeeper_error',
      '门返回了错误',
      '目标系统返回了错误',
    ],
    ['something else entirely', 'gatekeeper_error', '门返回了错误', '目标系统返回了错误'],
  ])('%j reads as %s', (message, code, title, step) => {
    const shown = presentError(new RpcError(-32014, message), zh);
    expect(shown).toMatchObject({ code, title, curated: true });
    expect(shown.message).toContain(step);
    expect(shown.raw).toBe(message);
  });
});

// Sweep (legacy 333 follow-up): kernel codes that reached the console as 「出错了」 and the
// generic pointer at the technical details.
describe('kernel codes with no console copy before', () => {
  it.each([
    ['endpoint_is_platform_gate', '能力目录启用这个平台门'],
    ['connector_not_self_serve', '在「集成」里开放'],
    ['module_not_found', '模块索引里没有它'],
    ['pack_not_found', '附带的能力包里没有它'],
    ['not_a_draft', '只有草稿才能丢弃'],
    ['invalid_scope', '重新选择范围'],
    ['service_principal_required', '启用中的服务账号'],
    ['worker_definition_not_enabled', '「我的智能体」'],
    ['ontology_violation', '提议本体修订'],
    ['source_identity_conflict', '换一个名称'],
    ['image_not_allowed', '允许列表'],
    ['image_not_in_inventory', '先在主机或 CI 上构建它'],
    ['runtime_unreachable', '「运行状态」'],
    ['no_previous_settings_version', '没有另一个活动镜像可以回滚'],
    ['depth_exceeded', '「派生链深度上限」'],
    ['concurrency_exceeded', '「每用户并发 WorkerRun 数」'],
    ['daily_cost_exceeded', '「每工作区日成本」'],
  ])('%s has a Chinese title and a next step', (code, step) => {
    const err = new HttpError('capability_error', 'kernel text in English', code);
    const shown = presentError(err, zh);
    expect(shown).toMatchObject({ code, curated: true });
    expect(shown.title).toBe(CODE_TITLES_ZH[code]);
    expect(shown.title).not.toBe('出错了');
    expect(shown.message).toContain(step);
    expect(shown.message).not.toContain('kernel text');
    expect(shown.message).not.toContain('技术细节');
    expect(shown.raw).toBe('kernel text in English');
    const english = presentError(err, en);
    expect(english.title).toBe(CODE_TITLES[code]);
    expect(english.message.length).toBeGreaterThan(0);
    expect(english.message).not.toContain('kernel text');
  });
});

// A member-management refusal (`PrincipalOperationRefusedError`) is a 409 `conflict` whose
// `details.reason` says which one; without it, it reads as any other conflict.
describe('member-management refusals', () => {
  it.each([
    ['last_owner', '最后一位有效的所有者', '先把另一位成员设为所有者'],
    ['self_disable', '不能停用自己', '请另一位所有者来停用'],
    ['platform_managed', '由平台管理', '平台自己管理的身份'],
    ['human_api_key', '人类用户用密码登录', '创建一个服务账号'],
    ['reserved_name', '名称被保留', '换一个名字'],
  ])('%s reads as its own refusal, not a generic conflict', (reason, title, step) => {
    const err = new HttpError('capability_error', 'kernel text in English', 'conflict', {
      reason,
    });
    const shown = presentError(err, zh);
    expect(shown).toMatchObject({ code: reason, title, curated: true });
    expect(shown.message).toContain(step);
    expect(shown.message).not.toContain('可能有人刚改过');
    expect(presentError(err, en).title).toBe(CODE_TITLES[reason]);
  });

  it('a conflict without a known reason stays a conflict', () => {
    for (const details of [undefined, { reason: 'something_new' }, { reason: 7 }]) {
      const shown = presentError(new HttpError('capability_error', 'x', 'conflict', details), zh);
      expect(shown).toMatchObject({ code: 'conflict', title: '和现有数据冲突' });
    }
    // A reason on another code is not read.
    expect(
      presentError(
        new HttpError('capability_error', 'x', 'illegal_transition', { reason: 'last_owner' }),
        zh,
      ).code,
    ).toBe('illegal_transition');
  });

  it('the platform plane’s own last_owner keeps its copy, with the shared title', () => {
    const shown = presentError(new HttpError('capability_error', 'x', 'last_owner'), zh);
    expect(shown.message).toBe('不能移出或降级工作区的最后一位有效的所有者');
    expect(shown.title).toBe('最后一位有效的所有者');
  });
});
