import { describe, expect, it } from 'vitest';
import {
  actionOutcomeChip,
  actionOutcomeOfToolResult,
  actionTargetLabel,
  failureKindOf,
  failureReading,
  waitingReason,
  waitingShortLabel,
} from './action-outcome.js';
import type { Translate } from './i18n.js';

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

/** The outcome object as the Worker's tool writes it (`JSON.stringify(result, null, 2)`). */
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

describe('actionOutcomeOfToolResult (legacy 287)', () => {
  it.each([
    [{ id: 'a1', status: 'executed', data: {} }, 'done'],
    [
      { id: 'a1', status: 'failed', reason: 'outcome_unknown: apply for … unknown outcome' },
      'outcome_unknown',
    ],
    [{ id: 'a1', status: 'failed', reason: 'gate_unreachable: … not sent' }, 'not_run'],
    [
      { id: 'a1', status: 'failed', reason: 'apply_not_received: the gate holds no record' },
      'not_run',
    ],
    // A result from before `failureKind` reads as the 0021 backfill reads old rows (review of
    // #601, M1): refused or not run only when its code says nothing ran, else outcome unknown.
    [{ id: 'a1', status: 'failed', reason: 'operation_disabled: …' }, 'failed'],
    [{ id: 'a1', status: 'failed', reason: 'gatekeeper "g1" is not registered' }, 'failed'],
    // A reason that only mentions a code later on is not that reason.
    [{ id: 'a1', status: 'failed', reason: 'operation_refused: not outcome_unknown:' }, 'failed'],
    [{ id: 'a1', status: 'failed', reason: 'transport_error: … responded 500' }, 'outcome_unknown'],
    [{ id: 'a1', status: 'failed', reason: 'network_error: … socket hang up' }, 'outcome_unknown'],
    [
      { id: 'a1', status: 'failed', reason: 'outcome unknown: … may still complete it' },
      'outcome_unknown',
    ],
    [{ id: 'a1', status: 'failed', reason: 'gatekeeper client: timed out' }, 'outcome_unknown'],
    [{ id: 'a1', status: 'failed' }, 'outcome_unknown'],
    [{ id: 'a1', status: 'executing' }, 'running'],
    [
      {
        id: 'a1',
        status: 'executing',
        outcomeInDoubt: { since: '2026-10-16T00:00:00Z', reason: 'x' },
      },
      'in_doubt',
    ],
    [{ id: 'a1', status: 'auto_approved' }, 'queued'],
    [{ id: 'a1', status: 'pending_approval' }, 'pending_approval'],
    [{ id: 'a1', status: 'withdrawn' }, 'withdrawn'],
    // S11 GO1: the row's own failure kind decides, whatever the reason text says — a code the
    // reason prefix never covered (`gate_token_unavailable`) now reads as "did not run" too.
    [
      {
        id: 'a1',
        status: 'failed',
        failureKind: 'not_delivered',
        reason: 'gate_token_unavailable: …',
      },
      'not_run',
    ],
    [
      { id: 'a1', status: 'failed', failureKind: 'refused', reason: 'operation_disabled: …' },
      'failed',
    ],
    [
      { id: 'a1', status: 'failed', failureKind: 'outcome_unknown', reason: 'apply_failed: …' },
      'outcome_unknown',
    ],
    // An unknown kind (a newer kernel) falls back to the reason prefix.
    [
      { id: 'a1', status: 'failed', failureKind: 'something_new', reason: 'outcome_unknown: …' },
      'outcome_unknown',
    ],
  ])('reads %j as %s', (result, kind) => {
    expect(actionOutcomeOfToolResult(pretty(result))?.kind).toBe(kind);
  });

  it('reads it inside pi’s {content, details} wrapper, from details or the content text', () => {
    const outcome = { id: 'a1', status: 'failed', reason: 'outcome_unknown: …' };
    expect(actionOutcomeOfToolResult(JSON.stringify({ content: [], details: outcome }))?.kind).toBe(
      'outcome_unknown',
    );
    expect(
      actionOutcomeOfToolResult(
        JSON.stringify({ content: [{ type: 'text', text: pretty(outcome) }] }),
      )?.kind,
    ).toBe('outcome_unknown');
  });

  it('carries the request id through', () => {
    expect(actionOutcomeOfToolResult(pretty({ id: 'a7', status: 'executed' }))?.id).toBe('a7');
  });

  it('carries the waiting fields through', () => {
    const outcome = actionOutcomeOfToolResult(
      pretty({
        id: 'a1',
        status: 'approved',
        queuedBehind: { status: 'executing', outcomeInDoubt: true },
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'queued',
      queuedBehind: { status: 'executing', outcomeInDoubt: true },
    });
  });

  it('reads a preview cut short by its own top-level fields only', () => {
    const full = pretty({
      id: 'a1',
      status: 'failed',
      reason: `outcome_unknown: ${'x'.repeat(400)}`,
    });
    expect(actionOutcomeOfToolResult(full.slice(0, 120))).toMatchObject({
      kind: 'outcome_unknown',
      id: 'a1',
    });
    const executing = pretty({
      id: 'a1',
      status: 'executing',
      outcomeInDoubt: { since: '2026-10-16T00:00:00Z', reason: 'y'.repeat(400) },
    });
    expect(actionOutcomeOfToolResult(executing.slice(0, 100))?.kind).toBe('in_doubt');
    // S11 GO1: the kernel writes `id`, `status`, `failureKind` before the reason, so a cut preview
    // still has the kind.
    const kinded = pretty({
      id: 'a1',
      status: 'failed',
      failureKind: 'not_delivered',
      reason: `gate_token_unavailable: ${'z'.repeat(400)}`,
    });
    expect(actionOutcomeOfToolResult(kinded.slice(0, 120))?.kind).toBe('not_run');
    // Without a kind, the reason's start decides — refused only when its whole code is shown.
    const refused = pretty({
      id: 'a1',
      status: 'failed',
      reason: `gatekeeper "g1" is not registered`,
    });
    expect(actionOutcomeOfToolResult(`${refused.slice(0, -3)}…`)?.kind).toBe('outcome_unknown');
    expect(
      actionOutcomeOfToolResult(
        pretty({
          id: 'a1',
          status: 'failed',
          reason: `operation_disabled: ${'w'.repeat(400)}`,
        }).slice(0, 120),
      )?.kind,
    ).toBe('failed');
    const cutInCode = pretty({ id: 'a1', status: 'failed', reason: 'operation_disabled: …' });
    expect(
      actionOutcomeOfToolResult(cutInCode.slice(0, cutInCode.indexOf('_disabled')))?.kind,
    ).toBe('outcome_unknown');
  });

  it('is null for a result that is not an action outcome', () => {
    // An observe call's data, even one with a `status` of its own.
    expect(actionOutcomeOfToolResult(pretty({ data: { status: 'failed' } }))).toBeNull();
    expect(actionOutcomeOfToolResult(pretty({ status: 'failed' }))).toBeNull();
    // A pending approval's simulated effect, cut short — its `status` is the container's.
    expect(
      actionOutcomeOfToolResult(`${pretty({ status: 'running', name: 'media' })}\n\npending appr`),
    ).toBeNull();
    expect(actionOutcomeOfToolResult('{"id":"a1","status":"some_new_state"}')).toBeNull();
    expect(actionOutcomeOfToolResult('plain text')).toBeNull();
  });
});

describe('actionOutcomeChip', () => {
  it('says what the notice says', () => {
    const chip = (kind: Parameters<typeof actionOutcomeChip>[0]['kind']) =>
      actionOutcomeChip({ kind, status: 'failed' }, zh);
    expect(chip('outcome_unknown')).toEqual({ className: 'chip-danger', label: '结果不明' });
    expect(chip('not_run')).toEqual({ className: 'chip-neutral', label: '没执行' });
    // UX acceptance of #586 (P3): red only for the final state a person has to check.
    expect(chip('in_doubt')).toEqual({ className: 'chip-warn', label: '结果不明·查询中' });
    expect(chip('done').label).toBe('完成');
    expect(actionOutcomeChip({ kind: 'not_run', status: 'failed' }, en).label).toBe('did not run');
    expect(actionOutcomeChip({ kind: 'withdrawn', status: 'withdrawn' }, zh)).toEqual({
      className: 'chip-neutral',
      label: '已撤回',
    });
  });
});

describe('failureKindOf / failureReading (S11 GO1)', () => {
  it('accepts exactly the three kinds', () => {
    expect(failureKindOf('not_delivered')).toBe('not_delivered');
    expect(failureKindOf('refused')).toBe('refused');
    expect(failureKindOf('outcome_unknown')).toBe('outcome_unknown');
    expect(failureKindOf('failed')).toBeUndefined();
    expect(failureKindOf(null)).toBeUndefined();
    expect(failureKindOf(undefined)).toBeUndefined();
  });

  it('reads each kind of a failed row: only "outcome unknown" is danger', () => {
    const read = (failureKind: string) => failureReading({ status: 'failed', failureKind }, zh);
    expect(read('not_delivered')).toMatchObject({
      kind: 'not_delivered',
      tone: 'info',
      short: '没发出，什么都没执行',
    });
    expect(read('not_delivered')?.message).toContain('目标系统没有任何变化');
    expect(read('refused')).toMatchObject({
      kind: 'refused',
      tone: 'info',
      short: '被拒绝或执行失败',
    });
    expect(read('refused')?.message).toContain('原样重试会得到同样的结果');
    expect(read('outcome_unknown')).toMatchObject({
      kind: 'outcome_unknown',
      tone: 'danger',
      short: '结果不明，需要核对',
    });
    expect(read('outcome_unknown')?.message).toContain('不要直接重试：先到目标系统核对它是否生效');
    expect(
      failureReading({ status: 'failed', failureKind: 'outcome_unknown' }, en, {
        system: 'docker-prod',
        action: 'docker container restart (media)',
      })?.message,
    ).toContain(
      'Do not just retry: check on docker-prod whether docker container restart (media) took effect',
    );
    expect(failureReading({ status: 'compensated', failureKind: 'refused' }, en)?.short).toBe(
      'Refused or failed',
    );
  });

  it('says nothing for a row that is not failed, or one without a known kind', () => {
    expect(failureReading({ status: 'executed', failureKind: null }, zh)).toBeNull();
    // The kind on another status (never written by the kernel) is not read.
    expect(failureReading({ status: 'executing', failureKind: 'outcome_unknown' }, zh)).toBeNull();
    expect(failureReading({ status: 'failed' }, zh)).toBeNull();
    expect(failureReading({ status: 'failed', failureKind: 'something_new' }, zh)).toBeNull();
  });

  it('legacy 328: a withdrawn request says nothing ran and nothing is needed', () => {
    const read = failureReading({ status: 'withdrawn', failureKind: null }, zh);
    expect(read?.kind).toBe('withdrawn');
    expect(read?.tone).toBe('info');
    expect(read?.short).toMatch(/什么都没执行/);
    expect(read?.message).toMatch(/步骤被取消/);
    expect(read?.message).toMatch(/不需要处理/);
    // Legacy 341: a row that does not say how far it got names neither case.
    expect(read?.message).not.toMatch(/批准|等审批/);
  });

  it('legacy 341: a withdrawn request names only the case that happened', () => {
    const approved = failureReading(
      { status: 'withdrawn', approvalDecisionId: 'dec-1', policyDecision: 'require_approval' },
      zh,
    );
    expect(approved?.message).toMatch(/已经批准过，但不会再执行/);
    expect(approved?.message).not.toMatch(/等审批/);
    const auto = failureReading({ status: 'withdrawn', policyDecision: 'allow' }, zh);
    expect(auto?.message).toMatch(/已经批准过/);
    const waiting = failureReading(
      { status: 'withdrawn', approvalDecisionId: null, policyDecision: 'require_approval' },
      zh,
    );
    expect(waiting?.message).toMatch(/还在等审批，现在不用再决定了/);
    expect(waiting?.message).not.toMatch(/批准过/);
  });
});

describe('waitingReason / waitingShortLabel', () => {
  const since = '2026-10-16T00:00:00Z';

  it('an executing row in doubt: warn, says the platform asks the gate and never re-runs', () => {
    const row = { status: 'executing', outcomeInDoubt: { since, reason: null } };
    const reason = waitingReason(row, zh);
    expect(reason?.tone).toBe('warn');
    expect(reason?.title).toBe('动作结果不明，平台正在向门查询');
    expect(reason?.message).toContain('从不重新执行');
    expect(reason?.message).toContain('排在它后面的请求都会等它');
    expect(waitingShortLabel(row, zh)?.tone).toBe('warn');
  });

  it('names the usual cause when the doubt came from a TLS record-layer error', () => {
    const reason = (text: string) =>
      waitingReason({ status: 'executing', outcomeInDoubt: { since, reason: text } }, zh)?.message;
    expect(
      reason('gate_connection_lost: … may have been sent (ERR_SSL_WRONG_VERSION_NUMBER) — …'),
    ).toContain('常见原因：https 地址指到了只讲明文 HTTP 的端口');
    expect(reason('gate_connection_lost: … (ECONNRESET) — …')).not.toContain('常见原因');
  });

  it('an approved row says what holds it back, without naming that request', () => {
    const behind = (status: 'pending_approval' | 'executing', outcomeInDoubt: boolean) =>
      waitingReason({ status: 'approved', queuedBehind: { status, outcomeInDoubt } }, zh);
    expect(behind('pending_approval', false)?.message).toContain('还在等审批');
    expect(behind('executing', true)?.message).toContain('结果不明');
    expect(behind('executing', false)?.message).toContain('正在执行');
    expect(behind('executing', false)?.tone).toBe('info');
    expect(
      waitingShortLabel(
        {
          status: 'auto_approved',
          queuedBehind: { status: 'pending_approval', outcomeInDoubt: false },
        },
        en,
      )?.label,
    ).toBe('Queued: an earlier request on this system awaits approval');
  });

  it('says nothing for a row that is not waiting, or a field on the wrong status', () => {
    expect(waitingReason({ status: 'executing' }, zh)).toBeNull();
    expect(waitingReason({ status: 'executing', outcomeInDoubt: null }, zh)).toBeNull();
    expect(
      waitingReason({ status: 'executed', outcomeInDoubt: { since, reason: null } }, zh),
    ).toBeNull();
    expect(waitingShortLabel({ status: 'approved', queuedBehind: null }, zh)).toBeNull();
  });
});

describe('actionTargetLabel', () => {
  it('names a request_action call by its Operation and up to three plain params', () => {
    expect(
      actionTargetLabel(
        'request_action',
        {
          gatekeeperId: 'gk-1',
          operation: 'container.restart',
          params: { name: 'media', timeout: 10, force: true, extra: 'x', nested: { a: 1 } },
        },
        zh,
      ),
    ).toBe('container.restart（name: media，timeout: 10，force: true）');
  });

  it('names a projected gate tool by its own name and arguments, as JSON text too', () => {
    expect(actionTargetLabel('docker_container_restart', '{"name":"media"}', en)).toBe(
      'docker_container_restart (name: media)',
    );
    expect(
      actionTargetLabel('docker_container_restart', { gatekeeperId: 'gk', name: 'a' }, zh),
    ).toBe('docker_container_restart（name: a）');
  });

  it('shows a hidden character in the name or a value as \\u{XXXX} (legacy 232)', () => {
    expect(
      actionTargetLabel(
        'request_action',
        { operation: 'container.\u202Erestart', params: { name: 'me\u200Bdia' } },
        en,
      ),
    ).toBe('container.\\u{202E}restart (name: me\\u{200B}dia)');
  });

  it('falls back to the name alone when the arguments were cut short, and to nothing without one', () => {
    expect(actionTargetLabel('docker_container_restart', '{"name":"me', zh)).toBe(
      'docker_container_restart',
    );
    expect(actionTargetLabel(undefined, undefined, zh)).toBeUndefined();
    expect(actionTargetLabel('t', { long: 'z'.repeat(60) }, en)).toBe(
      `t (long: ${'z'.repeat(40)}…)`,
    );
  });
});
