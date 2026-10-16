// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionRequestRow } from '../../lib/governance.js';
import { HttpError } from '../../lib/http-client.js';
import { ApprovalDetail, type PendingConfirm } from './ApprovalDetail.js';

afterEach(cleanup);

function row(overrides: Partial<ActionRequestRow> = {}): ActionRequestRow {
  return {
    id: 'ar-1',
    status: 'pending_approval',
    gatekeeperId: 'gk-1',
    actionKindTag: 'docker.container_restart',
    resourceScope: 'web-1',
    blastRadius: 'medium',
    awaitDecision: true,
    params: { container: 'web-1', apiKey: 'sk-secret' },
    onBehalfOf: 'principal-a',
    actorRuntime: 'worker',
    policyDecision: 'require_approval',
    parentWorkerRunId: 'run-1',
    requestedAt: '2026-09-03T00:00:00.000Z',
    publishedDefinition: { version: 2, requestIsCurrent: true },
    ...overrides,
  };
}

/** `pending`/`onPendingChange` are controlled from the page in real use (S8 W1-A7 — see the
 *  prop's own doc comment on `ApprovalDetailProps`); this harness stands in for that with plain
 *  local state, the same shape `ApprovalQueuePage` owns. */
function renderDetail(
  overrides: Partial<ActionRequestRow> = {},
  props: Partial<Parameters<typeof ApprovalDetail>[0]> = {},
) {
  const onApprove = vi.fn(async () => undefined);
  const onReject = vi.fn(async () => undefined);
  function Harness() {
    const [pending, setPending] = useState<PendingConfirm | null>(null);
    return (
      <ApprovalDetail
        row={row(overrides)}
        principalNames={new Map([['principal-a', 'Alice']])}
        gatekeeperNames={new Map([['gk-1', 'docker-prod']])}
        canAlwaysAllow
        onApprove={onApprove}
        onReject={onReject}
        error={null}
        pending={pending}
        onPendingChange={setPending}
        {...props}
      />
    );
  }
  const view = render(<Harness />);
  return { ...view, onApprove, onReject };
}

describe('ApprovalDetail (S6-A B2 / B3 / C25)', () => {
  it('renders the kit/key-value action section with named gatekeeper / on-behalf-of chips, redacted params and the blocking notice', () => {
    renderDetail();
    const detail = screen.getByTestId('approval-detail');
    expect(screen.getByTestId('approval-blast-radius').getAttribute('data-status')).toBe('medium');
    expect(screen.getByTestId('approval-status').getAttribute('data-status')).toBe(
      'pending_approval',
    );
    expect(screen.getByTestId('approval-target').textContent).toBe('web-1');
    expect(screen.getByTestId('approval-on-behalf-of').textContent).toContain('Alice');
    expect(detail.querySelector('[data-ref-kind="gatekeeper"]')?.textContent).toContain(
      'docker-prod',
    );
    expect(screen.getByTestId('approval-params').textContent).toContain('[redacted]');
    expect(screen.getByTestId('approval-params').textContent).not.toContain('sk-secret');
    expect(screen.getByTestId('approval-blocking')).toBeTruthy();
    // Audit P1-13: the policy decision reads as words, the raw value only as a tooltip.
    expect(screen.getByTestId('approval-policy').textContent).toBe('策略要求人工审批');
    const whole = screen.getByTestId('approval-detail');
    expect(whole.textContent).toContain('Worker（被委派执行）');
    const self = whole.querySelector('[data-ref-kind="actionRequest"]');
    expect(self?.textContent).toContain('本请求');
    expect(self?.textContent).not.toContain('未知 / 已删除');
  });

  // Legacy 287 (review of #586): the detail says why an unfinished request waits.
  it('says an executing request in doubt may have run and that the platform is asking the gate', () => {
    renderDetail({
      status: 'executing',
      outcomeInDoubt: { since: '2026-10-16T07:00:00.000Z', reason: 'gate_connection_lost: …' },
    });
    const notice = screen.getByTestId('approval-waiting');
    expect(notice.className).toContain('notice-warn');
    expect(notice.textContent).toContain('动作结果不明，平台正在向门查询');
    expect(notice.textContent).toContain('动作可能已经执行');
  });

  it('says an approved request is queued behind an earlier one awaiting approval, and nothing for one that is not', () => {
    const { unmount } = renderDetail({
      status: 'approved',
      queuedBehind: { status: 'pending_approval', outcomeInDoubt: false },
    });
    const notice = screen.getByTestId('approval-waiting');
    expect(notice.className).toBe('notice');
    expect(notice.textContent).toContain('更早的一条请求还在等审批');
    unmount();
    renderDetail({ status: 'approved', queuedBehind: null });
    expect(screen.queryByTestId('approval-waiting')).toBeNull();
  });

  it('S11 GO1: says which kind of failure a failed request is — only "outcome unknown" in danger', () => {
    const failed = { status: 'failed', failedAt: '2026-10-16T07:00:00.000Z' } as const;
    const { unmount } = renderDetail({ ...failed, failureKind: 'outcome_unknown' });
    const unknown = screen.getByTestId('approval-failure');
    expect(unknown.className).toContain('notice-danger');
    expect(unknown.textContent).toContain('结果不明：动作可能已经执行');
    // UX acceptance of #586 (P2-2 / P3-2): it names the system and the action to check — by the
    // Operation's own name (UX acceptance of #601, P2-3).
    expect(unknown.textContent).toContain(
      '不要直接重试：先到 docker-prod 上核对 docker.container_restart（web-1）是否生效',
    );
    unmount();
    const second = renderDetail({ ...failed, failureKind: 'not_delivered' });
    const notSent = screen.getByTestId('approval-failure');
    expect(notSent.className).toBe('notice');
    expect(notSent.textContent).toContain('请求没有到达门，什么都没执行');
    second.unmount();
    const third = renderDetail({ ...failed, failureKind: 'refused' });
    expect(screen.getByTestId('approval-failure').textContent).toContain(
      '平台或门明确答复：不执行或执行失败',
    );
    third.unmount();
    // A pending request, and an older row without the field, say nothing of the kind.
    const fourth = renderDetail();
    expect(screen.queryByTestId('approval-failure')).toBeNull();
    fourth.unmount();
    renderDetail({ ...failed });
    expect(screen.queryByTestId('approval-failure')).toBeNull();
  });

  it('legacy 329: a refused request shows the reason the kernel recorded, as plain text with its line breaks', () => {
    renderDetail({
      status: 'failed',
      failedAt: '2026-10-16T07:00:00.000Z',
      failureKind: 'refused',
      failureReason: 'gate refused: <b>credential</b> missing\nAuthorization: [redacted]',
    });
    const reason = screen.getByTestId('approval-failure-reason');
    expect(reason.textContent).toBe(
      '原因：gate refused: <b>credential</b> missing\nAuthorization: [redacted]',
    );
    expect(reason.className).toBe('pre-wrap');
    expect(reason.querySelector('b')).toBeNull();
  });

  it('legacy 328: a withdrawn request says nothing ran and nothing is needed, and offers no decision', () => {
    renderDetail({ status: 'withdrawn' });
    const notice = screen.getByTestId('approval-failure');
    expect(notice.className).toBe('notice');
    expect(notice.textContent).toContain('已撤回：什么都没执行');
    expect(notice.textContent).toContain('不需要处理');
    expect(screen.queryByTestId('approval-failure-reason')).toBeNull();
    expect(screen.queryByRole('button', { name: /批准|拒绝/ })).toBeNull();
  });

  it('L8a-10: a gate-scoped request (scope = the gate’s own id) reads as the whole gate, never the raw id', () => {
    const gatekeeperId = '3f2a9c1e-0b4d-4e6f-8a7b-1c2d3e4f5a6b';
    renderDetail(
      { gatekeeperId, resourceScope: gatekeeperId },
      { gatekeeperNames: new Map([[gatekeeperId, 'docker-prod']]) },
    );
    expect(screen.getByTestId('approval-target').textContent).toBe('整个门');
    expect(screen.getByTestId('approval-detail').textContent).not.toContain(gatekeeperId);
  });

  it('reports the decision with the reason and the always-allow choice; Reject opens a confirm carrying the reason (S8 W1-A7: every Reject confirms)', async () => {
    const { onApprove, onReject } = renderDetail();
    fireEvent.change(screen.getByTestId('approval-reason'), { target: { value: ' why ' } });
    // R-20 / D-15: the option names the gate and says it covers every requester.
    const option = screen.getByRole('checkbox', { name: /总是允许/ });
    expect(screen.getByTestId('approval-always-allow-option').textContent).toContain('docker-prod');
    expect(screen.getByTestId('approval-always-allow-option').textContent).toContain('任何人');
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId('approval-approve'));
    // Writing the rule always confirms, even at medium blast radius, and the confirm states the
    // rule's real scope.
    const alwaysConfirm = await screen.findByTestId('approval-confirm');
    expect(onApprove).not.toHaveBeenCalled();
    expect(
      within(alwaysConfirm).getByTestId('approval-confirm-always-allow-scope').textContent,
    ).toContain('docker-prod');
    expect(alwaysConfirm.textContent).toContain('其他门上的同名动作不受影响');
    // UX acceptance of #592 (P2-1): the rule covers the version published now, and says so.
    expect(screen.getByTestId('approval-always-allow-option').textContent).toContain(
      '只对现在发布的 v2 有效',
    );
    expect(
      within(alwaysConfirm).getByTestId('approval-confirm-always-allow-scope').textContent,
    ).toMatch(/只对\s*v2/);
    fireEvent.click(within(alwaysConfirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith({
        actionRequestId: 'ar-1',
        reason: 'why',
        alwaysAllow: true,
        credentialsReviewed: false,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('approval-confirm')).toBeNull());
    fireEvent.click(screen.getByTestId('approval-reject'));
    const confirm = await screen.findByTestId('approval-confirm');
    expect(within(confirm).getByTestId('approval-confirm-reason').textContent).toBe('why');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(onReject).toHaveBeenCalledWith({ actionRequestId: 'ar-1', reason: 'why' }),
    );
  });

  it('a request made under a definition no longer published: "总是允许" is not offered, and the page says why (UX acceptance of #592 P2-1)', () => {
    renderDetail({ publishedDefinition: { version: 3, requestIsCurrent: false } });
    expect(screen.queryByTestId('approval-always-allow-option')).toBeNull();
    const stale = screen.getByTestId('approval-always-allow-stale');
    expect(stale.textContent).toMatch(/门上现在发布的是\s*v3/);
    expect(stale.textContent).toContain('工作区所有者');
  });

  it('no published version of the action (a draft, deprecated or removed): "总是允许" is not offered, and the page says why (UX acceptance of #592)', () => {
    renderDetail(
      { publishedDefinition: { version: null, requestIsCurrent: false } },
      { gatekeeperNames: new Map([['gk-1', 'docker-prod']]) },
    );
    expect(screen.queryByTestId('approval-always-allow-option')).toBeNull();
    expect(screen.queryByTestId('approval-always-allow-stale')).toBeNull();
    const hint = screen.getByTestId('approval-always-allow-unpublished');
    expect(hint.textContent).toContain('门「docker-prod」上没有已发布的');
    expect(hint.textContent).toMatch(/草稿/);
  });

  it('a row that says nothing about the definition offers no "总是允许" — nothing to bind the rule to', () => {
    renderDetail({ publishedDefinition: undefined });
    expect(screen.queryByTestId('approval-always-allow-option')).toBeNull();
    expect(screen.getByTestId('approval-approve')).toBeTruthy();
  });

  it('the requester’s own request that may not be self-decided shows no decision buttons and says who decides (dead-end sweep of #592)', () => {
    renderDetail({ requesterCanApprove: false }, { callerPrincipalId: 'principal-a' });
    expect(screen.queryByTestId('approval-approve')).toBeNull();
    expect(screen.queryByTestId('approval-always-allow-option')).toBeNull();
    expect(screen.getByTestId('approval-own-request').textContent).toMatch(/另一位有审批权的人/);
    expect(screen.queryByTestId('approval-blocking')).toBeNull();
  });

  it('someone else’s request, or one the requester may decide, keeps the buttons', () => {
    renderDetail({ requesterCanApprove: false }, { callerPrincipalId: 'principal-b' });
    expect(screen.getByTestId('approval-approve')).toBeTruthy();
    cleanup();
    renderDetail({ requesterCanApprove: null }, { callerPrincipalId: 'principal-a' });
    expect(screen.getByTestId('approval-approve')).toBeTruthy();
  });

  it('a medium approval without "总是允许" still goes straight through, no confirm', async () => {
    const { onApprove } = renderDetail();
    fireEvent.click(screen.getByTestId('approval-approve'));
    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith({
        actionRequestId: 'ar-1',
        reason: undefined,
        alwaysAllow: false,
        credentialsReviewed: false,
      }),
    );
    expect(screen.queryByTestId('approval-confirm')).toBeNull();
  });

  it('high blast radius: never offers "总是允许" (R-20 / I8), and Approve without a reason is refused in place (the kernel rule, mirrored)', async () => {
    const { onApprove } = renderDetail({ blastRadius: 'high' });
    expect(screen.queryByTestId('approval-always-allow-option')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /批准/ }));
    // S8 W1-A10: ApprovalCard's reason error is bilingual via t() now; default zh-CN renders the
    // zh half.
    await screen.findByText('高影响动作必须填写批准理由');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('a decided row is read-only and shows the human decision (decidedBy chip, reason, time)', () => {
    renderDetail({
      status: 'approved',
      decidedBy: 'principal-a',
      decidedAt: '2026-09-03T00:01:00.000Z',
      decisionReason: 'looks safe',
      executedAt: '2026-09-03T00:02:00.000Z',
    });
    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const decidedBy = screen.getByTestId('approval-decided-by');
    expect(decidedBy.getAttribute('data-ref-id')).toBe('principal-a');
    expect(decidedBy.textContent).toContain('Alice');
    expect(screen.getByTestId('approval-decision-reason').textContent).toBe('looks safe');
    expect(screen.getByText(/执行于/)).toBeTruthy();
  });

  it('a decided row without a human decision says so instead of rendering an empty chip', () => {
    renderDetail({ status: 'auto_approved', decidedBy: null, decisionReason: null });
    expect(screen.queryByTestId('approval-decided-by')).toBeNull();
    expect(screen.getByTestId('approval-decision').textContent).toContain('无人工决定');
  });

  it('links to the audit page with the request id and, when decided, the decision node', () => {
    const { unmount } = renderDetail();
    expect(screen.getByTestId('approval-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?actionRequestId=ar-1',
    );
    unmount();
    renderDetail({ status: 'approved', approvalDecisionId: 'dec-9' });
    expect(screen.getByTestId('approval-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?nodeId=dec-9&actionRequestId=ar-1',
    );
  });

  it('hides the always-allow checkbox when the session may not write rules, and renders the decision error', () => {
    renderDetail(
      {},
      {
        canAlwaysAllow: false,
        error: new HttpError('capability_error', 'already decided', 'illegal_transition'),
      },
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('approval-decision-error').getAttribute('data-error-code')).toBe(
      'illegal_transition',
    );
  });

  it('a row with suspected credentials keeps Approve disabled until 「已核对凭据」, then sends it (decision 2026-10-09)', async () => {
    const { onApprove } = renderDetail({
      suspectedSecretValues: 2,
      suspectedSecretPaths: ['token', 'apiKey'],
    });
    expect(screen.getByTestId('credential-review-warning').textContent).toContain(
      '含 2 处疑似凭据',
    );
    // Names the fields, so the question is answerable where a value shows as [redacted].
    expect(screen.getByTestId('credential-review-paths').textContent).toBe('tokenapiKey');
    const approve = screen.getByTestId('approval-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute('title')).toBe('先勾选「已核对凭据」');
    fireEvent.click(screen.getByTestId('credential-review-confirm'));
    fireEvent.click(approve);
    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith({
        actionRequestId: 'ar-1',
        reason: undefined,
        alwaysAllow: false,
        credentialsReviewed: true,
      }),
    );
  });

  it('the kernel’s 400 credentials_review_required opens the confirmation instead of an error banner', () => {
    renderDetail(
      {},
      {
        error: new HttpError('capability_error', 'carries 1', 'credentials_review_required', {
          suspectedSecretValues: 1,
        }),
      },
    );
    expect(screen.getByTestId('credential-review').getAttribute('data-count')).toBe('1');
    expect(screen.queryByTestId('approval-decision-error')).toBeNull();
  });
});
