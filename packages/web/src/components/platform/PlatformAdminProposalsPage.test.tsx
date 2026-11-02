// @vitest-environment jsdom
import type { AdminProposalWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import type { PlatformProposalsTab } from '../../lib/router.js';
import { PlatformAdminProposalsPage } from './PlatformAdminProposalsPage.js';
import {
  KB_INTENT,
  OPS_INTENT,
  PLATFORM_SEGMENT,
  PROD_SEGMENT,
  PROPOSAL,
  RECORD,
  TRIAL_SEGMENT,
  WS_PROD,
  changeRecord,
  named,
  platformPreview,
  platformSegment,
  proposal,
  rollbackItem,
  rollbackPreview,
  scriptedHttp,
  summary,
  workspaceSegment,
} from './admin-proposals/admin-proposal-fixtures.test-helpers.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** S11 AA4b: 平台 · 管理员提案 — every admin proposal, and in its detail the platform part's
 *  review, the record its apply left, each workspace part's status, and withdrawing it. */

function Harness({
  http,
  initialTab = 'proposals',
  initialItemId,
}: {
  http: CapabilityCaller;
  initialTab?: PlatformProposalsTab;
  initialItemId?: string;
}) {
  const [tab, setTab] = useState<PlatformProposalsTab>(initialTab);
  const [itemId, setItemId] = useState<string | undefined>(initialItemId);
  return (
    <PlatformAdminProposalsPage
      http={http}
      tab={tab}
      itemId={itemId}
      onNavigate={(next, id) => {
        setTab(next);
        setItemId(id ?? undefined);
      }}
    />
  );
}

function renderPage(
  http: CapabilityCaller,
  options: { tab?: PlatformProposalsTab; itemId?: string; english?: boolean } = {},
) {
  if (options.english) localStorage.setItem('nexttime.lang', 'en');
  return render(
    <LangProvider>
      <PermissionsProvider>
        <Harness http={http} initialTab={options.tab} initialItemId={options.itemId} />
      </PermissionsProvider>
    </LangProvider>,
  );
}

describe('PlatformAdminProposalsPage (平台 · 管理员提案, S11 AA4b)', () => {
  it('lists every proposal by default, narrows by status, and opens one with its platform part under review and only the status of each workspace part', async () => {
    const http = scriptedHttp({
      list_admin_proposals: (params) => {
        const status = (params as { status?: string }).status;
        return { items: status === undefined || status === 'proposed' ? [summary()] : [] };
      },
      get_admin_proposal: () => proposal(),
      preview_platform_segment: () => platformPreview(),
    });
    renderPage(http);

    const row = await screen.findByTestId(`platform-admin-proposal-row-${PROPOSAL}`);
    expect(named(http.calls, 'list_admin_proposals')[0]?.params).toEqual({});
    expect(row.textContent).toContain('接入知识库');
    // #936 UX P3-3: the source name and when — every proposal here is a platform administrator's
    // admin agent's, so the proposer is read in the detail.
    expect(
      within(row).getByTestId(`platform-admin-proposal-row-source-${PROPOSAL}`).textContent,
    ).toBe('kb-onboarding');
    expect(row.textContent).not.toContain('平台管理员 Ada 的管理员智能体');
    expect(row.textContent).toContain('待确认 3');

    fireEvent.change(screen.getByTestId('platform-admin-proposals-filter'), {
      target: { value: 'applied' },
    });
    expect((await screen.findByTestId('platform-admin-proposals-empty')).textContent).toContain(
      '没有这个状态的管理员提案',
    );
    expect(named(http.calls, 'list_admin_proposals').at(-1)?.params).toEqual({
      status: 'applied',
    });
    fireEvent.change(screen.getByTestId('platform-admin-proposals-filter'), {
      target: { value: 'all' },
    });
    fireEvent.click(await screen.findByTestId(`platform-admin-proposal-row-${PROPOSAL}`));

    const detail = await screen.findByTestId('platform-admin-proposal-detail');
    expect(within(detail).getByTestId('platform-admin-proposal-title').textContent).toBe(
      '接入知识库',
    );
    expect(within(detail).getByTestId('platform-admin-proposal-description').textContent).toBe(
      '给生产工作区接上知识库，并加一个查知识库的 Skill。',
    );
    expect(within(detail).getByTestId('platform-admin-proposal-proposer').textContent).toBe(
      '平台管理员 Ada 的管理员智能体',
    );
    // Nothing decided yet: no partial notice, and the platform part is under review.
    expect(within(detail).queryByTestId('platform-admin-proposal-partial')).toBeNull();
    await within(detail).findByTestId('platform-segment-review');
    expect(named(http.calls, 'preview_platform_segment')[0]?.params).toEqual({
      segmentId: PLATFORM_SEGMENT,
    });

    // Workspace parts: who decides, how each stands — never what it changes (F7).
    const parts = within(detail).getByTestId('platform-admin-proposal-workspace-parts');
    expect(parts.textContent).toContain('能力目录 → 管理员提案');
    const prod = within(parts).getByTestId('platform-admin-proposal-workspace-part-2');
    expect(
      within(prod).getByTestId('platform-admin-proposal-workspace-part-2-workspace').textContent,
    ).toBe('生产');
    expect(
      within(prod).getByTestId('platform-admin-proposal-workspace-part-2-state').textContent,
    ).toBe('要等平台部分应用之后，所有者才能应用它');
    const trial = within(parts).getByTestId('platform-admin-proposal-workspace-part-3');
    expect(
      within(trial).getByTestId('platform-admin-proposal-workspace-part-3-workspace').textContent,
    ).toContain('试验场');
    expect(
      within(trial).getByTestId('platform-admin-proposal-workspace-part-3-workspace').textContent,
    ).toContain('试验');
    expect(parts.textContent).not.toContain('kb-search');
    expect(parts.textContent).not.toContain('查知识库');
  });

  it('withdrawing sends the reason trimmed, says who reads it, and the proposal then reads as it stands', async () => {
    let withdrawn: AdminProposalWire | null = null;
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary(withdrawn ? { status: 'closed' } : {})] }),
      get_admin_proposal: () => withdrawn ?? proposal(),
      preview_platform_segment: () => platformPreview(),
      withdraw_admin_proposal: (params) => {
        const reason = (params as { reason?: string }).reason ?? null;
        const decidedAt = '2026-11-02T09:00:00.000Z';
        withdrawn = proposal({
          status: 'closed',
          segmentCounts: { proposed: 0, applied: 0, rejected: 0, withdrawn: 3, rolledBack: 0 },
          segments: proposal().segments.map((segment) => ({
            ...segment,
            status: 'withdrawn',
            withdrawnOrigin: 'human',
            reason,
            decidedAt,
          })),
        });
        return withdrawn;
      },
    });
    renderPage(http, { itemId: PROPOSAL });

    fireEvent.click(await screen.findByTestId('platform-admin-proposal-withdraw-trigger'));
    const confirm = await screen.findByTestId('platform-admin-proposal-withdraw-confirm');
    expect(confirm.textContent).toContain('撤回 3 个待确认的部分');
    expect(confirm.textContent).toContain(
      '提议它的管理员智能体、平台管理员和收到它的工作区的所有者都读得到',
    );
    fireEvent.change(within(confirm).getByTestId('platform-admin-proposal-withdraw-reason'), {
      target: { value: '  先不接了  ' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: '撤回' }));

    await waitFor(() =>
      expect(named(http.calls, 'withdraw_admin_proposal').map((call) => call.params)).toEqual([
        { proposalId: PROPOSAL, reason: '先不接了' },
      ]),
    );
    const decision = await screen.findByTestId('platform-admin-proposal-platform-decision');
    expect(decision.textContent).toContain('平台管理员在控制台撤回了它');
    expect(screen.getByTestId('platform-admin-proposal-platform-reason').textContent).toBe(
      '先不接了',
    );
    expect(screen.getByTestId('platform-admin-proposal-status').textContent).toBe('已结束');
    expect(screen.queryByTestId('platform-admin-proposal-withdraw-trigger')).toBeNull();
    expect(
      screen.getByTestId('platform-admin-proposal-workspace-part-2-reason').textContent,
    ).toContain('先不接了');
    // The list reads again.
    await waitFor(() =>
      expect(named(http.calls, 'list_admin_proposals').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('withdrawing with no reason sends none', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () => proposal(),
      preview_platform_segment: () => platformPreview(),
      withdraw_admin_proposal: () => proposal(),
    });
    renderPage(http, { itemId: PROPOSAL });

    fireEvent.click(await screen.findByTestId('platform-admin-proposal-withdraw-trigger'));
    const confirm = await screen.findByTestId('platform-admin-proposal-withdraw-confirm');
    fireEvent.change(within(confirm).getByTestId('platform-admin-proposal-withdraw-reason'), {
      target: { value: '   ' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: '撤回' }));
    await waitFor(() =>
      expect(named(http.calls, 'withdraw_admin_proposal').map((call) => call.params)).toEqual([
        { proposalId: PROPOSAL },
      ]),
    );
  });

  it('a proposal whose parts ended differently says so; a rejected platform part shows why and what it proposed, presets by their display name', async () => {
    const decidedAt = '2026-11-02T09:00:00.000Z';
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary({ status: 'closed' })] }),
      get_admin_proposal: () =>
        proposal({
          status: 'closed',
          segments: [
            platformSegment({ status: 'rejected', reason: '地址不对', decidedAt }),
            workspaceSegment({
              status: 'withdrawn',
              withdrawnOrigin: 'platform_segment',
              decidedAt,
            }),
            workspaceSegment({
              id: TRIAL_SEGMENT,
              ordinal: 3,
              targetWorkspaceId: '00000000-0000-4000-8000-0000000000aa',
              status: 'withdrawn',
              withdrawnOrigin: 'platform_segment',
              decidedAt,
            }),
          ],
        }),
    });
    renderPage(http, { itemId: PROPOSAL });

    expect((await screen.findByTestId('platform-admin-proposal-partial')).textContent).toBe(
      '平台部分已拒绝；2 个工作区里 2 个已撤回',
    );
    expect(screen.getByTestId('platform-admin-proposal-platform-decision').textContent).toContain(
      '平台管理员拒绝了它',
    );
    expect(screen.getByTestId('platform-admin-proposal-platform-reason').textContent).toBe(
      '地址不对',
    );
    const kb = screen.getByTestId('platform-admin-proposal-intent-1').textContent;
    expect(kb).toContain('新建门宿主实例 知识库（预设 RAGFlow）');
    expect(kb).toContain(KB_INTENT.target);
    const ops = screen.getByTestId('platform-admin-proposal-intent-2').textContent;
    expect(ops).toContain('新建门宿主实例 运维接口（接入包 ops-console）');
    expect(ops).toContain(OPS_INTENT.target);
    // Nothing is open: no withdrawal, no review.
    expect(screen.queryByTestId('platform-admin-proposal-withdraw-trigger')).toBeNull();
    expect(named(http.calls, 'preview_platform_segment')).toHaveLength(0);
    expect(
      screen.getByTestId('platform-admin-proposal-workspace-part-2-state').textContent,
    ).toMatch(/^它依赖的平台部分被拒绝或撤销了，这一部分随之撤回，/);
    // A workspace the platform no longer lists (purged) shows by a short id.
    expect(
      screen.getByTestId('platform-admin-proposal-workspace-part-3-workspace').textContent,
    ).toContain('平台上找不到这个工作区');
  });

  it('in English the partial notice starts with a capital and the proposer reads as an admin agent', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary({ status: 'partially_applied' })] }),
      get_admin_proposal: () =>
        proposal({
          status: 'partially_applied',
          segments: [
            platformSegment({ status: 'applied', decidedAt: '2026-11-02T08:00:00.000Z' }),
            workspaceSegment({ status: 'applied', decidedAt: '2026-11-02T08:30:00.000Z' }),
            workspaceSegment({ id: TRIAL_SEGMENT, ordinal: 3, targetWorkspaceId: WS_PROD }),
          ],
        }),
      list_platform_change_segments: () => ({ items: [changeRecord()] }),
      preview_roll_back_platform_change_segment: () => rollbackPreview(),
    });
    renderPage(http, { itemId: PROPOSAL, english: true });

    expect((await screen.findByTestId('platform-admin-proposal-partial')).textContent).toBe(
      'Platform part applied; of 2 workspace parts: 1 awaiting, 1 applied',
    );
    expect(screen.getByTestId('platform-admin-proposal-proposer').textContent).toBe(
      "Ada's admin agent (platform administrator)",
    );
    expect(
      screen.getByTestId('platform-admin-proposal-workspace-part-2-state').textContent,
    ).toContain('Applied by its owner');
  });

  it('an applied platform part shows the record its apply left, found by the part it came from', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary({ status: 'partially_applied' })] }),
      get_admin_proposal: () =>
        proposal({
          status: 'partially_applied',
          segments: [
            platformSegment({ status: 'applied', decidedAt: '2026-11-02T08:00:00.000Z' }),
            workspaceSegment(),
          ],
        }),
      list_platform_change_segments: () => ({
        items: [
          changeRecord({
            id: '12121212-1212-4212-8212-121212121212',
            source: { ...changeRecord().source, proposalSegmentId: 'another-segment' },
          }),
          changeRecord(),
        ],
      }),
      preview_roll_back_platform_change_segment: () => rollbackPreview(),
    });
    renderPage(http, { itemId: PROPOSAL });

    const part = await screen.findByTestId('platform-admin-proposal-platform-part');
    const record = await within(part).findByTestId(`platform-change-record-${RECORD}`);
    expect(
      within(part).getByRole('link', { name: '在「平台变更记录」查看' }).getAttribute('href'),
    ).toBe(`#/platform/admin-proposals/records/${RECORD}`);
    expect(within(record).getByTestId('platform-change-record-items').textContent).toContain(
      '知识库',
    );
    expect(named(http.calls, 'preview_roll_back_platform_change_segment')[0]?.params).toEqual({
      changeSegmentId: RECORD,
    });
    // Applied with no workspace part applied yet: the workspace part may now be applied.
    expect(screen.getByTestId('platform-admin-proposal-workspace-part-2-state').textContent).toBe(
      '等工作区所有者在「能力目录 → 管理员提案」里决定',
    );
  });

  it('rolling the platform part back here keeps what it did in view while the proposal reads again', async () => {
    const decidedAt = '2026-11-02T08:00:00.000Z';
    let rolledBack = false;
    const record = () =>
      rolledBack
        ? changeRecord({
            status: 'rolled_back',
            rolledBackBy: { userId: 'u-root', displayName: 'Root' },
            rolledBackAt: '2026-11-02T10:00:00.000Z',
          })
        : changeRecord();
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary({ status: 'partially_applied' })] }),
      get_admin_proposal: () =>
        rolledBack
          ? proposal({
              status: 'closed',
              segments: [
                platformSegment({
                  status: 'rolled_back',
                  decidedAt,
                  rolledBackAt: '2026-11-02T10:00:00.000Z',
                }),
                workspaceSegment({
                  status: 'withdrawn',
                  withdrawnOrigin: 'platform_segment',
                  decidedAt: '2026-11-02T10:00:00.000Z',
                }),
              ],
            })
          : proposal({
              status: 'partially_applied',
              segments: [platformSegment({ status: 'applied', decidedAt }), workspaceSegment()],
            }),
      list_platform_change_segments: () => ({ items: [record()] }),
      preview_roll_back_platform_change_segment: () =>
        rolledBack
          ? rollbackPreview({
              changeSegment: record(),
              items: [
                rollbackItem(1, 'kb-main', { action: 'already_disabled' }),
                rollbackItem(2, 'ops-api', { action: 'already_disabled' }),
              ],
              canRollBack: false,
            })
          : rollbackPreview(),
      roll_back_platform_change_segment: () => {
        rolledBack = true;
        return {
          changeSegment: record(),
          items: [rollbackItem(1, 'kb-main'), rollbackItem(2, 'ops-api')],
          withdrawnSegments: 1,
        };
      },
    });
    renderPage(http, { itemId: PROPOSAL });

    const part = await screen.findByTestId('platform-admin-proposal-platform-part');
    fireEvent.click(await within(part).findByTestId('platform-change-record-rollback-trigger'));
    fireEvent.click(
      within(await screen.findByTestId('platform-change-record-rollback-confirm')).getByRole(
        'button',
        { name: '撤销' },
      ),
    );

    // The proposal reads again in place: the part reads as rolled back, the workspace part as
    // withdrawn with it, and what the rollback did stays in view.
    await waitFor(() =>
      expect(screen.getByTestId('platform-admin-proposal-platform-status').textContent).toBe(
        '已撤销',
      ),
    );
    expect(named(http.calls, 'get_admin_proposal')).toHaveLength(2);
    expect(screen.getByTestId('platform-change-record-rollback-result').textContent).toBe(
      '已撤销：停用了 2 个门宿主实例；这份提案还在待确认的 1 个工作区部分随之撤回。',
    );
    await waitFor(() =>
      expect(screen.getByTestId('platform-change-record-now-1').textContent).toContain('已停用'),
    );
    expect(screen.queryByTestId('platform-change-record-rollback-trigger')).toBeNull();
    expect(screen.queryByTestId('platform-admin-proposal-notice')).toBeNull();
  });

  it('withdrawing a proposal decided meanwhile says nothing was withdrawn and shows it as it stands', async () => {
    let decided = false;
    const closed = proposal({
      status: 'closed',
      segmentCounts: { proposed: 0, applied: 0, rejected: 3, withdrawn: 0, rolledBack: 0 },
      segments: proposal().segments.map((segment) => ({
        ...segment,
        status: 'rejected',
        reason: '别人拒了',
        decidedAt: '2026-11-02T09:00:00.000Z',
      })),
    });
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () => (decided ? closed : proposal()),
      preview_platform_segment: () => platformPreview(),
      withdraw_admin_proposal: () => {
        decided = true;
        return Promise.reject(
          new HttpError('capability_error', 'not open', 'admin_proposal_not_open'),
        );
      },
    });
    renderPage(http, { itemId: PROPOSAL });

    fireEvent.click(await screen.findByTestId('platform-admin-proposal-withdraw-trigger'));
    fireEvent.click(
      within(await screen.findByTestId('platform-admin-proposal-withdraw-confirm')).getByRole(
        'button',
        { name: '撤回' },
      ),
    );
    expect((await screen.findByTestId('platform-admin-proposal-notice')).textContent).toBe(
      '在你打开之后它已经没有待确认的部分了，什么也没有撤回。下面已经换成它现在的样子。',
    );
    await waitFor(() =>
      expect(screen.getByTestId('platform-admin-proposal-status').textContent).toBe('已结束'),
    );
    expect(screen.getByTestId('platform-admin-proposal-platform-reason').textContent).toBe(
      '别人拒了',
    );
    expect(screen.queryByTestId('platform-admin-proposal-withdraw-trigger')).toBeNull();
  });

  it('an applied platform part whose record is not among the newest says where to find it', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () =>
        proposal({ segments: [platformSegment({ status: 'applied' }), workspaceSegment()] }),
      list_platform_change_segments: () => ({ items: [] }),
    });
    renderPage(http, { itemId: PROPOSAL });
    expect(
      (await screen.findByTestId('platform-admin-proposal-record-missing')).textContent,
    ).toContain('不在最新的 100 条里');
  });

  it('a proposal the platform does not have reads as not found', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [] }),
      get_admin_proposal: () =>
        Promise.reject(
          new HttpError('capability_error', 'no such proposal', 'admin_proposal_not_found'),
        ),
    });
    renderPage(http, { itemId: PROPOSAL });
    expect((await screen.findByTestId('platform-admin-proposal-missing')).textContent).toContain(
      '找不到这份管理员提案',
    );
    expect(screen.getByTestId('platform-admin-proposals-empty').textContent).toContain(
      '还没有管理员提案',
    );
  });

  it('刷新 reads the list again; the tabs switch to the platform change records', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      list_platform_change_segments: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId(`platform-admin-proposal-row-${PROPOSAL}`);
    expect(named(http.calls, 'list_admin_proposals')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('platform-admin-proposals-refresh'));
    await waitFor(() => expect(named(http.calls, 'list_admin_proposals')).toHaveLength(2));

    fireEvent.click(screen.getByTestId('admin-proposals-tab-records'));
    expect((await screen.findByTestId('platform-change-records-empty')).textContent).toContain(
      '还没有平台变更记录',
    );
    expect(screen.getByTestId('platform-change-records-scope').textContent).toContain(
      '手动做的改动看平台审计',
    );
  });

  it('a proposal with only workspace parts can still be withdrawn here, and shows no platform part', async () => {
    const http = scriptedHttp({
      list_admin_proposals: () => ({ items: [summary()] }),
      get_admin_proposal: () =>
        proposal({ segments: [workspaceSegment({ ordinal: 1, id: PROD_SEGMENT })] }),
    });
    renderPage(http, { itemId: PROPOSAL });
    await screen.findByTestId('platform-admin-proposal-withdraw-trigger');
    expect(screen.queryByTestId('platform-admin-proposal-platform-part')).toBeNull();
    expect(screen.getByTestId('platform-admin-proposal-workspace-part-1-state').textContent).toBe(
      '等工作区所有者在「能力目录 → 管理员提案」里决定',
    );
  });
});
