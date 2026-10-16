import { describe, expect, it } from 'vitest';
import {
  actionOutcomeChip,
  actionOutcomeOfToolResult,
  actionTargetLabel,
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
    [{ id: 'a1', status: 'failed', reason: 'transport_error: … responded 500' }, 'failed'],
    // A reason that only mentions a code later on is not that reason.
    [{ id: 'a1', status: 'failed', reason: 'operation_refused: not outcome_unknown:' }, 'failed'],
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
