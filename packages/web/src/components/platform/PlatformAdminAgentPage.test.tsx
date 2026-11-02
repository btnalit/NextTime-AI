// @vitest-environment jsdom
import type {
  AdminAgentStatusWire,
  AdminAgentTargetWire,
  AdminAgentTrialWorkspaceWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { PlatformAdminAgentPage } from './PlatformAdminAgentPage.js';
import {
  WS_PROD,
  WS_TRIAL,
  named,
  workspace as platformWorkspace,
  scriptedHttp,
} from './admin-proposals/admin-proposal-fixtures.test-helpers.js';

/** An element's text, `''` when there is none. */
function text(element: Element | null | undefined): string {
  return element?.textContent ?? '';
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** S11 AA4c-3: 平台 · 管理员智能体 — per trial workspace whether the reader's admin agent may
 *  start, the targets it may propose to (one choice for all of their admin agent chats there), its
 *  session, and stopping it. */

const WS_TRIAL_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WS_OPS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const WS_GONE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function target(patch: Partial<AdminAgentTargetWire> = {}): AdminAgentTargetWire {
  return {
    workspaceId: WS_PROD,
    name: '生产',
    status: 'active',
    chosenAt: '2026-11-01T08:00:00.000Z',
    ...patch,
  };
}

function trial(patch: Partial<AdminAgentTrialWorkspaceWire> = {}): AdminAgentTrialWorkspaceWire {
  return {
    workspaceId: WS_TRIAL,
    name: '试验场',
    refusal: null,
    targets: [target()],
    session: null,
    ...patch,
  };
}

function status(patch: Partial<AdminAgentStatusWire> = {}): AdminAgentStatusWire {
  return { enabled: true, workspaces: [trial()], ...patch };
}

/** `list_workspaces {status:'active', purpose:'standard'}` — what the targets dialog offers. */
const STANDARD_WORKSPACES = [
  platformWorkspace(),
  platformWorkspace({ id: WS_OPS, name: '运维', isDefault: false }),
];

function renderPage(
  http: CapabilityCaller,
  options: { english?: boolean; onOpenChats?: (id: string, mode: 'open' | 'view') => void } = {},
) {
  if (options.english) localStorage.setItem('nexttime.lang', 'en');
  const onOpenChats = options.onOpenChats ?? vi.fn();
  render(
    <LangProvider>
      <PermissionsProvider>
        <PlatformAdminAgentPage http={http} onOpenChats={onOpenChats} />
      </PermissionsProvider>
    </LangProvider>,
  );
  return { onOpenChats };
}

describe('PlatformAdminAgentPage (平台 · 管理员智能体, S11 AA4c-3)', () => {
  it('shows each trial workspace with its targets, the shared-targets sentence and its session, and opens the admin agent chat there', async () => {
    const http = scriptedHttp({
      get_admin_agent_status: () =>
        status({
          workspaces: [
            trial({
              targets: [
                target(),
                target({ workspaceId: WS_GONE, name: '旧仓库', status: 'disabled' }),
              ],
              session: {
                sessionId: 'sess-1',
                startedAt: '2026-11-02T09:00:00.000Z',
                expiresAt: null,
              },
            }),
          ],
        }),
    });
    const { onOpenChats } = renderPage(http);

    const card = await screen.findByTestId('admin-agent-workspace');
    expect(card.getAttribute('data-workspace-id')).toBe(WS_TRIAL);
    expect(text(card)).toContain('试验场');
    // D1: the choice is one for every admin agent chat of the reader in this trial workspace.
    expect(text(within(card).getByTestId('admin-agent-targets'))).toContain(
      '这个试验工作区里你的所有管理员对话共用这一组目标',
    );
    const targets = within(card).getAllByTestId('admin-agent-target');
    expect(targets.map((row) => row.getAttribute('data-workspace-id'))).toEqual([WS_PROD, WS_GONE]);
    expect(text(targets[0])).not.toContain('已停用');
    expect(text(targets[1])).toContain('已停用，向它提议会被拒绝');

    const session = within(card).getByTestId('admin-agent-session');
    expect(text(session)).toContain('开始于');
    expect(text(session)).toContain('不会自动到期');
    expect(within(card).getByTestId('admin-agent-stop')).toBeTruthy();
    // One session: stopping it everywhere is the same as here, so the header has no 全部停止.
    expect(screen.queryByTestId('admin-agent-stop-all')).toBeNull();
    expect(screen.queryByTestId('admin-agent-switched-off')).toBeNull();
    expect(within(card).queryByTestId('admin-agent-refusal')).toBeNull();

    fireEvent.click(within(card).getByTestId('admin-agent-open-chat'));
    expect(onOpenChats).toHaveBeenCalledWith(WS_TRIAL, 'open');
    expect(text(screen.getByTestId('admin-agent-proposals-link'))).toContain('平台 · 管理员提案');
  });

  it('says once that the platform switched the agent off, and still lets the reader read and retarget its chats', async () => {
    const http = scriptedHttp({
      get_admin_agent_status: () =>
        status({
          enabled: false,
          workspaces: [
            trial({ refusal: 'switched_off' }),
            trial({ workspaceId: WS_TRIAL_2, name: '试验二', refusal: 'switched_off' }),
          ],
        }),
    });
    const { onOpenChats } = renderPage(http);

    expect(text(await screen.findByTestId('admin-agent-switched-off'))).toContain(
      '平台没有开启管理员智能体，需要维护者在主机环境里打开',
    );
    const cards = screen.getAllByTestId('admin-agent-workspace');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      // Said once for the page, not again on every card.
      expect(within(card).queryByTestId('admin-agent-refusal')).toBeNull();
      expect(within(card).queryByTestId('admin-agent-open-chat')).toBeNull();
      expect(within(card).getByTestId('admin-agent-choose-targets')).toBeTruthy();
      expect(within(card).getByTestId('admin-agent-no-session')).toBeTruthy();
    }
    fireEvent.click(within(cards[1] as HTMLElement).getByTestId('admin-agent-view-chats'));
    expect(onOpenChats).toHaveBeenCalledWith(WS_TRIAL_2, 'view');
  });

  it('says why the agent cannot start in a trial workspace, without offering its chats or targets', async () => {
    const http = scriptedHttp({
      get_admin_agent_status: () =>
        status({ workspaces: [trial({ refusal: 'workspace_disabled', targets: [] })] }),
    });
    renderPage(http);

    const card = await screen.findByTestId('admin-agent-workspace');
    expect(text(within(card).getByTestId('admin-agent-refusal'))).toContain(
      '管理员智能体不能在这里开始：这个试验工作区已停用。',
    );
    expect(within(card).queryByTestId('admin-agent-open-chat')).toBeNull();
    expect(within(card).queryByTestId('admin-agent-view-chats')).toBeNull();
    expect(within(card).queryByTestId('admin-agent-choose-targets')).toBeNull();
    expect(text(within(card).getByTestId('admin-agent-no-targets'))).toContain(
      '还没有选目标工作区',
    );
  });

  it('points a reader in no trial workspace at creating one, with the trial purpose preset', async () => {
    const http = scriptedHttp({ get_admin_agent_status: () => status({ workspaces: [] }) });
    renderPage(http);

    const empty = await screen.findByTestId('admin-agent-no-trial-workspace');
    expect(text(empty)).toContain('你还不在任何试验工作区里');
    expect(within(empty).getByTestId('admin-agent-create-trial').getAttribute('href')).toBe(
      '#/platform/workspaces?create=admin_trial',
    );
  });

  it('chooses targets from the active standard workspaces, shows what changes, and saves the whole list', async () => {
    let saved: AdminAgentTargetWire[] = [
      target(),
      target({ workspaceId: WS_GONE, name: '旧仓库', status: 'disabled' }),
    ];
    const http = scriptedHttp({
      get_admin_agent_status: () => status({ workspaces: [trial({ targets: saved })] }),
      list_workspaces: () => ({ items: STANDARD_WORKSPACES }),
      set_admin_agent_targets: (params) => {
        const ids = (params as { targetWorkspaceIds: string[] }).targetWorkspaceIds;
        saved = ids.map((id) => target({ workspaceId: id, name: id === WS_OPS ? '运维' : '生产' }));
        return {
          trialWorkspaceId: WS_TRIAL,
          targets: saved,
          added: [WS_OPS],
          removed: [WS_GONE],
        };
      },
    });
    renderPage(http);

    fireEvent.click(await screen.findByTestId('admin-agent-choose-targets'));
    const dialog = await screen.findByTestId('admin-agent-targets-dialog');
    expect(text(within(dialog).getByTestId('admin-agent-targets-shared'))).toContain(
      '都会作用到这个试验工作区下你的所有管理员对话',
    );
    // Only active standard workspaces are offered (a trial or ephemeral one never is a target).
    expect(named(http.calls, 'list_workspaces').at(-1)?.params).toEqual({
      status: 'active',
      purpose: 'standard',
    });
    const options = await within(dialog).findAllByTestId('admin-agent-target-option');
    expect(options.map((row) => row.getAttribute('data-workspace-id'))).toEqual([
      WS_GONE,
      WS_PROD,
      WS_OPS,
    ]);
    const box = (row: HTMLElement) => within(row).getByRole('checkbox') as HTMLInputElement;
    const [gone, prod, ops] = options as [HTMLElement, HTMLElement, HTMLElement];
    // A target disabled since it was chosen stays ticked, so unticking it is how it is removed.
    expect(box(gone).checked).toBe(true);
    expect(text(gone)).toContain('向它提议会被拒绝');
    expect(box(prod).checked).toBe(true);
    expect(box(ops).checked).toBe(false);
    expect(text(within(dialog).getByTestId('admin-agent-targets-options'))).toContain(
      '已选 2 个，最多 20 个',
    );
    expect(
      (
        within(dialog).getByTestId('admin-agent-targets-save') as
          | HTMLInputElement
          | HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(dialog).queryByTestId('admin-agent-targets-diff')).toBeNull();

    fireEvent.click(box(ops));
    fireEvent.click(box(gone));
    // Once unticked, a disabled workspace cannot be ticked again here.
    expect((box(gone) as HTMLInputElement | HTMLButtonElement).disabled).toBe(true);
    const diff = within(dialog).getByTestId('admin-agent-targets-diff');
    expect(text(diff)).toContain('加上：运维');
    expect(text(diff)).toContain('去掉：旧仓库。之前向它们提的工作区部分暂时不能应用。');

    fireEvent.click(within(dialog).getByTestId('admin-agent-targets-save'));
    await waitFor(() => expect(screen.queryByTestId('admin-agent-targets-dialog')).toBeNull());
    expect(named(http.calls, 'set_admin_agent_targets').map((call) => call.params)).toEqual([
      { trialWorkspaceId: WS_TRIAL, targetWorkspaceIds: [WS_PROD, WS_OPS] },
    ]);
    await waitFor(() =>
      expect(
        screen.getAllByTestId('admin-agent-target').map((row) => row.dataset.workspaceId),
      ).toEqual([WS_PROD, WS_OPS]),
    );
  });

  it('keeps the dialog open and says nothing changed when the save is refused', async () => {
    const http = scriptedHttp({
      get_admin_agent_status: () => status(),
      list_workspaces: () => ({ items: STANDARD_WORKSPACES }),
      set_admin_agent_targets: () => {
        throw new HttpError(
          'capability_error',
          'target not a standard active workspace',
          'invalid_params',
        );
      },
    });
    renderPage(http);

    fireEvent.click(await screen.findByTestId('admin-agent-choose-targets'));
    const dialog = await screen.findByTestId('admin-agent-targets-dialog');
    const options = await within(dialog).findAllByTestId('admin-agent-target-option');
    fireEvent.click(within(options[1] as HTMLElement).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByTestId('admin-agent-targets-save'));

    expect(text(await within(dialog).findByTestId('admin-agent-targets-error'))).toContain(
      '选中的工作区里有的已经停用、被删除或成了试验工作区，什么也没改',
    );
    expect(screen.getByTestId('admin-agent-targets-dialog')).toBeTruthy();
  });

  it('says a configuration-only administrator cannot choose targets yet', async () => {
    const http = scriptedHttp({
      get_admin_agent_status: () => status(),
      list_workspaces: () => ({ items: STANDARD_WORKSPACES }),
      set_admin_agent_targets: () => {
        throw new HttpError(
          'capability_error',
          'admin role only from configuration',
          'admin_role_not_stored',
        );
      },
    });
    renderPage(http);

    fireEvent.click(await screen.findByTestId('admin-agent-choose-targets'));
    const dialog = await screen.findByTestId('admin-agent-targets-dialog');
    const options = await within(dialog).findAllByTestId('admin-agent-target-option');
    fireEvent.click(within(options[1] as HTMLElement).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByTestId('admin-agent-targets-save'));

    expect(text(await within(dialog).findByTestId('admin-agent-targets-error'))).toContain(
      '请另一位平台管理员在「平台 → 用户」里把你设为平台管理员',
    );
  });

  it('caps the choice at the targets limit', async () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      platformWorkspace({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `工作区 ${index}`,
        isDefault: false,
      }),
    );
    const chosen = many.slice(0, 20).map((row) => target({ workspaceId: row.id, name: row.name }));
    const http = scriptedHttp({
      get_admin_agent_status: () => status({ workspaces: [trial({ targets: chosen })] }),
      list_workspaces: () => ({ items: many }),
    });
    renderPage(http);

    fireEvent.click(await screen.findByTestId('admin-agent-choose-targets'));
    const dialog = await screen.findByTestId('admin-agent-targets-dialog');
    const options = await within(dialog).findAllByTestId('admin-agent-target-option');
    expect(options).toHaveLength(21);
    expect(text(within(dialog).getByTestId('admin-agent-targets-options'))).toContain(
      '已选 20 个，最多 20 个',
    );
    const last = within(options[20] as HTMLElement).getByRole('checkbox');
    expect((last as HTMLInputElement | HTMLButtonElement).disabled).toBe(true);
    // More than a handful: a name filter narrows the list.
    fireEvent.change(within(dialog).getByTestId('admin-agent-targets-search'), {
      target: { value: '工作区 20' },
    });
    expect(within(dialog).getAllByTestId('admin-agent-target-option')).toHaveLength(1);
  });

  it('stops the agent in one trial workspace, and everywhere when several have a session', async () => {
    const open = { sessionId: 'sess', startedAt: '2026-11-02T09:00:00.000Z', expiresAt: null };
    const http = scriptedHttp({
      get_admin_agent_status: () =>
        status({
          workspaces: [
            trial({ session: open }),
            trial({ workspaceId: WS_TRIAL_2, name: '试验二', session: open }),
          ],
        }),
      stop_admin_agent: (params) =>
        (params as { trialWorkspaceId?: string }).trialWorkspaceId === undefined
          ? { revokedSessions: 2, stoppedTurns: 1 }
          : { revokedSessions: 1, stoppedTurns: 0 },
    });
    renderPage(http);

    const [first] = await screen.findAllByTestId('admin-agent-workspace');
    fireEvent.click(within(first as HTMLElement).getByTestId('admin-agent-stop'));
    const confirm = await screen.findByTestId('admin-agent-stop-confirm');
    expect(text(within(confirm).getByTestId('confirm-target'))).toContain('试验场');
    const impact = within(confirm).getByTestId('confirm-impact');
    expect(text(impact)).toContain('它的会话和 Handle 立刻吊销');
    expect(text(impact)).toContain('对话都还在');
    expect(text(impact)).toContain('已经提出的管理员提案不受影响');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(named(http.calls, 'stop_admin_agent').map((call) => call.params)).toEqual([
        { trialWorkspaceId: WS_TRIAL },
      ]),
    );
    expect(text(await screen.findByTestId('admin-agent-stopped'))).toContain(
      '管理员智能体已停止：吊销了 1 个会话，停下了 0 轮。',
    );

    fireEvent.click(screen.getByTestId('admin-agent-stop-all'));
    const all = await screen.findByTestId('admin-agent-stop-all-confirm');
    expect(text(all)).toContain('在所有试验工作区停止管理员智能体？');
    fireEvent.click(within(all).getByTestId('confirm-button'));
    await waitFor(() => expect(named(http.calls, 'stop_admin_agent')).toHaveLength(2));
    expect(named(http.calls, 'stop_admin_agent')[1]?.params).toEqual({});
    await waitFor(() =>
      expect(text(screen.getByTestId('admin-agent-stopped'))).toContain(
        '吊销了 2 个会话，停下了 1 轮。',
      ),
    );
  });

  it('renders in English', async () => {
    const http = scriptedHttp({
      get_admin_agent_status: () =>
        status({ enabled: false, workspaces: [trial({ refusal: 'switched_off' })] }),
    });
    renderPage(http, { english: true });

    expect(text(await screen.findByTestId('admin-agent-switched-off'))).toContain(
      'The platform has not switched the admin agent on',
    );
    const card = screen.getByTestId('admin-agent-workspace');
    expect(text(within(card).getByTestId('admin-agent-view-chats'))).toContain(
      'View admin agent chats',
    );
    expect(text(within(card).getByTestId('admin-agent-targets'))).toContain(
      'Every admin agent chat of yours in this trial workspace shares these targets',
    );
  });
});
