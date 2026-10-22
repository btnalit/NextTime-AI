// @vitest-environment jsdom
import type {
  ChangeItemWire,
  ChangeRollbackItemWire,
  ChangeRollbackPreviewWire,
  ChangeSegmentDetailWire,
  ChangeSegmentWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { ChangesTab, typeNamesText, wideningText } from './ChangesTab.js';

afterEach(cleanup);

const FIRST = '11111111-1111-4111-8111-111111111111';
const LATER = '22222222-2222-4222-8222-222222222222';

function segment(id: string, patch: Partial<ChangeSegmentWire> = {}): ChangeSegmentWire {
  return {
    id,
    planId: id,
    channel: 'human',
    source: { kind: 'pack', name: 'ops-assets', version: '2', digest: 'sha256:x' },
    status: 'applied',
    proposedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
    appliedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
    appliedAt: '2026-10-20T08:00:00.000Z',
    verifiedAt: null,
    rolledBackBy: null,
    rolledBackAt: null,
    itemCount: 1,
    wideningItemCount: 0,
    ...patch,
  };
}

const ONTOLOGY_TARGET = { family: 'ops-assets', ontologyId: 'o-1' };

function detail(
  id: string,
  patch: Partial<Extract<ChangeItemWire, { kind: 'ontology_version' }>> = {},
  segmentPatch: Partial<ChangeSegmentWire> = {},
): ChangeSegmentDetailWire {
  return {
    segment: segment(id, segmentPatch),
    items: [
      {
        id: `item-${id}`,
        ordinal: 1,
        kind: 'ontology_version',
        classification: 'not_widening',
        widening: [],
        confirmedBy: null,
        state: 'in_effect',
        replacedBy: null,
        target: ONTOLOGY_TARGET,
        before: null,
        after: { version: 1, definitionDigest: 'sha256:a' },
        ...patch,
      },
    ],
  };
}

function preview(
  id: string,
  patch: Partial<Extract<ChangeRollbackItemWire, { kind: 'ontology_version' }>> = {},
): ChangeRollbackPreviewWire {
  const item = {
    ordinal: 1,
    kind: 'ontology_version' as const,
    target: ONTOLOGY_TARGET,
    from: { version: 1, definitionDigest: 'sha256:a' },
    to: null,
    classification: 'not_widening' as const,
    widening: [],
    removes: { objectTypes: ['Host'], linkTypes: ['runs_on'], actionTypes: [] },
    blocker: null,
    blockedBy: null,
    conflicts: [],
    ...patch,
  };
  return {
    segment: segment(id),
    possible: item.blocker === null,
    items: [item],
    inUse: { objects: 3, links: 0, capped: false },
  };
}

const OWNER_WORKSPACE = {
  id: 'ws-1',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00Z',
  principalCount: 1,
  gatekeeperCount: 0,
  caller: { id: 'p-owner', role: 'owner', displayName: 'Owner', kind: 'human' },
};

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function Harness({ http, initialItemId }: { http: CapabilityCaller; initialItemId?: string }) {
  const [itemId, setItemId] = useState<string | undefined>(initialItemId);
  return (
    <ChangesTab http={http} itemId={itemId} onSelectItem={(id) => setItemId(id ?? undefined)} />
  );
}

function renderTab(http: CapabilityCaller, initialItemId?: string) {
  return render(
    <PermissionsProvider>
      <Harness http={http} initialItemId={initialItemId} />
    </PermissionsProvider>,
  );
}

describe('ChangesTab (能力目录 · 安装历史, S11 P1-B)', () => {
  it('lists install records; a record shows what it changed and names the record that replaced it', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_change_segments: () => ({
        items: [segment(LATER), segment(FIRST, { channel: 'platform' })],
      }),
      get_change_segment: (params) =>
        (params as { segmentId: string }).segmentId === FIRST
          ? detail(
              FIRST,
              { state: 'replaced', replacedBy: { segmentId: LATER } },
              { channel: 'platform' },
            )
          : detail(LATER),
      preview_roll_back_change_segment: () =>
        preview(FIRST, { blocker: 'replaced', blockedBy: { segmentId: LATER } }),
    });
    renderTab(http);

    const row = await screen.findByTestId(`catalog-change-row-${FIRST}`);
    expect(row.textContent).toMatch(/能力包 ops-assets v2/);
    expect(row.textContent).toContain('创建工作区时由平台安装');
    fireEvent.click(row);

    const pane = await screen.findByTestId('catalog-change-detail');
    expect(within(pane).getByTestId('catalog-change-title').textContent).toMatch(
      /^能力包 ops-assets v2$/,
    );
    expect(pane.textContent).toContain('记在第一位所有者 Owner 名下');
    const item = within(pane).getByTestId('catalog-change-item-1');
    // The ontology version is numbered apart from the pack's, and says so.
    expect(item.textContent).toContain(
      '能力包 v2 带来的本体版本（与能力包版本分开编号）：未安装 → 第 1 版',
    );
    expect(item.textContent).toContain('已被后来的改动替换');
    const replaced = within(pane).getByTestId('catalog-change-item-1-replaced');
    expect(replaced.querySelector('a')?.getAttribute('href')).toBe(
      `#/govern/catalog/changes/${LATER}`,
    );

    // The rollback says why it cannot go ahead, links the later record, and stays disabled.
    fireEvent.click(await within(pane).findByTestId('catalog-change-rollback-trigger'));
    const blocker = await screen.findByTestId('catalog-change-blocker-1');
    expect(blocker.textContent).toContain('之后又被改过');
    expect(blocker.querySelector('a')?.getAttribute('href')).toBe(
      `#/govern/catalog/changes/${LATER}`,
    );
    const confirm = screen.getByRole('button', { name: '撤销' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('catalog-change-missing').textContent).toBe(
      '有改动项现在不能撤销，原因见上',
    );
    expect(http.calls.some((c) => c.name === 'roll_back_change_segment')).toBe(false);
  });

  it('the owner rolls a record back: preview first, each authority-boundary change ticked, then one call', async () => {
    let rolledBack = false;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_change_segments: () => ({
        items: [segment(FIRST, rolledBack ? { status: 'rolled_back' } : {})],
      }),
      get_change_segment: () =>
        detail(
          FIRST,
          {},
          rolledBack
            ? {
                status: 'rolled_back',
                rolledBackBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
                rolledBackAt: '2026-10-21T08:00:00.000Z',
              }
            : {},
        ),
      preview_roll_back_change_segment: () =>
        preview(FIRST, {
          classification: 'authority_widening',
          widening: [{ path: 'actionTypes[restart]', reason: 'removed' }],
          removes: { objectTypes: ['Host'], linkTypes: [], actionTypes: ['restart'] },
        }),
      roll_back_change_segment: () => {
        rolledBack = true;
        return segment(FIRST, { status: 'rolled_back' });
      },
    });
    renderTab(http, FIRST);

    fireEvent.click(await screen.findByTestId('catalog-change-rollback-trigger'));
    const previewPane = await screen.findByTestId('catalog-change-preview');
    expect(previewPane.textContent).toContain('本体 ops-assets：第 1 版 → 未安装');
    expect(previewPane.textContent).toMatch(/对象类型 Host/);
    expect(previewPane.textContent).toMatch(/动作类型 restart/);
    expect(screen.getByTestId('catalog-change-in-use').textContent).toContain('3 个对象');

    const confirm = screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId('catalog-change-missing').textContent).toBe(
      '还差：勾选 1 项权限边界确认',
    );
    const tick = screen.getByTestId('catalog-change-confirm-item-1');
    expect(tick.closest('label')?.textContent).toMatch(/去掉动作类型 restart/);
    fireEvent.click(tick);
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByTestId('catalog-change-missing')).toBeNull();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'roll_back_change_segment')).toEqual([
        { name: 'roll_back_change_segment', params: { segmentId: FIRST, confirmedOrdinals: [1] } },
      ]),
    );
    const status = await screen.findByTestId('catalog-change-status');
    await waitFor(() => expect(status.textContent).toBe('已撤销'));
    expect(screen.queryByTestId('catalog-change-rollback-trigger')).toBeNull();
    const done = screen.getByTestId('catalog-change-rolled-back');
    expect(done.closest('output')).not.toBeNull();
    expect(done.textContent).toContain('已有的对象和事实都保留着');
  });

  it('a member reads the history but is not offered the rollback', async () => {
    const http = scriptedHttp({
      get_workspace: () => ({
        ...OWNER_WORKSPACE,
        caller: { ...OWNER_WORKSPACE.caller, role: 'member' },
      }),
      list_change_segments: () => ({ items: [segment(FIRST)] }),
      get_change_segment: () => detail(FIRST),
    });
    renderTab(http, FIRST);

    await screen.findByTestId('catalog-change-detail');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('catalog-change-rollback')).toBeNull());
  });

  it('no records yet: says what makes one', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_change_segments: () => ({ items: [] }),
    });
    renderTab(http);
    expect((await screen.findByTestId('catalog-changes-empty')).textContent).toContain(
      '在「能力包」页签安装或升级一个能力包后',
    );
  });
});

describe('wideningText', () => {
  function Sample({ path, reason }: { path: string; reason: 'removed' | 'loosened' | 'added' }) {
    const t = useT();
    return <span data-testid="w">{wideningText({ path, reason }, t)}</span>;
  }

  it('reads a widening reason as a sentence', () => {
    render(<Sample path="actionTypes[restart]" reason="removed" />);
    expect(screen.getByTestId('w').textContent).toMatch(/^去掉动作类型 restart$/);
    cleanup();
    render(<Sample path="actionTypes[restart].mode" reason="loosened" />);
    expect(screen.getByTestId('w').textContent).toBe('动作类型 restart 的 mode放宽');
    cleanup();
    render(<Sample path="extra" reason="added" />);
    expect(screen.getByTestId('w').textContent).toBe('字段 extra：新增');
  });
});

describe('typeNamesText', () => {
  function Sample({ objectTypes }: { objectTypes: string[] }) {
    const t = useT();
    return (
      <span data-testid="r">
        {typeNamesText({ objectTypes, linkTypes: ['runs_on'], actionTypes: [] }, t)}
      </span>
    );
  }

  it('spells out a short list and shortens a long one to the first few and the total', () => {
    render(<Sample objectTypes={['Host', 'Disk']} />);
    expect(screen.getByTestId('r').textContent).toMatch(/^对象类型 Host、Disk；关系类型 runs_on$/);
    cleanup();
    render(<Sample objectTypes={['A', 'B', 'C', 'D', 'E', 'F', 'G']} />);
    expect(screen.getByTestId('r').textContent).toMatch(
      /^对象类型 A、B、C、D、E 等 7 个；关系类型 runs_on$/,
    );
  });
  it('wideningText: a Skill or Worker reason in words', () => {
    function Probe() {
      const t = useT();
      return (
        <p data-testid="probe">
          {[
            { path: 'skill', reason: 'added' as const },
            { path: 'skill.markdown', reason: 'changed' as const },
            { path: 'worker.skills', reason: 'loosened' as const },
            { path: 'worker.egressDeny', reason: 'loosened' as const },
            { path: 'worker.extra', reason: 'unrecognized' as const },
          ]
            .map((w) => wideningText(w, t))
            .join(' | ')}
        </p>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe(
      '新增这个 Skill：挂载它的 Worker 会读到它的全文 | Skill 正文有改动 | Worker 挂载的 Skill 增加 | Worker 禁止访问的地址减少 | Worker 字段 extra：无法识别',
    );
  });
});
