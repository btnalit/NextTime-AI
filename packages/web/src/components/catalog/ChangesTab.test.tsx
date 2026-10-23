// @vitest-environment jsdom
import type {
  ChangeItemWire,
  ChangeRollbackItemWire,
  ChangeRollbackPreviewWire,
  ChangeSegmentDetailWire,
  ChangeSegmentWire,
  ChangeVerificationWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
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
    verification: null,
  };
}

function verification(patch: Partial<ChangeVerificationWire> = {}): ChangeVerificationWire {
  return {
    trigger: 'system',
    verifiedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
    verifiedAt: '2026-10-20T08:00:05.000Z',
    passed: true,
    sourceFound: true,
    items: [{ ordinal: 1, kind: 'ontology_version', state: 'in_effect' }],
    requirements: [],
    ...patch,
  };
}

const OPERATION_TARGET = {
  gatekeeperId: 'gk-1',
  gatekeeperName: 'docker-a',
  name: 'container.restart',
};

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

  it('a Skill or Worker item names its kind with a space on each side of the Latin word', async () => {
    const segmentId = FIRST;
    const http = scriptedHttp({
      get_workspace: () => ({
        ...OWNER_WORKSPACE,
        caller: { ...OWNER_WORKSPACE.caller, role: 'member' },
      }),
      list_change_segments: () => ({ items: [segment(segmentId)] }),
      get_change_segment: () => ({
        segment: segment(segmentId, {
          source: { kind: 'pack', name: 'ops-base', version: '1', digest: 'sha256:x' },
        }),
        items: [
          {
            id: 'item-skill',
            ordinal: 1,
            kind: 'skill_version',
            classification: 'not_widening',
            widening: [],
            confirmedBy: null,
            state: 'in_effect',
            replacedBy: null,
            target: { skillId: 'skill-1', name: 'docker-triage' },
            before: null,
            after: { version: 1, contentDigest: 'sha256:s' },
          },
        ],
        verification: null,
      }),
    });
    renderTab(http, segmentId);

    const item = await screen.findByTestId('catalog-change-item-1');
    expect(item.textContent).toContain(
      '能力包 v1 带来的 Skill 版本（与能力包版本分开编号）：未安装 → 第 1 版',
    );
  });

  it('a record shows its latest verification: who ran it and how, what is no longer in effect, and each system with its gates (P1-E)', async () => {
    const http = scriptedHttp({
      get_workspace: () => ({
        ...OWNER_WORKSPACE,
        caller: { ...OWNER_WORKSPACE.caller, role: 'member' },
      }),
      list_change_segments: () => ({ items: [segment(FIRST, { status: 'verification_failed' })] }),
      get_change_segment: () => ({
        ...detail(FIRST, { state: 'replaced' }, { status: 'verification_failed' }),
        verification: verification({
          passed: false,
          items: [{ ordinal: 1, kind: 'ontology_version', state: 'replaced' }],
          requirements: [
            {
              connector: 'docker',
              state: 'connected',
              met: false,
              gates: [{ id: 'gk-1', name: 'docker-a', health: 'unreachable' }],
            },
            { connector: 'ragflow', state: 'can_connect', met: false, gates: [] },
          ],
        }),
      }),
    });
    renderTab(http, FIRST);

    const result = await screen.findByTestId('catalog-change-verification-result');
    expect(within(result).getByTestId('catalog-change-verification-status').textContent).toBe(
      '核验未通过',
    );
    expect(result.textContent).toMatch(/安装后自动核验（记在 Owner 名下）/);
    expect(within(result).getByTestId('catalog-change-verification-item-1').textContent).toBe(
      '本体 ops-assets已被后来的改动替换',
    );
    const docker = within(result).getByTestId('catalog-change-requirement-docker');
    expect(docker.textContent).toMatch(/docker已接入但没有一个能连通/);
    expect(
      within(docker)
        .getByTestId('catalog-change-requirement-docker-gate-gk-1')
        .getAttribute('href'),
    ).toBe('#/govern/systems/gk-1');
    expect(docker.textContent).toMatch(/docker-a不可达/);
    expect(within(result).getByTestId('catalog-change-requirement-ragflow').textContent).toMatch(
      /待接入工作区还没接入：所有者可以在「系统与授权」里自行接入。去「系统与授权」/,
    );
    // A member reads it but is not offered the run.
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('catalog-change-verify')).toBeNull());
  });

  it('the owner verifies a record; right after, the button waits out the cooldown', async () => {
    let verified: ChangeVerificationWire | null = null;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_change_segments: () => ({ items: [segment(FIRST)] }),
      get_change_segment: () => ({
        ...detail(FIRST, {}, verified ? { status: 'verified' } : {}),
        verification: verified,
      }),
      verify_change_segment: () => {
        verified = verification({ trigger: 'manual', verifiedAt: new Date().toISOString() });
        return { segment: segment(FIRST, { status: 'verified' }), verification: verified };
      },
    });
    renderTab(http, FIRST);

    expect((await screen.findByTestId('catalog-change-verification-none')).textContent).toBe(
      '还没有核验过。',
    );
    const run = screen.getByTestId('catalog-change-verify') as HTMLButtonElement;
    expect(run.textContent).toBe('核验');
    fireEvent.click(run);
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'verify_change_segment')).toEqual([
        { name: 'verify_change_segment', params: { segmentId: FIRST } },
      ]),
    );
    const result = await screen.findByTestId('catalog-change-verification-result');
    expect(result.textContent).toMatch(/Owner 手动核验/);
    expect(result.textContent).toMatch(/这次写入的改动项都还在生效。/);
    expect(result.textContent).toMatch(/这个能力包没有写明要用到的系统。/);
    const again = screen.getByTestId('catalog-change-verify') as HTMLButtonElement;
    expect(again.textContent).toBe('再核验一次');
    expect(again.disabled).toBe(true);
    expect(screen.getByTestId('catalog-change-verify-cooldown').textContent).toMatch(
      /^刚核验过，\d+ 秒后可以再核验。$/,
    );
  });

  it('a superseded record says which one to verify instead', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_change_segments: () => ({ items: [segment(LATER), segment(FIRST)] }),
      get_change_segment: () => detail(FIRST),
      verify_change_segment: () => {
        throw new HttpError('capability_error', 'superseded', 'change_segment_superseded', {
          supersededBy: LATER,
        });
      },
    });
    renderTab(http, FIRST);

    fireEvent.click(await screen.findByTestId('catalog-change-verify'));
    expect((await screen.findByTestId('catalog-change-verify-error')).textContent).toMatch(
      /现在生效的是那条安装记录；请核验那一条/,
    );
    expect(screen.getByTestId('catalog-change-verify-later').getAttribute('href')).toBe(
      `#/govern/catalog/changes/${LATER}`,
    );
  });

  it('an Operation item shows the approval settings it changed; its rollback publishes them again, or waits on a pending revision', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_change_segments: () => ({ items: [segment(FIRST)] }),
      get_change_segment: () => ({
        segment: segment(FIRST),
        items: [
          {
            id: 'item-op',
            ordinal: 1,
            kind: 'operation_version',
            classification: 'authority_widening',
            widening: [{ path: 'operation.auto_approvable', reason: 'loosened' }],
            confirmedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
            state: 'in_effect',
            replacedBy: null,
            target: OPERATION_TARGET,
            before: { version: 1, contentDigest: 'sha256:1' },
            after: { version: 2, contentDigest: 'sha256:2' },
            fields: [
              { field: 'auto_approvable', before: false, after: true },
              { field: 'blast_radius', before: 'high', after: 'medium' },
              { field: 'writes', before: ['Container'], after: [] },
            ],
          },
        ],
        verification: null,
      }),
      preview_roll_back_change_segment: () => ({
        segment: segment(FIRST),
        possible: true,
        items: [
          {
            ordinal: 1,
            kind: 'operation_version',
            target: OPERATION_TARGET,
            from: { version: 2, contentDigest: 'sha256:2' },
            to: { version: 1, contentDigest: 'sha256:1' },
            classification: 'not_widening',
            widening: [],
            blocker: null,
            blockedBy: null,
            conflicts: [],
          },
        ],
        inUse: { objects: 0, links: 0, capped: false },
      }),
    });
    renderTab(http, FIRST);

    const item = await screen.findByTestId('catalog-change-item-1');
    expect(item.textContent).toContain('Operation container.restart（门 docker-a）');
    expect(item.textContent).toContain(
      '能力包 v2 带来的 Operation 版本（与能力包版本分开编号）：第 1 版 → 第 2 版',
    );
    expect(screen.getByTestId('catalog-change-item-1-fields').textContent).toBe(
      '是否可自动批准：否 → 是影响级：高影响 → 中影响写入的资源：Container → 无',
    );
    expect(item.textContent).toMatch(
      /改变了权限边界：Operation 改为可自动批准（Owner 已逐项确认）/,
    );

    fireEvent.click(screen.getByTestId('catalog-change-rollback-trigger'));
    const preview = await screen.findByTestId('catalog-change-preview-1');
    expect(preview.textContent).toBe(
      'Operation container.restart（门 docker-a）：第 2 版 → 第 1 版撤销会把第 1 版的审批设置作为新的一版重新发布；停用的版本不会再启用。',
    );
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
            { path: 'operation', reason: 'added' as const },
            { path: 'operation.await_decision', reason: 'loosened' as const },
            { path: 'operation.description', reason: 'changed' as const },
            { path: 'operation.mode', reason: 'loosened' as const },
          ]
            .map((w) => wideningText(w, t))
            .join(' | ')}
        </p>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe(
      '新增这个 Skill：挂载它的 Worker 会读到它的全文 | Skill 正文有改动 | Worker 挂载的 Skill 增加 | Worker 禁止访问的地址减少 | Worker 字段 extra：无法识别 | 新增这个 Operation：助手可以请求调用它 | Operation 不再等审批结果 | Operation 说明有改动 | Operation 模式放宽',
    );
  });
});
