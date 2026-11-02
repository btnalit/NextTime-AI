// @vitest-environment jsdom
import type { PlatformSegmentApplyResultWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionsProvider } from '../../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { HttpError } from '../../../lib/http-client.js';
import { LangProvider } from '../../../lib/i18n.js';
import { PlatformAdminProposalsPage } from '../PlatformAdminProposalsPage.js';
import {
  KB_INTENT,
  OPS_INTENT,
  PLATFORM_SEGMENT,
  PROD_SEGMENT,
  PROPOSAL,
  RECORD,
  changeRecord,
  named,
  platformPreview,
  platformSegment,
  previewItem,
  proposal,
  ragflowPreset,
  rollbackPreview,
  scriptedHttp,
  summary,
  workspaceSegment,
} from './admin-proposal-fixtures.test-helpers.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** S11 AA4b: the platform part of an admin proposal under review (`preview_platform_segment`):
 *  each gate-host instance as it would be created, every one ticked, apply with the reviewed digest
 *  and the ticked ordinals, reject with a reason. */

function renderDetail(http: CapabilityCaller, english = false) {
  if (english) localStorage.setItem('nexttime.lang', 'en');
  return render(
    <LangProvider>
      <PermissionsProvider>
        <PlatformAdminProposalsPage
          http={http}
          tab="proposals"
          itemId={PROPOSAL}
          onNavigate={() => {}}
        />
      </PermissionsProvider>
    </LangProvider>,
  );
}

const APPLIED_AT = '2026-11-02T08:00:00.000Z';

function applyResult(): PlatformSegmentApplyResultWire {
  return {
    segment: platformSegment({ status: 'applied', decidedAt: APPLIED_AT }),
    changeSegment: changeRecord(),
    nextSteps: [
      {
        gateId: 'kb-main',
        steps: ['enter_shared_credential', 'await_announce', 'review_and_enable'],
      },
      { gateId: 'ops-api', steps: ['await_announce', 'review_and_enable'] },
    ],
  };
}

describe('PlatformSegmentReview (平台部分审阅, S11 AA4b)', () => {
  it('shows each instance as it would be created; apply waits for every tick and carries only the reviewed digest and the ticked ordinals', async () => {
    let applied = false;
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () =>
        applied
          ? proposal({
              status: 'proposed',
              segments: [
                platformSegment({ status: 'applied', decidedAt: APPLIED_AT }),
                ...proposal().segments.slice(1),
              ],
            })
          : proposal(),
      preview_platform_segment: () => platformPreview(),
      apply_platform_segment: () => {
        applied = true;
        return applyResult();
      },
      preview_roll_back_platform_change_segment: () => rollbackPreview(),
    });
    renderDetail(http);

    const review = await screen.findByTestId('platform-segment-review');
    const kb = within(review).getByTestId('platform-segment-item-1');
    expect(kb.textContent).toContain('新建门宿主实例 知识库');
    const kbFacts = within(kb).getByTestId('platform-segment-item-1-facts').textContent;
    expect(kbFacts).toContain('kb-main');
    expect(kbFacts).toContain(KB_INTENT.target);
    expect(kbFacts).toContain('ragflow（已有）');
    // The preset by its display name (list_connector_presets), not its name.
    expect(kbFacts).toContain(`预设 ${ragflowPreset().displayName}`);
    expect(within(kb).getByTestId('platform-segment-item-1-next-steps').textContent).toBe(
      '应用之后还要：在门宿主上录入共享凭据，然后等门宿主接管它并上报 Operation 清单，然后审阅这些 Operation 后启用它。在此之前工作区用不了它。',
    );
    const opsFacts = within(review).getByTestId('platform-segment-item-2-facts').textContent;
    expect(opsFacts).toContain(OPS_INTENT.target);
    expect(opsFacts).toContain('ops-console（新建，平台预置）');
    expect(opsFacts).toContain('OpenAPI 文档 https://ops.example.test/openapi.json');
    expect(opsFacts).toContain('共享凭据');

    // The workspace parts that wait on it, by name (the trial one marked).
    const dependents = within(review).getByTestId('platform-segment-dependents');
    expect(dependents.textContent).toContain('2 个工作区部分依赖它');
    expect(
      within(dependents).getByTestId(`platform-segment-dependent-${PROD_SEGMENT}`).textContent,
    ).toContain('生产');
    expect(dependents.textContent).toContain('试验场');

    // Every item moves an authority boundary: Apply waits for both ticks.
    const trigger = within(review).getByTestId(
      'platform-segment-apply-trigger',
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(within(review).getByTestId('platform-segment-missing-steps').textContent).toBe(
      '还差：勾选 2 项权限边界确认',
    );
    fireEvent.click(within(review).getByTestId('platform-segment-item-2-confirm'));
    expect(within(review).getByTestId('platform-segment-missing-steps').textContent).toBe(
      '还差：勾选 1 项权限边界确认',
    );
    fireEvent.click(within(review).getByTestId('platform-segment-item-1-confirm'));
    expect(trigger.disabled).toBe(false);
    expect(within(review).queryByTestId('platform-segment-missing-steps')).toBeNull();

    fireEvent.click(trigger);
    const confirm = await screen.findByTestId('platform-segment-apply-confirm');
    expect(confirm.textContent).toContain('在平台上新建 2 个门宿主实例，状态为「未启用」');
    expect(confirm.textContent).toContain('新建接入包 ops-console（平台预置）');
    expect(confirm.textContent).toContain('记成一条平台变更记录');
    fireEvent.click(within(confirm).getByRole('button', { name: '应用' }));

    await waitFor(() =>
      expect(named(http.calls, 'apply_platform_segment').map((call) => call.params)).toEqual([
        {
          segmentId: PLATFORM_SEGMENT,
          reviewedDigest: 'sha256:reviewed',
          confirmedOrdinals: [1, 2],
        },
      ]),
    );

    // Applied: what is left for each instance, and the record it left.
    const next = await screen.findByTestId('platform-admin-proposal-next-steps');
    expect(next.textContent).toContain(
      '知识库：在门宿主上录入共享凭据，然后等门宿主接管它并上报 Operation 清单，然后审阅这些 Operation 后启用它。',
    );
    expect(next.textContent).toContain('运维接口：等门宿主接管它并上报 Operation 清单');
    expect(
      within(next)
        .getAllByRole('link', { name: '去门实例页' })
        .map((link) => link.getAttribute('href')),
    ).toEqual(['#/platform/integrations/kb-main', '#/platform/integrations/ops-api']);
    await screen.findByTestId(`platform-change-record-${RECORD}`);
    expect(screen.getByTestId('platform-admin-proposal-platform-status').textContent).toBe(
      '已应用',
    );
    // The record came back with the apply: the list is not read for it.
    expect(named(http.calls, 'list_platform_change_segments')).toHaveLength(0);
  });

  it('suspected credentials are reviewed before applying, and the apply says so', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () => proposal(),
      preview_platform_segment: () =>
        platformPreview({
          items: [previewItem(KB_INTENT, 1, { classification: 'not_widening', widening: [] })],
          suspectedSecretValues: 1,
          suspectedSecretPaths: ['items[0].target'],
        }),
      apply_platform_segment: () => applyResult(),
      preview_roll_back_platform_change_segment: () => rollbackPreview(),
    });
    renderDetail(http);

    const review = await screen.findByTestId('platform-segment-review');
    expect(within(review).getByTestId('credential-review-where').textContent).toContain(
      '凭据应该在应用之后到门宿主上录入，不该写在地址里',
    );
    expect(within(review).getByTestId('platform-segment-missing-steps').textContent).toBe(
      '还差：核对疑似凭据',
    );
    fireEvent.click(within(review).getByTestId('credential-review-confirm'));
    fireEvent.click(within(review).getByTestId('platform-segment-apply-trigger'));
    fireEvent.click(
      within(await screen.findByTestId('platform-segment-apply-confirm')).getByRole('button', {
        name: '应用',
      }),
    );
    await waitFor(() =>
      expect(named(http.calls, 'apply_platform_segment')[0]?.params).toEqual({
        segmentId: PLATFORM_SEGMENT,
        reviewedDigest: 'sha256:reviewed',
        confirmedOrdinals: [],
        credentialsReviewed: true,
      }),
    );
  });

  it('what does not fit the platform now blocks applying, says what to do, and shows what was proposed with its address', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () => proposal(),
      preview_platform_segment: () =>
        platformPreview({
          digest: null,
          items: [],
          blockers: [{ ordinal: 2, kind: 'gate_instance', reason: 'connector_not_offerable' }],
        }),
    });
    renderDetail(http);

    const review = await screen.findByTestId('platform-segment-review');
    const blocker = within(review).getByTestId('platform-segment-blocker-2');
    expect(blocker.textContent).toContain(
      '新建门宿主实例 运维接口（接入包 ops-console）：同名的接入包存在，但不是「平台预置」',
    );
    expect(within(blocker).getByRole('link').getAttribute('href')).toBe('#/platform/integrations');
    expect(within(review).getByTestId('platform-segment-intent-1').textContent).toContain(
      KB_INTENT.target,
    );
    expect(within(review).getByTestId('platform-segment-intent-2').textContent).toContain(
      OPS_INTENT.target,
    );
    expect(
      (within(review).getByTestId('platform-segment-apply-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(review).getByTestId('platform-segment-missing-steps').textContent).toBe(
      '还差：处理 1 处对不上的地方',
    );
  });

  it('a refusal because the platform changed after the review applies nothing, reads the review again and clears the ticks', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () => proposal(),
      preview_platform_segment: () => platformPreview(),
      apply_platform_segment: () =>
        Promise.reject(
          new HttpError('capability_error', 'the plan changed', 'change_plan_changed'),
        ),
    });
    renderDetail(http);

    const review = await screen.findByTestId('platform-segment-review');
    fireEvent.click(within(review).getByTestId('platform-segment-item-1-confirm'));
    fireEvent.click(within(review).getByTestId('platform-segment-item-2-confirm'));
    fireEvent.click(within(review).getByTestId('platform-segment-apply-trigger'));
    fireEvent.click(
      within(await screen.findByTestId('platform-segment-apply-confirm')).getByRole('button', {
        name: '应用',
      }),
    );
    await waitFor(() => expect(named(http.calls, 'preview_platform_segment')).toHaveLength(2));
    expect((await screen.findByTestId('platform-segment-stale')).textContent).toContain(
      '什么也没有应用',
    );
    const again = await screen.findByTestId('platform-segment-item-1-confirm');
    expect((again as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('platform-segment-missing-steps').textContent).toBe(
      '还差：勾选 2 项权限边界确认',
    );
  });

  it('rejecting takes a reason, says who reads it and that waiting workspace parts are withdrawn, and sends it trimmed', async () => {
    let rejected = false;
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () => proposal(),
      preview_platform_segment: () => platformPreview(),
      reject_platform_segment: (params) => {
        rejected = true;
        const reason = (params as { reason: string }).reason;
        return proposal({
          status: 'closed',
          segments: [
            platformSegment({ status: 'rejected', reason, decidedAt: APPLIED_AT }),
            workspaceSegment({
              status: 'withdrawn',
              withdrawnOrigin: 'platform_segment',
              decidedAt: APPLIED_AT,
            }),
          ],
        });
      },
    });
    renderDetail(http);

    fireEvent.click(await screen.findByTestId('platform-segment-reject-trigger'));
    const confirm = await screen.findByTestId('platform-segment-reject-confirm');
    expect(confirm.textContent).toContain('撤回 2 个待确认的工作区部分');
    expect(confirm.textContent).toContain('理由只有平台管理员看得到');
    expect(confirm.textContent).toContain('管理员智能体只知道被拒绝了，看不到理由');
    const reject = within(confirm).getByRole('button', { name: '拒绝' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(within(confirm).getByTestId('platform-segment-reject-reason'), {
      target: { value: '  这个地址不对外  ' },
    });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);

    await waitFor(() =>
      expect(named(http.calls, 'reject_platform_segment').map((call) => call.params)).toEqual([
        { segmentId: PLATFORM_SEGMENT, reason: '这个地址不对外' },
      ]),
    );
    expect(rejected).toBe(true);
    expect((await screen.findByTestId('platform-admin-proposal-platform-reason')).textContent).toBe(
      '这个地址不对外',
    );
    expect(named(http.calls, 'apply_platform_segment')).toHaveLength(0);
  });

  it('decided by someone else meanwhile: the proposal reads again and shows how it stands', async () => {
    let decided = false;
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () =>
        decided
          ? proposal({
              status: 'closed',
              segments: [
                platformSegment({ status: 'rejected', reason: '别人拒了', decidedAt: APPLIED_AT }),
              ],
            })
          : proposal(),
      preview_platform_segment: () => platformPreview(),
      apply_platform_segment: () => {
        decided = true;
        return Promise.reject(
          new HttpError('capability_error', 'not open', 'admin_proposal_segment_not_open'),
        );
      },
    });
    renderDetail(http);

    const review = await screen.findByTestId('platform-segment-review');
    fireEvent.click(within(review).getByTestId('platform-segment-item-1-confirm'));
    fireEvent.click(within(review).getByTestId('platform-segment-item-2-confirm'));
    fireEvent.click(within(review).getByTestId('platform-segment-apply-trigger'));
    fireEvent.click(
      within(await screen.findByTestId('platform-segment-apply-confirm')).getByRole('button', {
        name: '应用',
      }),
    );
    expect((await screen.findByTestId('platform-admin-proposal-platform-reason')).textContent).toBe(
      '别人拒了',
    );
    // The review is gone with the part it reviewed; why nothing was applied stays in view.
    expect(screen.getByTestId('platform-admin-proposal-notice').textContent).toBe(
      '这个平台部分在你打开之后已经被处理了，什么也没有应用。下面已经换成它现在的样子。',
    );
    expect(screen.queryByTestId('platform-segment-review')).toBeNull();
  });

  it('rejecting a part decided meanwhile says nothing was rejected', async () => {
    let decided = false;
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () =>
        decided
          ? proposal({
              status: 'closed',
              segments: [platformSegment({ status: 'applied', decidedAt: APPLIED_AT })],
            })
          : proposal(),
      preview_platform_segment: () => platformPreview(),
      list_platform_change_segments: () => ({ items: [changeRecord()] }),
      preview_roll_back_platform_change_segment: () => rollbackPreview(),
      reject_platform_segment: () => {
        decided = true;
        return Promise.reject(
          new HttpError('capability_error', 'not open', 'admin_proposal_segment_not_open'),
        );
      },
    });
    renderDetail(http);

    fireEvent.click(await screen.findByTestId('platform-segment-reject-trigger'));
    const confirm = await screen.findByTestId('platform-segment-reject-confirm');
    fireEvent.change(within(confirm).getByTestId('platform-segment-reject-reason'), {
      target: { value: '不需要' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: '拒绝' }));
    expect((await screen.findByTestId('platform-admin-proposal-notice')).textContent).toBe(
      '这个平台部分在你打开之后已经被处理了，什么也没有拒绝。下面已经换成它现在的样子。',
    );
    expect(await screen.findByTestId(`platform-change-record-${RECORD}`)).toBeTruthy();
  });

  it('in English, what is still needed starts lower case after the colon', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () => proposal(),
      preview_platform_segment: () => platformPreview(),
    });
    renderDetail(http, true);
    expect((await screen.findByTestId('platform-segment-missing-steps')).textContent).toBe(
      'Still needed: tick 2 authority-boundary confirmations',
    );
    expect(screen.getByTestId('platform-segment-item-1-facts').textContent).toContain(
      'connector preset RAGFlow',
    );
    expect(screen.getByTestId('platform-segment-dependents').textContent).toContain(
      '2 workspace part(s) of this proposal depend on it',
    );
  });
});
