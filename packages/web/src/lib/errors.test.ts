import { CALL_REFUSAL_REASONS } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  CODE_TITLES,
  CODE_TITLES_ZH,
  callRefusalReasonText,
  carriesGateReason,
  describeError,
  errorMessage,
  isForbiddenError,
  localizedErrorTitle,
  presentError,
} from './errors.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { RpcError, TurnAlreadyRunningError } from './ws-client.js';

describe('describeError', () => {
  it('a server code that names an Object.prototype member gets a plain string title', () => {
    for (const code of ['__proto__', 'constructor', 'toString']) {
      const described = describeError(new HttpError('capability_error', 'x', code));
      expect(typeof described.title).toBe('string');
      expect(localizedErrorTitle(described, (zh) => zh)).toBe('出错了');
    }
  });

  it('surfaces the HTTP wire code and the kernel message verbatim', () => {
    const described = describeError(
      new HttpError('capability_error', 'principal role "member" does not satisfy', 'forbidden'),
    );
    expect(described).toEqual({
      code: 'forbidden',
      title: 'Not permitted',
      message: 'principal role "member" does not satisfy',
    });
    expect(isForbiddenError(new HttpError('capability_error', 'x', 'forbidden'))).toBe(true);
  });

  it('treats D-24 not_proposer as a per-row refusal, not a role denial', () => {
    const err = new HttpError(
      'capability_error',
      'deprecate_skill: Skill s@1 was proposed by another principal',
      'not_proposer',
    );
    expect(describeError(err)).toMatchObject({ code: 'not_proposer', title: 'Not the proposer' });
    // usePermissions.markDenied runs only on `forbidden` — one row someone else proposed must not
    // hide the action for the caller's own rows.
    expect(isForbiddenError(err)).toBe(false);
  });

  it('uses the HttpError kind as the code for network/invalid_response failures', () => {
    expect(describeError(new HttpError('network', 'capability call failed')).code).toBe('network');
    expect(describeError(new HttpError('invalid_response', 'non-JSON')).title).toBe(
      'Unexpected response',
    );
  });

  it('names the client-side RPC timeout (C5) for the banner', () => {
    const described = describeError(
      new RpcError(-32000, 'WsClient: approve timed out after 30000ms'),
    );
    expect(described.code).toBe('timeout');
    expect(described.title).toBe('No answer from the kernel');
  });

  it('maps JSON-RPC codes to the same stable names the HTTP transport uses', () => {
    expect(describeError(new RpcError(-32001, 'unauthorized')).code).toBe('unauthorized');
    expect(describeError(new RpcError(-32002, 'nope')).code).toBe('forbidden');
    expect(describeError(new RpcError(-32004, 'missing')).code).toBe('not_found');
    expect(describeError(new RpcError(-32602, 'bad')).code).toBe('invalid_params');
    expect(describeError(new TurnAlreadyRunningError('busy')).code).toBe('turn_already_running');
    expect(describeError(new RpcError(-32099, 'weird')).code).toBe('rpc_-32099');
    expect(describeError(new RpcError(-32016, 'excluded')).code).toBe(
      'worker_definition_not_enabled',
    );
    // Legacy 673: one idempotency key, two different texts.
    expect(describeError(new RpcError(-32020, 'reused')).code).toBe('idempotency_key_reused');
    // Legacy 336: -32014 by its message, `gatekeeper_error` when the message says nothing.
    expect(describeError(new RpcError(-32014, 'gate_error: boom')).code).toBe('gatekeeper_error');
    expect(
      describeError(new RpcError(-32014, 'gatekeeper client: gate/apply timed out after 30000ms'))
        .code,
    ).toBe('gatekeeper_timeout');
  });

  it('derives a readable title for a wire code it has no curated label for', () => {
    expect(describeError(new HttpError('capability_error', 'x', 'brand_new_code')).title).toBe(
      'Brand new code',
    );
    // `depth_exceeded` used to be the example here; it has a curated title now.
    expect(describeError(new HttpError('capability_error', 'x', 'depth_exceeded')).title).toBe(
      'Delegation too deep',
    );
  });

  it('classifies WsClient connection errors and falls back to unknown otherwise', () => {
    expect(describeError(new Error('WsClient: connection closed')).code).toBe('connection_closed');
    expect(describeError('plain string')).toEqual({
      code: 'unknown',
      title: 'Error',
      message: 'plain string',
    });
    expect(errorMessage(new Error('m'))).toBe('m');
  });
});

describe('localizedErrorTitle', () => {
  const zh = <T>(a: T, _b: T): T => a;
  const en = <T>(_a: T, b: T): T => b;

  it('keeps the zh and en title tables in step', () => {
    expect(Object.keys(CODE_TITLES_ZH).sort()).toEqual(Object.keys(CODE_TITLES).sort());
  });

  it('picks the curated title per language', () => {
    const described = describeError(new HttpError('capability_error', 'x', 'forbidden'));
    expect(localizedErrorTitle(described, zh)).toBe('没有权限');
    expect(localizedErrorTitle(described, en)).toBe('Not permitted');
  });

  it('falls back to a generic zh title for an unknown code, and the derived label in en', () => {
    const described = describeError(new HttpError('capability_error', 'x', 'some_new_code'));
    expect(localizedErrorTitle(described, zh)).toBe('出错了');
    expect(localizedErrorTitle(described, en)).toBe('Some new code');
  });
});

describe('legacy 493: invalid_step_reference', () => {
  const zh = <T>(text: T) => text;
  it('names the step and why when the kernel says, the kernel text kept under the fold', () => {
    const message =
      'Procedure step 0 does not resolve: Operation "orders.lookup" on Gatekeeper gk-1 is not published (or does not exist)';
    const shown = presentError(
      new HttpError('capability_error', message, 'invalid_step_reference'),
      zh,
    );
    expect(shown.message).toMatch(
      /^第 1 步（Operation「orders\.lookup」）：这个 Operation 没有发布/,
    );
    expect(shown.raw).toBe(message);
  });

  it('otherwise says what a step refers to cannot be used, not that a step refers to a step', () => {
    const shown = presentError(
      new HttpError('capability_error', 'something else', 'invalid_step_reference'),
      zh,
    );
    expect(shown.message).toMatch(/有一步引用的 Operation 或 Worker 现在用不了/);
  });
});

/** Legacy 666: every reason the kernel's authorization refuses a call for is worded, once. */
describe('callRefusalReasonText', () => {
  it('words every CALL_REFUSAL_REASONS value in both languages, and nothing else', () => {
    const zh: Translate = (text) => text;
    const en: Translate = (_zh, text) => text;
    for (const reason of CALL_REFUSAL_REASONS) {
      expect(callRefusalReasonText(reason, zh)).toMatch(/[一-鿿]/);
      expect(callRefusalReasonText(reason, en)).toMatch(/^[A-Z]/);
    }
    expect(
      new Set(CALL_REFUSAL_REASONS.map((reason) => callRefusalReasonText(reason, zh))).size,
    ).toBe(CALL_REFUSAL_REASONS.length);
    expect(callRefusalReasonText('somebody', zh)).toBeNull();
    expect(callRefusalReasonText('toString', zh)).toBeNull();
  });
});

describe('carriesGateReason (legacy 224 ③, 779)', () => {
  const json = (value: unknown) => JSON.stringify(value, null, 2);

  it('is a reason or code the result reports as its own outcome', () => {
    expect(
      carriesGateReason(json({ status: 'failed', reason: 'gate_unreachable: not sent' })),
    ).toBe(true);
    expect(carriesGateReason(json({ error: { code: 'unknown_operation', message: 'x' } }))).toBe(
      true,
    );
    expect(carriesGateReason(json({ code: 'unstorable_text' }))).toBe(true);
    // A reason that is no gate reason is not one.
    expect(carriesGateReason(json({ status: 'failed', reason: 'budget_exhausted' }))).toBe(false);
  });

  it('legacy 779: is not a reason one refused entry of a successful read reports', () => {
    const task = {
      id: 't1',
      status: 'completed',
      result: {
        factsRejected: [{ index: 0, linkType: 'runs_on', reason: 'unstorable_text' }],
        proposedOperationsRejected: [
          { index: 1, gatekeeperId: 'g1', reason: 'invalid_operation_name', problem: 'dot' },
        ],
      },
    };
    expect(carriesGateReason(json(task))).toBe(false);
    // `report_task_result`'s answer lists them at its top, still one entry each.
    expect(
      carriesGateReason(
        json({ id: 't1', status: 'completed', ...task.result, factIds: [], evidenceDropped: [] }),
      ),
    ).toBe(false);
  });

  it('reads pi’s result: its details, and the JSON in its text', () => {
    const failed = { status: 'failed', reason: 'outcome_unknown: apply for a1' };
    expect(
      carriesGateReason(json({ content: [{ type: 'text', text: JSON.stringify(failed) }] })),
    ).toBe(true);
    expect(carriesGateReason(json({ content: [], details: failed }))).toBe(true);
    const read = { id: 't1', result: { factsRejected: [{ index: 0, reason: 'unstorable_text' }] } };
    expect(
      carriesGateReason(
        json({ content: [{ type: 'text', text: JSON.stringify(read) }], details: read }),
      ),
    ).toBe(false);
  });

  it('reads a preview cut short, and is not a code merely mentioned', () => {
    const text = json({ status: 'failed', reason: 'operation_refused: the gate said no, because' });
    expect(carriesGateReason(text.slice(0, text.length - 12))).toBe(true);
    expect(carriesGateReason(json({ ok: true, lines: ['gate_unreachable seen, recovered'] }))).toBe(
      false,
    );
    expect(carriesGateReason(json({ note: 'reason: gate_unreachable' }))).toBe(false);
    expect(carriesGateReason('not json at all: "reason": "gate_unreachable"')).toBe(false);
  });
});
