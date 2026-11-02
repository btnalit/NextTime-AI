// @vitest-environment jsdom
import type { PlatformChangeSegmentWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionsProvider } from '../../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { HttpError } from '../../../lib/http-client.js';
import { LangProvider } from '../../../lib/i18n.js';
import { PlatformAdminProposalsPage } from '../PlatformAdminProposalsPage.js';
import {
  PROD_SEGMENT,
  PROPOSAL,
  RECORD,
  ROOT,
  WS_PROD,
  WS_TRIAL,
  changeRecord,
  named,
  rollbackItem,
  rollbackPreview,
  scriptedHttp,
} from './admin-proposal-fixtures.test-helpers.js';

const SOURCE_NAME = changeRecord().source.name;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** S11 AA4b: 平台 · 管理员提案 · 平台变更记录 — what applying platform parts changed, how each
 *  instance stands now (read live from the rollback dry run), and the rollback. */

function Harness({ http, initialItemId }: { http: CapabilityCaller; initialItemId?: string }) {
  const [itemId, setItemId] = useState<string | undefined>(initialItemId);
  return (
    <PlatformAdminProposalsPage
      http={http}
      tab="records"
      itemId={itemId}
      onNavigate={(_tab, id) => setItemId(id ?? undefined)}
    />
  );
}

function renderRecords(http: CapabilityCaller, initialItemId?: string) {
  return render(
    <LangProvider>
      <PermissionsProvider>
        <Harness http={http} initialItemId={initialItemId} />
      </PermissionsProvider>
    </LangProvider>,
  );
}

const ROLLED_BACK_AT = '2026-11-02T10:00:00.000Z';

describe('平台变更记录 (S11 AA4b)', () => {
  it('lists what applying platform parts changed; a record shows where it came from, each instance as created, and how each stands now', async () => {
    const http = scriptedHttp({
      list_platform_change_segments: (params) => {
        const status = (params as { status?: string }).status;
        return { items: status === undefined || status === 'applied' ? [changeRecord()] : [] };
      },
      get_platform_change_segment: () => changeRecord(),
      preview_roll_back_platform_change_segment: () =>
        rollbackPreview({
          items: [
            rollbackItem(1, 'kb-main', { drift: ['target'], linkedWorkspaceCount: 2 }),
            rollbackItem(2, 'ops-api', { action: 'gone' }),
          ],
          canRollBack: false,
        }),
    });
    renderRecords(http);

    const row = await screen.findByTestId(`platform-change-record-row-${RECORD}`);
    expect(row.textContent).toContain('新建门宿主实例 知识库、运维接口');
    expect(row.textContent).toContain(`来源：管理员提案 ${SOURCE_NAME}`);
    expect(row.textContent).toContain('由 Root 应用');

    fireEvent.change(screen.getByTestId('platform-change-records-filter'), {
      target: { value: 'rolled_back' },
    });
    expect((await screen.findByTestId('platform-change-records-empty')).textContent).toContain(
      '没有这个状态的平台变更记录',
    );
    expect(named(http.calls, 'list_platform_change_segments').at(-1)?.params).toEqual({
      status: 'rolled_back',
    });
    fireEvent.change(screen.getByTestId('platform-change-records-filter'), {
      target: { value: 'all' },
    });
    fireEvent.click(await screen.findByTestId(`platform-change-record-row-${RECORD}`));

    const detail = await screen.findByTestId('platform-change-record-detail');
    const source = within(detail).getByTestId('platform-change-record-source');
    expect(source.textContent).toContain(`管理员提案 ${SOURCE_NAME}`);
    expect(within(source).getByRole('link').getAttribute('href')).toBe(
      `#/platform/admin-proposals/${PROPOSAL}`,
    );
    const items = within(detail).getByTestId('platform-change-record-items');
    expect(within(items).getByTestId('platform-change-record-item-1').textContent).toContain(
      '由 Root 逐项确认（权限边界）',
    );
    expect(
      within(items)
        .getAllByRole('link', { name: '去门实例页' })
        .map((link) => link.getAttribute('href')),
    ).toEqual(['#/platform/integrations/kb-main', '#/platform/integrations/ops-api']);

    // How each stands now, from the rollback dry run.
    expect(named(http.calls, 'preview_roll_back_platform_change_segment')[0]?.params).toEqual({
      changeSegmentId: RECORD,
    });
    expect((await within(detail).findByTestId('platform-change-record-now-1')).textContent).toBe(
      '知识库：地址在应用之后改过；没有停用；2 个工作区启用了它',
    );
    expect(within(detail).getByTestId('platform-change-record-now-2').textContent).toBe(
      '运维接口：已删除',
    );
    // Changed since: no rollback, and why.
    expect(
      (within(detail).getByTestId('platform-change-record-rollback-trigger') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      within(detail).getByTestId('platform-change-record-rollback-missing-steps').textContent,
    ).toContain(
      '知识库（地址）在应用之后变了（被删掉重建过，或门宿主报上来的不一样了），已经不是这条记录建的样子，这条记录撤销不了。要停用它，到它的门实例页去停用',
    );
  });

  it('the rollback lists the workspaces that enabled each instance with where to cut them off, then says what it did', async () => {
    let rolledBack: PlatformChangeSegmentWire | null = null;
    const enabled = rollbackItem(1, 'kb-main', {
      linkedWorkspaceCount: 52,
      enabledIn: [
        { workspaceId: WS_PROD, name: '生产', purpose: 'standard' },
        { workspaceId: WS_TRIAL, name: '试验场', purpose: 'admin_trial' },
      ],
    });
    const http = scriptedHttp({
      list_platform_change_segments: () => ({ items: [rolledBack ?? changeRecord()] }),
      get_platform_change_segment: () => rolledBack ?? changeRecord(),
      preview_roll_back_platform_change_segment: () =>
        rolledBack
          ? rollbackPreview({
              changeSegment: rolledBack,
              items: [
                rollbackItem(1, 'kb-main', {
                  action: 'already_disabled',
                  linkedWorkspaceCount: 52,
                }),
                rollbackItem(2, 'ops-api', { action: 'already_disabled' }),
              ],
              canRollBack: false,
            })
          : rollbackPreview({ items: [enabled, rollbackItem(2, 'ops-api')] }),
      // Two other RAGFlow instances share the connector the proposal's instance joined.
      list_gate_instances: () => ({
        items: [{ gateId: 'kb-main' }, { gateId: 'kb-legal' }, { gateId: 'kb-hr' }],
      }),
      roll_back_platform_change_segment: () => {
        rolledBack = changeRecord({
          status: 'rolled_back',
          rolledBackBy: ROOT,
          rolledBackAt: ROLLED_BACK_AT,
        });
        return {
          changeSegment: rolledBack,
          items: [enabled, rollbackItem(2, 'ops-api')],
          withdrawnSegments: 1,
        };
      },
    });
    renderRecords(http, RECORD);

    const trigger = (await screen.findByTestId(
      'platform-change-record-rollback-trigger',
    )) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    const confirm = await screen.findByTestId('platform-change-record-rollback-confirm');
    expect(confirm.textContent).toContain('停用 知识库');
    expect(confirm.textContent).toContain('停用 运维接口');
    expect(confirm.textContent).toContain('已启用的会继续调用');
    const kb = within(confirm).getByTestId('platform-change-record-enabled-in-1');
    expect(kb.textContent).toContain('知识库：52 个工作区启用了它');
    expect(kb.textContent).toContain('生产');
    expect(kb.textContent).toContain('试验场');
    expect(kb.textContent).toContain('还有 50 个没有列出');
    // #936 UX 必须修-1: the per-workspace cut-off first; the connector's says what it costs.
    expect(confirm.textContent).toContain(
      '请那个工作区的所有者在「能力目录 → Operation」里停用这个门的 Operation，只影响他们自己的工作区',
    );
    const cutOff = await within(kb).findByTestId('platform-change-record-connector-cutoff-1');
    await waitFor(() => expect(cutOff.getAttribute('data-instance-count')).toBe('3'));
    expect(cutOff.textContent).toBe(
      '也可以在「集成 → 接入包」停用 ragflow 的 Operation，但那会切断这个接入包下全部 3 个门宿主实例的调用，不只 知识库。',
    );
    expect(named(http.calls, 'list_gate_instances')[0]?.params).toEqual({ connector: 'ragflow' });
    expect(within(kb).getByRole('link', { name: '去「集成 → 接入包」' }).getAttribute('href')).toBe(
      '#/platform/integrations',
    );
    expect(within(kb).getByRole('link', { name: '去门实例页' }).getAttribute('href')).toBe(
      '#/platform/integrations/kb-main',
    );
    // An instance no workspace enabled is not listed.
    expect(within(confirm).queryByTestId('platform-change-record-enabled-in-2')).toBeNull();

    fireEvent.click(within(confirm).getByRole('button', { name: '撤销' }));
    await waitFor(() =>
      expect(
        named(http.calls, 'roll_back_platform_change_segment').map((call) => call.params),
      ).toEqual([{ changeSegmentId: RECORD }]),
    );
    expect((await screen.findByTestId('platform-change-record-rollback-result')).textContent).toBe(
      '已撤销：停用了 2 个门宿主实例；这份提案还在待确认的 1 个工作区部分随之撤回。',
    );
    expect(screen.getByTestId('platform-change-record-status').textContent).toBe('已撤销');
    expect(screen.getByTestId('platform-change-record-rolled-back').textContent).toContain(
      '由 Root 撤销',
    );
    // How things stand now is read again, after the rollback.
    await waitFor(() =>
      expect(screen.getByTestId('platform-change-record-now-1').textContent).toContain('已停用'),
    );
    expect(screen.queryByTestId('platform-change-record-rollback-trigger')).toBeNull();
  });

  it('says when the connector holds only this instance, and says "every instance" without a count when it cannot tell (#936 UX 必须修-1)', async () => {
    const enabled = rollbackItem(1, 'kb-main', {
      linkedWorkspaceCount: 1,
      enabledIn: [{ workspaceId: WS_PROD, name: '生产', purpose: 'standard' }],
    });
    const httpWith = (instances: () => unknown) =>
      scriptedHttp({
        list_platform_change_segments: () => ({ items: [changeRecord()] }),
        get_platform_change_segment: () => changeRecord(),
        preview_roll_back_platform_change_segment: () =>
          rollbackPreview({ items: [enabled, rollbackItem(2, 'ops-api')] }),
        list_gate_instances: instances,
      });
    renderRecords(
      httpWith(() => ({ items: [{ gateId: 'kb-main' }] })),
      RECORD,
    );
    fireEvent.click(await screen.findByTestId('platform-change-record-rollback-trigger'));
    const only = await screen.findByTestId('platform-change-record-connector-cutoff-1');
    await waitFor(() => expect(only.getAttribute('data-instance-count')).toBe('1'));
    expect(only.textContent).toBe(
      '也可以在「集成 → 接入包」停用 ragflow 的 Operation：这个接入包下现在只有 知识库 这一个门宿主实例，之后加进来的实例也会被拒绝这些 Operation。',
    );
    cleanup();

    const down = httpWith(() => Promise.reject(new Error('down')));
    renderRecords(down, RECORD);
    fireEvent.click(await screen.findByTestId('platform-change-record-rollback-trigger'));
    const unknown = await screen.findByTestId('platform-change-record-connector-cutoff-1');
    await waitFor(() => expect(named(down.calls, 'list_gate_instances')).toHaveLength(1));
    expect(unknown.getAttribute('data-instance-count')).toBeNull();
    expect(unknown.textContent).toBe(
      '也可以在「集成 → 接入包」停用 ragflow 的 Operation，但那会切断这个接入包下所有门宿主实例的调用，不只 知识库。',
    );
  });

  it('applied workspace parts hold the rollback until their owners roll them back', async () => {
    const http = scriptedHttp({
      list_platform_change_segments: () => ({ items: [changeRecord()] }),
      get_platform_change_segment: () => changeRecord(),
      preview_roll_back_platform_change_segment: () =>
        rollbackPreview({
          dependentsApplied: [
            { segmentId: PROD_SEGMENT, targetWorkspaceId: WS_PROD, status: 'applied' },
          ],
          canRollBack: false,
        }),
    });
    renderRecords(http, RECORD);

    expect((await screen.findByTestId('platform-change-record-dependents')).textContent).toContain(
      '生产',
    );
    expect(
      (screen.getByTestId('platform-change-record-rollback-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('platform-change-record-rollback-missing-steps').textContent).toBe(
      '这份提案有 1 个工作区部分已经应用，要先由各自的所有者在「安装历史」里撤销',
    );
  });

  it('a refusal because something moved after the dry run rolls nothing back, says so and reads both again', async () => {
    let previews = 0;
    const http = scriptedHttp({
      list_platform_change_segments: () => ({ items: [changeRecord()] }),
      get_platform_change_segment: () => changeRecord(),
      preview_roll_back_platform_change_segment: () => {
        previews += 1;
        return previews === 1
          ? rollbackPreview()
          : rollbackPreview({
              items: [
                rollbackItem(1, 'kb-main', { drift: ['target'] }),
                rollbackItem(2, 'ops-api'),
              ],
              canRollBack: false,
            });
      },
      roll_back_platform_change_segment: () =>
        Promise.reject(
          new HttpError('capability_error', 'changed since', 'platform_change_drifted'),
        ),
    });
    renderRecords(http, RECORD);

    fireEvent.click(await screen.findByTestId('platform-change-record-rollback-trigger'));
    const confirm = await screen.findByTestId('platform-change-record-rollback-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: '撤销' }));

    // The dialog showed a dry run now out of date: it closes, and why nothing was rolled back
    // stays beside how things stand now, read again.
    expect((await screen.findByTestId('platform-change-record-stale')).textContent).toBe(
      '在你查看之后，有实例在平台上又被改过，所以什么也没有撤销。下面已经换成现在的样子。',
    );
    await waitFor(() =>
      expect(screen.queryByTestId('platform-change-record-rollback-confirm')).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('platform-change-record-now-1').textContent).toContain(
        '地址在应用之后改过',
      ),
    );
    expect(named(http.calls, 'preview_roll_back_platform_change_segment')).toHaveLength(2);
    await waitFor(() => expect(named(http.calls, 'get_platform_change_segment')).toHaveLength(2));
    expect(
      (screen.getByTestId('platform-change-record-rollback-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId('platform-change-record-rollback-result')).toBeNull();
  });

  it('a record rolled back already shows who did it and how things stand since, with no rollback', async () => {
    const record = changeRecord({
      status: 'rolled_back',
      rolledBackBy: ROOT,
      rolledBackAt: ROLLED_BACK_AT,
    });
    const http = scriptedHttp({
      list_platform_change_segments: () => ({ items: [record] }),
      get_platform_change_segment: () => record,
      preview_roll_back_platform_change_segment: () =>
        rollbackPreview({
          changeSegment: record,
          items: [
            rollbackItem(1, 'kb-main', { action: 'already_disabled' }),
            rollbackItem(2, 'ops-api', { action: 'already_disabled' }),
          ],
          canRollBack: false,
        }),
    });
    renderRecords(http, RECORD);

    expect((await screen.findByTestId('platform-change-record-rolled-back')).textContent).toContain(
      '由 Root 撤销',
    );
    expect(screen.getByTestId('platform-change-record-detail').textContent).toContain(
      '撤销之后的现状',
    );
    expect((await screen.findByTestId('platform-change-record-now-1')).textContent).toBe(
      '知识库：定义和应用时一样；已停用；没有工作区启用它',
    );
    expect(screen.queryByTestId('platform-change-record-rollback')).toBeNull();
  });

  it('a record the platform does not have reads as not found', async () => {
    const http = scriptedHttp({
      list_platform_change_segments: () => ({ items: [] }),
      get_platform_change_segment: () =>
        Promise.reject(
          new HttpError('capability_error', 'no such record', 'platform_change_segment_not_found'),
        ),
    });
    renderRecords(http, RECORD);
    expect((await screen.findByTestId('platform-change-record-missing')).textContent).toContain(
      '找不到这条平台变更记录',
    );
  });
});
