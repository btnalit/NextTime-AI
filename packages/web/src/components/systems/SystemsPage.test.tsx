// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { GrantRow, PrincipalRow } from '../../lib/governance.js';
import { HttpError } from '../../lib/http-client.js';
import { governanceFields } from '../connect/governance-fixtures.test-helpers.js';
import { comboboxOptionTexts, openCombobox } from '../kit/combobox.test-helpers.js';
import { SystemsPage } from './SystemsPage.js';

afterEach(cleanup);

function workspace(role: string, id = 'p-self') {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id, role, displayName: 'Self', kind: 'human' },
  };
}

function readiness(overrides: Partial<ExecutionReadinessWire> = {}): ExecutionReadinessWire {
  return {
    principalId: 'p-self',
    ready: false,
    missing: [],
    gates: [],
    workers: [],
    ...overrides,
  };
}

function gate(overrides: Partial<ExecutionReadinessWire['gates'][number]> = {}) {
  return {
    gateId: 'gk-1',
    name: 'Docker prod',
    granted: true,
    publishedOperationCount: 3,
    observeOperationCount: 2,
    executeOperationCount: 1,
    disabledOperations: [],
    definitionMismatch: [],
    excludedByPolicy: false,
    excludedByProfile: false,
    inEntryScope: true,
    workerDefinitionIds: ['wd-1'],
    status: 'direct' as const,
    ...overrides,
  };
}

function principal(overrides: Partial<PrincipalRow> = {}): PrincipalRow {
  return {
    id: 'p-2',
    kind: 'human',
    role: 'member',
    displayName: 'Bob',
    createdAt: '2026-09-01T00:00:00.000Z',
    hasApiKey: false,
    ...overrides,
  };
}

function grant(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'grant-1',
    principalId: 'p-2',
    resourceType: 'gatekeeper',
    resourceId: 'gk-1',
    status: 'active',
    grantedBy: 'p-self',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    get_workspace: () => workspace('owner'),
    list_connection_requests: () => ({ items: [] }),
    list_available_gate_instances: () => ({ items: [] }),
    list_operations: (params) => {
      const gatekeeperId = (params as { gatekeeperId?: string }).gatekeeperId;
      return { items: gatekeeperId ? [] : [] };
    },
    list_principals: () => ({ items: [] }),
    list_grants: () => ({ items: [] }),
    // Legacy 716: an owner's page reads it for the 换地址待审批 marks.
    list_gatekeepers: () => ({ items: [] }),
    execution_readiness: () => readiness({ principalId: 'p-self' }),
    resolve_refs: () => ({ items: [] }),
    ...handlers,
  };
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = base[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function renderPage(http: CapabilityCaller, platformAdmin = false, trialWorkspace = false) {
  return render(
    <PermissionsProvider>
      <SystemsPage http={http} platformAdmin={platformAdmin} trialWorkspace={trialWorkspace} />
    </PermissionsProvider>,
  );
}

/** A Gatekeeper as `list_gatekeepers` lists it (legacy 716 adds the owner's mark to it). */
function listedGate(id: string, name: string) {
  return {
    id,
    name,
    kind: 'http',
    status: 'active',
    operationCount: 3,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

/** A connection request row as `list_connection_requests` returns it. */
function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cr-1',
    status: 'requested',
    kind: 'http',
    target: 'https://inventory.example.com',
    requestedBy: 'p-2',
    gatekeeperId: null,
    completedBy: null,
    requestedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

/** A workspace Gatekeeper linked to the platform instance `stock`. */
const LINKED_STOCK_INSTANCE = {
  gateId: 'stock',
  displayName: '库存',
  connector: 'openapi',
  transportKind: 'http',
  status: 'enabled',
  health: 'ok',
  operationCount: 2,
  gatekeeperId: 'gk-1',
};

/** Radix `DropdownMenu`'s trigger opens on `onPointerDown` under jsdom — plain `fireEvent.click`
 *  leaves it closed (same as `ConnectionsPage.test.tsx`'s own note before this lane). */
function openConnectMoreMenu(): void {
  fireEvent.pointerDown(screen.getByTestId('connect-system-more'), { button: 0 });
}

/** Legacy 456: the platform's adopted manifest for `stock`, `stock.adjust` tightened in it. */
function driftPreview(adjustAligned = false) {
  const adjust = governanceFields({
    mode: 'execute',
    blastRadius: 'medium',
    autoApprovable: false,
  });
  return {
    gateId: 'stock',
    wouldLink: null,
    ambiguousCandidates: [],
    operationsToImport: [],
    operationsAlreadyPresent: [
      {
        name: 'stock.adjust',
        existing: {
          ...(adjustAligned
            ? adjust
            : governanceFields({ mode: 'execute', blastRadius: 'low', autoApprovable: true })),
          status: 'published',
        },
        announced: adjust,
        differs: !adjustAligned,
        definitionDiffers: false,
        direction: adjustAligned ? 'neutral' : 'tightened',
      },
      {
        name: 'stock.get',
        existing: {
          ...governanceFields({ mode: 'observe', blastRadius: 'low', autoApprovable: true }),
          status: 'published',
        },
        announced: governanceFields({ mode: 'observe', blastRadius: 'low', autoApprovable: true }),
        differs: false,
        definitionDiffers: false,
        direction: 'neutral',
      },
    ],
    manifestDigest: 'digest-stock',
    awaitingPlatformAdoption: null,
  };
}

describe('SystemsPage', () => {
  it('empty state: no system yet points at the one "接入一个系统" action in the header', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ principalId: 'p-self', missing: [{ code: 'no_enabled_gate' }] }),
    });
    renderPage(http);
    const empty = await screen.findByTestId('systems-empty');
    expect(empty.textContent).toContain('还没有接入任何系统');
    // Audit P1-16: one primary button on the page, not a second copy inside the empty state.
    expect(within(empty).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByTestId('connect-system-button'));
    const drawer = await screen.findByTestId('connect-system-drawer');
    expect(within(drawer).getByTestId('connect-system-launcher')).toBeTruthy();
  });

  it('P1-16: with instances waiting to be enabled, the empty state says so instead of "nothing connected"', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ principalId: 'p-self', missing: [{ code: 'no_enabled_gate' }] }),
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'docker',
            displayName: 'Docker',
            connector: 'docker',
            transportKind: 'cli',
            status: 'available',
            health: 'ok',
            operationCount: 3,
            gatekeeperId: null,
          },
        ],
      }),
    });
    renderPage(http);
    const empty = await screen.findByTestId('systems-empty');
    await waitFor(() => expect(empty.textContent).toContain('有 1 个系统已就绪，等待启用'));
    expect(empty.textContent).not.toContain('还没有接入任何系统');
    expect(within(empty).getByTestId('systems-empty-see-available')).toBeTruthy();
  });

  it('#541 acceptance: an auditor gets a read-only page — no readiness read, no 接入一个系统, no 录入我的凭证', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('auditor'),
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'gate-1',
            displayName: 'Docker prod',
            status: 'active',
            health: 'healthy',
            operationCount: 3,
            connector: 'docker',
            transportKind: 'http',
            target: 'docker-prod',
            trust: 'platform',
            gatekeeperId: 'gk-1',
          },
        ],
      }),
    });
    renderPage(http);
    expect((await screen.findByTestId('systems-read-only')).textContent).toContain('只读');
    await waitFor(() => expect(screen.getByText('Docker prod')).toBeTruthy());
    expect(screen.queryByTestId('connect-system-button')).toBeNull();
    expect(screen.queryByText('录入我的凭证')).toBeNull();
    expect(screen.queryByText('连接申请')).toBeNull();
    expect(http.calls.some((call) => call.name === 'execution_readiness')).toBe(false);
  });

  it('#541 review: a member is told an owner enables the waiting systems, not to enable them', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('member'),
      execution_readiness: () =>
        readiness({ principalId: 'p-self', missing: [{ code: 'no_enabled_gate' }] }),
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'docker',
            displayName: 'Docker',
            connector: 'docker',
            transportKind: 'cli',
            status: 'available',
            health: 'ok',
            operationCount: 3,
            gatekeeperId: null,
          },
          {
            gateId: 'ragflow',
            displayName: 'RagFlow',
            connector: 'ragflow',
            transportKind: 'http',
            status: 'available',
            health: 'ok',
            operationCount: 2,
            gatekeeperId: 'gk-already-enabled',
          },
        ],
      }),
    });
    renderPage(http);
    const empty = await screen.findByTestId('systems-empty');
    // Only the instance not enabled yet counts.
    await waitFor(() =>
      expect(empty.textContent).toContain('有 1 个系统已就绪，等工作区所有者启用'),
    );
    expect(empty.textContent).toContain('请联系工作区所有者');
    expect(empty.textContent).not.toContain('等待启用');
  });

  it('P0-4: an admin with a discovered but not enabled instance is told so and linked to enable it', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({
        items: [
          {
            gateId: 'gate-mcp-1',
            connector: 'fixture-mcp',
            displayName: 'Fixture MCP',
            transportKind: 'mcp',
            target: 'http://mcp.example.invalid',
            endpoint: 'http://gate.example.invalid',
            status: 'discovered',
            trust: 'byo',
            health: 'ok',
            lastSeenAt: null,
            lastCheckedAt: null,
            operationCount: 2,
            enabledWorkspaces: [],
          },
        ],
      }),
    });
    render(
      <PermissionsProvider>
        <SystemsPage http={http} platformAdmin />
      </PermissionsProvider>,
    );
    const empty = await screen.findByTestId('available-gates-empty');
    await waitFor(() => expect(empty.textContent).toContain('1 个门实例还没启用'));
    expect(screen.getByTestId('available-gates-enable-link').getAttribute('href')).toBe(
      '#/platform/integrations/gate-mcp-1',
    );
  });

  it('legacy 153 ⑥: when every instance on the platform is offline it says so, not "no instance yet"', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({
        items: [
          {
            gateId: 'gate-lost-1',
            connector: 'fixture-mcp',
            displayName: 'Fixture MCP',
            transportKind: 'mcp',
            target: 'http://mcp.example.invalid',
            endpoint: 'http://gate.example.invalid',
            status: 'lost',
            trust: 'byo',
            health: 'unreachable',
            lastSeenAt: null,
            lastCheckedAt: null,
            operationCount: 2,
            enabledWorkspaces: [],
          },
        ],
      }),
    });
    render(
      <PermissionsProvider>
        <SystemsPage http={http} platformAdmin />
      </PermissionsProvider>,
    );
    const empty = await screen.findByTestId('available-gates-empty');
    await waitFor(() => expect(empty.textContent).toContain('1 个门实例都离线了'));
    expect(empty.textContent).not.toContain('还没有任何门实例');
    expect(screen.getByTestId('available-gates-lost-link').getAttribute('href')).toBe(
      '#/platform/integrations/gate-lost-1',
    );
  });

  it('P0-4: a non-admin is told who has to enable an instance', async () => {
    renderPage(scriptedHttp({}));
    const empty = await screen.findByTestId('available-gates-empty');
    expect(empty.textContent).toContain('请联系平台管理员');
  });

  it('bugfix (PR #324 review): the selected 连接申请 filter tab renders its visible label (kit/tabs, not an invisible primary-button pill)', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    const tab = await screen.findByRole('tab', { name: '已申请' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.textContent?.trim()).not.toBe('');
    expect(tab.textContent).toContain('已申请');
    const allTab = screen.getByRole('tab', { name: '全部' });
    expect(allTab.getAttribute('aria-selected')).toBe('false');
  });

  it('legacy sweep (console batch, 2026-10-16): a connection request names its kind as SSH, not the raw ssh', async () => {
    const http = scriptedHttp({
      list_connection_requests: () => ({
        items: [
          {
            id: 'cr-1',
            status: 'requested',
            kind: 'ssh',
            target: 'ops@build-01',
            requestedBy: 'p-2',
            gatekeeperId: null,
            completedBy: null,
            requestedAt: '2026-09-01T00:00:00.000Z',
            completedAt: null,
          },
        ],
      }),
    });
    renderPage(http);
    const row = await screen.findByTestId('request-row');
    expect(within(row).getByTestId('request-kind').textContent).toBe('SSH');
    expect(within(row).queryByText('ssh')).toBeNull();
  });

  it('legacy 247: a masked request address says it carried a credential, and the requester shows by name', async () => {
    const http = scriptedHttp({
      list_principals: () => ({
        items: [principal({ id: 'p-2', displayName: 'Bob' })],
      }),
      list_connection_requests: () => ({
        items: [
          {
            id: 'cr-1',
            status: 'requested',
            kind: 'http',
            target: '[redacted]',
            requestedBy: 'p-2',
            gatekeeperId: null,
            completedBy: null,
            requestedAt: '2026-09-01T00:00:00.000Z',
            completedAt: null,
          },
        ],
      }),
    });
    renderPage(http);
    const row = await screen.findByTestId('request-row');
    expect(within(row).getByTestId('request-target-masked').textContent).toContain('带有凭据');
    expect(within(row).queryByText('[redacted]')).toBeNull();
    await waitFor(() => expect(within(row).getByTestId('request-by').textContent).toContain('Bob'));
  });

  it('legacy 247 (#661 UX acceptance P3): completing a request names its requester in the form header', async () => {
    const http = scriptedHttp({
      list_principals: () => ({
        items: [principal({ id: 'p-2', displayName: 'Bob' })],
      }),
      mint_connection_secret: () => ({
        connectionSecret: `ntgc1_${'c'.repeat(32)}_${'d'.repeat(64)}`,
      }),
      list_connection_requests: () => ({
        items: [
          {
            id: 'cr-1',
            status: 'requested',
            kind: 'http',
            target: 'https://inventory.example.com',
            requestedBy: 'p-2',
            gatekeeperId: null,
            completedBy: null,
            requestedAt: '2026-09-01T00:00:00.000Z',
            completedAt: null,
          },
        ],
      }),
    });
    renderPage(http);
    const row = await screen.findByTestId('request-row');
    await waitFor(() => expect(within(row).getByTestId('request-by').textContent).toContain('Bob'));
    fireEvent.click(within(row).getByRole('button', { name: '完成' }));
    const drawer = await screen.findByTestId('complete-connection-drawer');
    expect(within(drawer).getByTestId('cc-requester').textContent).toBe('Bob');
  });

  it('legacy 247 (review #501 on #661): an address masked in place inside its path is still said to be hidden', async () => {
    const http = scriptedHttp({
      list_connection_requests: () => ({
        items: [
          {
            id: 'cr-2',
            status: 'requested',
            kind: 'http',
            target: 'https://api.example.com/hook/[redacted]/x',
            requestedBy: 'p-2',
            gatekeeperId: null,
            completedBy: null,
            requestedAt: '2026-09-01T00:00:00.000Z',
            completedAt: null,
          },
        ],
      }),
    });
    renderPage(http);
    const row = await screen.findByTestId('request-row');
    expect(within(row).getByTestId('request-target-masked')).toBeTruthy();
    expect(row.textContent).not.toContain('[redacted]');
  });

  it('owner view: shows every grantee with a reachability chip and reason, and wires grant + revoke', async () => {
    const http = scriptedHttp({
      execution_readiness: (params) => {
        const principalId = (params as { principalId?: string }).principalId ?? 'p-self';
        if (principalId === 'p-2') {
          return readiness({
            principalId: 'p-2',
            gates: [
              gate({
                status: 'unreachable',
                reason: 'excluded_by_profile',
              }),
            ],
          });
        }
        return readiness({
          principalId: 'p-self',
          ready: true,
          gates: [gate()],
          workers: [
            {
              definitionId: 'wd-1',
              version: 1,
              name: 'ops-runner',
              delegable: true,
              reachableGateCount: 1,
              blockedBy: [],
            },
          ],
        });
      },
      list_principals: () => ({
        items: [principal(), principal({ id: 'p-self', displayName: 'Alice', role: 'owner' })],
      }),
      list_grants: () => ({ items: [grant()] }),
      grant_capability: (params) => {
        expect(params).toEqual({
          principalId: 'p-2',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
        });
        return grant({ id: 'grant-2' });
      },
      revoke_capability: (params) => {
        expect(params).toEqual({ grantId: 'grant-1' });
        return grant({ status: 'revoked' });
      },
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    expect(card).toBeTruthy();

    // Ops summary from the baseline (self) readiness read.
    expect(within(card).getByTestId('gatekeeper-ops-summary').textContent).toContain(
      '2 个只读操作',
    );
    expect(within(card).getByTestId('gatekeeper-ops-summary').textContent).toContain('1 个写操作');

    // Reachability for me (the owner, self) renders inline on the row — no drawer needed.
    expect(within(card).getByTestId('gatekeeper-reachability').textContent).toContain(
      '你：可直接调用',
    );

    // 谁能用 / 哪些 Worker 覆盖 (console redesign P3-3 V5): behind the row's own summary button,
    // opened as a `kit/sheet` drawer instead of always expanded on the card.
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');

    // 谁能用: Bob's row shows the unreachable chip and the excluded-by-profile reason text.
    const list = within(drawer).getByTestId('system-access-list');
    await waitFor(() => expect(within(list).getByText('Bob')).toBeTruthy());
    const row = within(list).getByTestId('system-access-row');
    expect(row.textContent).toContain('用不了');
    expect(row.textContent).toContain('取消了勾选');

    // 哪些 Worker 覆盖.
    expect(within(drawer).getByTestId('system-worker-coverage').textContent).toContain(
      'ops-runner',
    );

    // Revoke: Bob's existing grant.
    fireEvent.click(within(row).getByTestId('gatekeeper-revoke-grant-1'));
    const confirm = await screen.findByTestId('gatekeeper-revoke-confirm-grant-1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_capability')).toBe(true),
    );

    // Grant: opens the shared drawer locked to this gate.
    fireEvent.click(within(card).getByTestId('gatekeeper-grant-button'));
    const grantDrawer = await screen.findByTestId('grant-gate-drawer');
    const form = within(grantDrawer).getByTestId('grant-gate-form');
    expect(within(form).getByTestId('ggf-locked-gate-chip').textContent).toContain('Docker prod');
  });

  it('host v0.63.0: the grant drawer marks the members who already hold this gate as 已授权, so nobody is granted twice', async () => {
    const http = scriptedHttp({
      execution_readiness: (params) =>
        readiness({
          principalId: (params as { principalId?: string }).principalId ?? 'p-self',
          ready: true,
          gates: [gate()],
        }),
      list_principals: () => ({
        items: [principal(), principal({ id: 'p-self', displayName: 'Alice', role: 'owner' })],
      }),
      // Bob (p-2) holds this gate already.
      list_grants: () => ({ items: [grant()] }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(card).getByTestId('system-access-summary').textContent).toContain('Bob'),
    );
    fireEvent.click(within(card).getByTestId('gatekeeper-grant-button'));
    const grantDrawer = await screen.findByTestId('grant-gate-drawer');
    const member = within(grantDrawer).getByTestId('ggf-member');
    openCombobox(member);
    await waitFor(() => expect(comboboxOptionTexts(member)).toHaveLength(2));
    expect(comboboxOptionTexts(member)).toContain('Bob成员 · 已授权');
    expect(comboboxOptionTexts(member).some((text) => text.startsWith('Alice'))).toBe(true);
    expect(
      comboboxOptionTexts(member).some((text) => text.includes('Alice') && text.includes('已授权')),
    ).toBe(false);
  });

  it('R-39: an operator grantee is marked as also an approver, and revoking says the approval right goes too', async () => {
    const http = scriptedHttp({
      execution_readiness: (params) =>
        readiness({
          principalId: (params as { principalId?: string }).principalId ?? 'p-self',
          ready: true,
          gates: [gate()],
        }),
      list_principals: () => ({
        items: [
          principal({ role: 'operator' }),
          principal({ id: 'p-self', displayName: 'Alice', role: 'owner' }),
        ],
      }),
      list_grants: () => ({ items: [grant()] }),
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    expect(within(drawer).getByTestId('system-access-approver-hint').textContent).toContain(
      '所有动作的审批者',
    );

    const list = within(drawer).getByTestId('system-access-list');
    await waitFor(() => expect(within(list).getByText('Bob')).toBeTruthy());
    const row = within(list).getByTestId('system-access-row');
    expect(within(row).getByTestId('system-access-approver-tag').textContent).toContain(
      '也是审批者',
    );

    fireEvent.click(within(row).getByTestId('gatekeeper-revoke-grant-1'));
    const confirm = await screen.findByTestId('gatekeeper-revoke-confirm-grant-1');
    expect(confirm.textContent).toContain('也不再是这个门上动作的审批者');
  });

  it('member view: a 403 on list_grants/list_principals degrades to the caller’s own row, no grant/revoke actions', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('member'),
      list_principals: () =>
        Promise.reject(new HttpError('capability_error', 'operator only', 'forbidden')),
      list_grants: () =>
        Promise.reject(new HttpError('capability_error', 'operator only', 'forbidden')),
      execution_readiness: () => readiness({ principalId: 'p-self', ready: true, gates: [gate()] }),
      resolve_refs: () => ({ items: [{ id: 'p-self', kind: 'principal', name: 'Self' }] }),
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    // Reachability for me renders inline on the row without opening the drawer.
    expect(within(card).getByTestId('gatekeeper-reachability').textContent).toContain('可直接调用');

    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const list = within(drawer).getByTestId('system-access-list');
    const rows = within(list).getAllByTestId('system-access-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('你');
    expect(rows[0]?.textContent).toContain('可直接调用');

    expect(within(card).queryByTestId('gatekeeper-grant-button')).toBeNull();
    expect(within(drawer).queryByTestId(/^gatekeeper-revoke-/)).toBeNull();
  });

  it('接入向导 opens from the overflow menu (S8 W2-U1 SY3 kept)', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    await screen.findByTestId('systems-empty');
    openConnectMoreMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /接入向导/ }));
    const drawer = await screen.findByTestId('onboarding-wizard-drawer');
    expect(within(drawer).getByTestId('wizard-step-kind')).toBeTruthy();
  });

  it('bugfix (PR #324 review): an unreachable row keeps the reason as a chip tooltip, not inline text, drops the same-page fix-it link, and the drawer still spells it out with a real (different-page) link', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              status: 'unreachable',
              reason: 'not_granted',
              excludedByProfile: false,
            }),
          ],
        }),
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    const chip = within(card).getByTestId('gatekeeper-reachability');
    // The row stays terse: the chip itself carries the reason as a tooltip (`title`), not as
    // visible inline text or a link — `not_granted`'s fix-it link would point back at this exact
    // page anyway (系统与授权 already has the fix — the "授权" button right on this row).
    expect(chip.textContent).toBe('你：用不了');
    expect(chip.getAttribute('title')).toContain('还没有授权给你');
    expect(within(card).queryByRole('link', { name: /系统与授权/ })).toBeNull();

    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const detail = within(drawer).getByTestId('system-access-my-reachability');
    expect(detail.textContent).toContain('还没有授权给你');
    // Still no self-page link inside the drawer either — `not_granted`'s only listed fix-it
    // destination is this same page.
    expect(within(detail).queryByRole('link')).toBeNull();
  });

  it('legacy K (UX acceptance of #538): a gate refusing every call reads 「用不了」, never 「可直接调用」, and the drawer sends a platform admin to adopt the new manifest first', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              name: '库存',
              status: 'unreachable',
              reason: 'definition_mismatch',
              definitionMismatch: [{ operation: 'stock.get', awaiting: 'platform_adoption' }],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http, true);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    const chip = within(card).getByTestId('gatekeeper-reachability');
    expect(chip.textContent).toBe('你：用不了');
    expect(chip.getAttribute('title')).toContain('对它的调用正被拒绝');
    expect(card.textContent).not.toContain('可直接调用');
    // Every Operation is refused: the reachability chip says it, no second chip repeats it.
    expect(within(card).queryByTestId('gatekeeper-refused-operations')).toBeNull();

    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const notice = await within(drawer).findByTestId('system-definition-mismatch-adoption');
    expect(notice.textContent).toContain(
      '平台管理员还没采用。采用之前这里对齐不了，对 stock.get 的调用会被拒绝。',
    );
    await waitFor(() =>
      expect(
        within(drawer)
          .getByTestId('system-definition-mismatch-adoption-adopt-link')
          .getAttribute('href'),
      ).toContain('stock'),
    );
    expect(within(drawer).queryByTestId('system-definition-mismatch-revision')).toBeNull();
  });

  it('legacy 301: a gate that dropped every published Operation reads 「门已不再提供」 on the chip and in 「你的可达性」, not 「定义不一样」', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              name: '库存',
              status: 'unreachable',
              reason: 'definition_mismatch',
              definitionMismatch: [
                { operation: 'stock.get', awaiting: 'platform_adoption', droppedByGate: true },
                { operation: 'orders.cancel', awaiting: 'platform_adoption', droppedByGate: true },
              ],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http, true);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    const chip = within(card).getByTestId('gatekeeper-reachability');
    expect(chip.textContent).toBe('你：用不了');
    expect(chip.getAttribute('title')).toBe(
      '门已不再提供这个系统已发布的操作，对它们的调用正被拒绝。',
    );

    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const detail = within(drawer).getByTestId('system-access-my-reachability');
    expect(detail.textContent).toContain('门已不再提供这个系统已发布的操作');
    expect(detail.textContent).not.toContain('定义和已发布的不一样');
  });

  it('legacy 301: some dropped and some redefined — the chip says both', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              name: '库存',
              status: 'unreachable',
              reason: 'definition_mismatch',
              definitionMismatch: [
                { operation: 'stock.get', awaiting: 'platform_adoption' },
                { operation: 'orders.cancel', awaiting: 'platform_adoption', droppedByGate: true },
              ],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http, true);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    expect(within(card).getByTestId('gatekeeper-reachability').getAttribute('title')).toBe(
      '门已不再提供其中一些已发布的操作，其余运行的定义和已发布的不一样，对它们的调用正被拒绝。',
    );
  });

  it('UX acceptance of #579 (legacy 297): an Operation the gate dropped is said apart — adopting removes it, it never reads as coming back', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              name: '库存',
              status: 'unreachable',
              reason: 'definition_mismatch',
              definitionMismatch: [
                { operation: 'stock.get', awaiting: 'platform_adoption' },
                { operation: 'orders.cancel', awaiting: 'platform_adoption', droppedByGate: true },
              ],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http, true);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const notice = await within(drawer).findByTestId('system-definition-mismatch-adoption');
    // The redefined one waits on adoption; the dropped one is not in that line.
    expect(notice.textContent).toContain(
      '采用之前这里对齐不了，对 stock.get 的调用会被拒绝。门已经不再提供',
    );
    expect(
      within(notice).getByTestId('system-definition-mismatch-adoption-dropped').textContent,
    ).toBe(
      '门已经不再提供 orders.cancel，对它的调用会被拒绝，采用和对齐都恢复不了：采用后它会从清单里移除。',
    );
  });

  it('UX acceptance of #579 (legacy 297): when every refused Operation was dropped, nothing reads as waiting to come back', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              definitionMismatch: [
                { operation: 'orders.cancel', awaiting: 'platform_adoption', droppedByGate: true },
              ],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const notice = await within(drawer).findByTestId('system-definition-mismatch-adoption');
    expect(notice.textContent).not.toContain('采用之前');
    expect(notice.textContent).toContain('平台管理员还没采用。门已经不再提供');
  });

  it('legacy K: a gate refusing some Operations keeps its status but flags them, and the drawer names the workspace step', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              definitionMismatch: [{ operation: 'stock.get', awaiting: 'workspace_revision' }],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    expect(within(card).getByTestId('gatekeeper-refused-operations').textContent).toBe(
      '1 个 Operation 调用被拒',
    );
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const notice = within(drawer).getByTestId('system-definition-mismatch-revision');
    expect(notice.textContent).toContain(
      '门已经按新定义运行，对 stock.get 的调用会被拒绝，直到这个工作区对齐并发布修订。',
    );
    // The owner can do it here.
    expect(notice.textContent).toContain('点下面的「与门公告对齐」');
    expect(within(drawer).queryByTestId('system-definition-mismatch-adoption')).toBeNull();
  });

  it('review #501 on #583: the refused-calls chip names an Operation the gate dropped as no longer provided, not as running another definition', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              definitionMismatch: [
                { operation: 'stock.get', awaiting: 'workspace_revision' },
                { operation: 'orders.cancel', awaiting: 'platform_adoption', droppedByGate: true },
              ],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    const chip = within(card).getByTestId('gatekeeper-refused-operations');
    expect(chip.textContent).toBe('2 个 Operation 调用被拒');
    expect(chip.getAttribute('title')).toBe(
      ['门运行的定义和已发布的不一样：', 'stock.get', '；门已不再提供：', 'orders.cancel'].join(''),
    );
  });

  it('UX acceptance of #573 P2: a refused Operation whose running definition declares a gate-owned param is said to wait on the gate, not on an align', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              definitionMismatch: [
                {
                  operation: 'stock.get',
                  awaiting: 'workspace_revision',
                  gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
                },
                { operation: 'stock.put', awaiting: 'workspace_revision' },
              ],
            }),
          ],
        }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const held = within(drawer).getByTestId('system-definition-mismatch-gate-owned');
    expect(held.textContent).toContain('stock.get：Authorization（请求头）');
    expect(held.textContent).toContain('对齐也恢复不了这些调用');
    const revision = within(drawer).getByTestId('system-definition-mismatch-revision');
    expect(revision.textContent).toContain('对 stock.put 的调用会被拒绝');
    expect(revision.textContent).not.toContain('stock.get');
  });

  // R-01 (maintainer decision D-01): a gate the workspace connected itself (no catalog link) gets
  // its own connection secret; the owner issues a new one from the row's menu, shown once.
  it('lets the owner issue a new connection secret for a self-connected gate, and shows it once', async () => {
    const secret = `ntgc1_${'c'.repeat(32)}_${'d'.repeat(64)}`;
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      get_gatekeeper: () => ({ id: 'gk-1', name: '库存', endpoint: 'http://gate-a:8090' }),
      rotate_connection_secret: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1' });
        return { gatekeeperId: 'gk-1', connectionSecret: secret };
      },
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    fireEvent.click(await screen.findByTestId('gatekeeper-rotate-secret'));
    const confirm = await screen.findByTestId('gatekeeper-rotate-secret-confirm');
    expect(confirm.textContent).toContain('旧密钥立即失效');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_gatekeeper')).toBe(true));
    expect(confirm.textContent).not.toContain('更换地址申请');
    expect(http.calls.some((c) => c.name === 'rotate_connection_secret')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: '签发' }));
    const sheet = await screen.findByTestId('gatekeeper-rotated-secret');
    expect(within(sheet).getByTestId('connection-secret-value').textContent).toBe(secret);
    // Legacy 711: a rotation's secret is bound to its gate at once — no 24-hour window to say.
    expect(within(sheet).queryByTestId('connection-secret-expiry')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: '我已复制' }));
    await waitFor(() => expect(screen.queryByTestId('connection-secret-value')).toBeNull());
  });

  // Review #501 of #1156: approving a move gives the gate the secret made for the move, so a
  // secret issued while it waits stops working then — the confirm says so before it is issued.
  it('legacy 701: issuing a new secret while a move waits for approval says the move replaces it', async () => {
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      get_gatekeeper: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1' });
        return {
          id: 'gk-1',
          name: '库存',
          endpoint: 'http://gate-a:8090',
          pendingAddressChange: {
            id: 'gac-1',
            gatekeeperId: 'gk-1',
            fromEndpoint: 'http://gate-a:8090',
            toEndpoint: 'https://gate-b.example.com',
            status: 'proposed',
          },
        };
      },
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    // Nothing is read for it until the confirm opens.
    expect(http.calls.some((c) => c.name === 'get_gatekeeper')).toBe(false);
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    fireEvent.click(await screen.findByTestId('gatekeeper-rotate-secret'));
    const confirm = await screen.findByTestId('gatekeeper-rotate-secret-confirm');
    await waitFor(() =>
      expect(confirm.textContent).toContain(
        '这个门有一个等平台管理员批准的更换地址申请（换到 https://gate-b.example.com）',
      ),
    );
    expect(confirm.textContent).toContain('这次签发的密钥随之作废');
    expect(http.calls.some((c) => c.name === 'rotate_connection_secret')).toBe(false);
  });

  // Review #501 of #1158: 签发 waits for that read, so the line is there before the secret is
  // issued; a read that fails says it could not tell, and does not hold the rotation up.
  it('legacy 701: 签发 waits for the read of a waiting move; a failed read says it could not tell', async () => {
    let answer: (value: unknown) => void = () => {};
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      get_gatekeeper: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    fireEvent.click(await screen.findByTestId('gatekeeper-rotate-secret'));
    const confirm = await screen.findByTestId('gatekeeper-rotate-secret-confirm');
    const issue = () => within(confirm).getByRole('button', { name: '签发' }) as HTMLButtonElement;
    expect(confirm.textContent).toContain('正在确认这个门有没有等平台管理员批准的更换地址申请');
    expect(issue().disabled).toBe(true);
    answer({ id: 'gk-1', name: '库存', endpoint: 'http://gate-a:8090' });
    await waitFor(() => expect(issue().disabled).toBe(false));
    expect(confirm.textContent).not.toContain('更换地址申请');
    cleanup();

    const failing = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      get_gatekeeper: () => {
        throw new HttpError('network', 'offline');
      },
    });
    renderPage(failing);
    const again = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(again).getByTestId('gatekeeper-more'), { button: 0 });
    fireEvent.click(await screen.findByTestId('gatekeeper-rotate-secret'));
    const failed = await screen.findByTestId('gatekeeper-rotate-secret-confirm');
    await waitFor(() =>
      expect(failed.textContent).toContain('没能确认这个门有没有等批准的更换地址申请'),
    );
    expect(
      (within(failed).getByRole('button', { name: '签发' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  // Review #501 of #1158 (P3): opened again, the confirm finds the earlier read cached — it still
  // waits for the fresh one, and a fresh read that fails says it could not tell.
  it('legacy 701: opened again, 签发 waits for a fresh read, not the cached one', async () => {
    let reads = 0;
    let fail: (error: unknown) => void = () => {};
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      get_gatekeeper: () => {
        reads += 1;
        if (reads === 1) return { id: 'gk-1', name: '库存', endpoint: 'http://gate-a:8090' };
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      },
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    const openConfirm = async () => {
      fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
      fireEvent.click(await screen.findByTestId('gatekeeper-rotate-secret'));
      return screen.findByTestId('gatekeeper-rotate-secret-confirm');
    };
    const first = await openConfirm();
    const issueIn = (confirm: HTMLElement) =>
      within(confirm).getByRole('button', { name: '签发' }) as HTMLButtonElement;
    await waitFor(() => expect(issueIn(first).disabled).toBe(false));
    fireEvent.click(within(first).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByTestId('gatekeeper-rotate-secret-confirm')).toBeNull(),
    );

    const second = await openConfirm();
    await waitFor(() => expect(reads).toBe(2));
    expect(second.textContent).toContain('正在确认这个门有没有等平台管理员批准的更换地址申请');
    expect(issueIn(second).disabled).toBe(true);
    fail(new HttpError('network', 'offline'));
    await waitFor(() =>
      expect(second.textContent).toContain('没能确认这个门有没有等批准的更换地址申请'),
    );
    expect(issueIn(second).disabled).toBe(false);
  });

  // Review #501 of #1158: both act for the owner only (rotate_connection_secret and
  // propose_gate_address_change); a member's row menu has neither.
  it('legacy 701: a member sees neither 更换地址 nor 重新签发连接密钥 on a self-connected gate', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('member'),
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    await screen.findByRole('menuitem', { name: '健康与操作' });
    expect(screen.queryByTestId('gatekeeper-change-address')).toBeNull();
    expect(screen.queryByTestId('gatekeeper-rotate-secret')).toBeNull();
  });

  // Legacy 701: the same gates — the workspace connected them itself — move to a new address
  // through 「更换地址」, a proposal a platform administrator decides.
  it('legacy 701: the owner opens 更换地址 for a self-connected gate from the row’s menu', async () => {
    const secret = `ntgc1_${'e'.repeat(32)}_${'f'.repeat(64)}`;
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      get_gatekeeper: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1' });
        return { id: 'gk-1', name: '库存', endpoint: 'http://gate-a:8090', operations: [] };
      },
      mint_connection_secret: () => ({ connectionSecret: secret }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    fireEvent.click(await screen.findByTestId('gatekeeper-change-address'));
    const sheet = await screen.findByTestId('gate-address-change');
    expect((await within(sheet).findByTestId('connection-secret-value')).textContent).toBe(secret);
    expect(within(sheet).getByTestId('gate-address-change-current').textContent).toContain(
      'http://gate-a:8090',
    );
    // Nothing is proposed by opening it: the secret is minted, nothing else is written.
    expect(http.calls.some((c) => c.name.endsWith('_gate_address_change'))).toBe(false);
  });

  it('legacy 716: an owner’s card marks a gate whose move awaits approval, opens the move sheet from the mark, and reads the marks again once it closes', async () => {
    const pendingMove = {
      id: 'gac-1',
      gatekeeperId: 'gk-1',
      fromEndpoint: 'http://gate-a:8090',
      toEndpoint: 'https://gate-b.example.com',
      status: 'proposed',
      impact: {
        publishedOperationCount: 3,
        grantCount: 1,
        autoApprovedOperations: [],
        workerDefinitionCount: 1,
        inFlightActionRequestCount: 0,
      },
      previewDigest: 'p'.repeat(64),
      proposedBy: 'p-self',
      createdAt: '2026-11-13T00:00:00.000Z',
      expiresAt: '2026-11-14T00:00:00.000Z',
      decidedAt: null,
      rejectionReason: null,
    };
    let pending = true;
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [gate(), gate({ gateId: 'gk-2', name: 'CRM' })],
        }),
      list_gatekeepers: () => ({
        items: [
          { ...listedGate('gk-1', 'Docker prod'), addressChangePending: pending },
          { ...listedGate('gk-2', 'CRM'), addressChangePending: false },
        ],
      }),
      get_gatekeeper: () => ({
        id: 'gk-1',
        name: 'Docker prod',
        endpoint: 'http://gate-a:8090',
        operations: [],
        ...(pending ? { pendingAddressChange: pendingMove } : {}),
      }),
    });
    renderPage(http);
    const cards = await screen.findAllByTestId('gatekeeper-card');
    const card = (id: string) =>
      cards.find((element) => element.dataset.gatekeeperId === id) as HTMLElement;
    const mark = await within(card('gk-1')).findByTestId('gatekeeper-address-change-pending');
    expect(mark.textContent).toBe('换地址待审批');
    expect(within(card('gk-2')).queryByTestId('gatekeeper-address-change-pending')).toBeNull();

    // The mark opens the move sheet, where the proposal stands with 撤回.
    fireEvent.click(mark);
    const sheet = await screen.findByTestId('gate-address-change');
    expect((await within(sheet).findByTestId('gate-address-change-pending')).textContent).toContain(
      'https://gate-b.example.com',
    );

    // Decided meanwhile; the sheet closes, the marks are read again.
    pending = false;
    const reads = http.calls.filter((c) => c.name === 'list_gatekeepers').length;
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_gatekeepers').length).toBe(reads + 1),
    );
    await waitFor(() =>
      expect(within(card('gk-1')).queryByTestId('gatekeeper-address-change-pending')).toBeNull(),
    );
  });

  it('legacy 716: closing 「健康与操作」 reads the marks again (a proposal may have been withdrawn there)', async () => {
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      get_gatekeeper: () => ({ id: 'gk-1', name: 'Docker prod', operations: [], health: 'ok' }),
    });
    const onSelectGatekeeper = vi.fn();
    render(
      <PermissionsProvider>
        <SystemsPage
          http={http}
          platformAdmin={false}
          trialWorkspace={false}
          selectedGatekeeperId="gk-1"
          onSelectGatekeeper={onSelectGatekeeper}
        />
      </PermissionsProvider>,
    );
    const drawer = await screen.findByTestId('gatekeeper-detail-drawer');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'list_gatekeepers')).toBe(true));
    const reads = http.calls.filter((c) => c.name === 'list_gatekeepers').length;
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(onSelectGatekeeper).toHaveBeenCalledWith(null);
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_gatekeepers').length).toBe(reads + 1),
    );
  });

  it('legacy 716: a member’s page does not read the marks, and a card shows none', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('member'),
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      list_gatekeepers: () => {
        throw new Error('a member’s page reads no marks');
      },
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    expect(within(card).queryByTestId('gatekeeper-address-change-pending')).toBeNull();
    expect(http.calls.some((c) => c.name === 'list_gatekeepers')).toBe(false);
  });

  it('「发布清单」 publishes the drafts this page read; a draft changed since reads them again (review #493 on #592)', async () => {
    let reads = 0;
    const draftRow = (name: string, draftDigest: string) => ({
      gatekeeperId: 'gk-1',
      name,
      mode: 'observe',
      blastRadius: 'low',
      status: 'draft',
      origin: 'import',
      draftDigest,
    });
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      list_operations: () => {
        reads += 1;
        return { items: [draftRow('stock.get', reads === 1 ? 'd-1' : 'd-2')] };
      },
      publish_manifest: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          drafts: [{ name: 'stock.get', draftDigest: 'd-1' }],
        });
        return Promise.reject(
          new HttpError('capability_error', 'changed after it was read', 'draft_changed'),
        );
      },
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    const item = await screen.findByTestId('gatekeeper-publish-manifest');
    expect(item.textContent).toContain('(1)');
    fireEvent.click(item);
    await waitFor(() => expect(reads).toBe(2));
    expect(within(card).getByText(/这份草稿在你查看之后被修改过/)).toBeTruthy();
  });

  it('legacy 349: 「发布清单」 that would publish a first version which writes or is high impact confirms it first', async () => {
    const draftRow = (name: string, mode: string, blastRadius: string) => ({
      gatekeeperId: 'gk-1',
      name,
      mode,
      blastRadius,
      autoApprovable: false,
      status: 'draft',
      origin: 'import',
      draftDigest: `d-${name}`,
    });
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      list_operations: () => ({
        items: [
          draftRow('stock.get', 'observe', 'low'),
          draftRow('stock.adjust', 'execute', 'high'),
        ],
      }),
      publish_manifest: () => ({
        gatekeeperId: 'gk-1',
        publishedOperationNames: ['stock.get', 'stock.adjust'],
        skippedDraftOperationNames: [],
        gateOwnedParamDrafts: [],
        absentAnswerDrafts: [],
      }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    fireEvent.click(await screen.findByTestId('gatekeeper-publish-manifest'));
    const confirm = await screen.findByTestId('gatekeeper-publish-manifest-confirm');
    expect(confirm.textContent).toContain('将发布 2 个');
    expect(confirm.textContent).toContain('stock.adjust 会写入系统、影响高');
    expect(confirm.textContent).not.toContain('stock.get');
    expect(http.calls.some((c) => c.name === 'publish_manifest')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: '发布' }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_manifest')).toBe(true));
  });

  it('UX acceptance of #620 (P2-3) and legacy 385: a refused duplicate connection finds the card of the system already at that address, and focus moves to it', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [gate(), gate({ gateId: 'gk-2', name: 'Grafana 生产' })],
        }),
      mint_connection_secret: () => ({
        connectionSecret: `ntgc1_${'c'.repeat(32)}_${'d'.repeat(64)}`,
      }),
      create_connection: () => {
        throw new HttpError(
          'capability_error',
          'this workspace already has Gatekeeper "Grafana 生产" (gk-2) at endpoint "https://gate.example"',
          'endpoint_already_connected',
          { gatekeeperId: 'gk-2', gatekeeperName: 'Grafana 生产' },
        );
      },
    });
    renderPage(http);
    await screen.findAllByTestId('gatekeeper-card');
    openConnectMoreMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /直接注册门/ }));
    const drawer = await screen.findByTestId('complete-connection-drawer');
    await within(drawer).findByTestId('cc-connection-secret-reveal');
    fireEvent.change(within(drawer).getByLabelText(/目标系统/), { target: { value: 'grafana' } });
    fireEvent.change(within(drawer).getByLabelText(/门端点/), {
      target: { value: 'https://gate.example' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: '注册门' }));
    fireEvent.click(await within(drawer).findByTestId('cc-show-existing-gatekeeper'));

    await waitFor(() => expect(screen.queryByTestId('complete-connection-drawer')).toBeNull());
    const cards = screen.getAllByTestId('gatekeeper-card');
    const card = (id: string) => cards.find((element) => element.dataset.gatekeeperId === id);
    expect(card('gk-2')?.getAttribute('aria-current')).toBe('true');
    expect(card('gk-1')?.getAttribute('aria-current')).toBeNull();
    // Not handed back to the 更多接入方式 menu that opened the drawer.
    await waitFor(() => expect(document.activeElement).toBe(card('gk-2')));
  });

  it('UX acceptance of #620 (P2-3): a Gatekeeper with no card in the list opens its 健康与操作 drawer instead', async () => {
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      mint_connection_secret: () => ({
        connectionSecret: `ntgc1_${'c'.repeat(32)}_${'d'.repeat(64)}`,
      }),
      create_connection: () => {
        throw new HttpError('capability_error', 'already', 'endpoint_already_connected', {
          gatekeeperId: 'gk-9',
        });
      },
    });
    const onSelectGatekeeper = vi.fn();
    render(
      <PermissionsProvider>
        <SystemsPage http={http} onSelectGatekeeper={onSelectGatekeeper} />
      </PermissionsProvider>,
    );
    await screen.findAllByTestId('gatekeeper-card');
    openConnectMoreMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /直接注册门/ }));
    const drawer = await screen.findByTestId('complete-connection-drawer');
    await within(drawer).findByTestId('cc-connection-secret-reveal');
    fireEvent.change(within(drawer).getByLabelText(/目标系统/), { target: { value: 'x' } });
    fireEvent.change(within(drawer).getByLabelText(/门端点/), {
      target: { value: 'https://gate.example' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: '注册门' }));
    const find = await within(drawer).findByTestId('cc-show-existing-gatekeeper');
    // No name in `details`: the field and the button still work, without it.
    expect(find.textContent).toBe('在列表里找到它');
    fireEvent.click(find);
    await waitFor(() => expect(onSelectGatekeeper).toHaveBeenCalledWith('gk-9'));
  });

  it('offers no connection secret for a gate linked from the platform catalog', async () => {
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'docker',
            displayName: 'Docker',
            connector: 'docker',
            transportKind: 'cli',
            status: 'enabled',
            health: 'ok',
            operationCount: 3,
            gatekeeperId: 'gk-1',
          },
        ],
      }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    expect(await screen.findByText('健康与操作')).toBeTruthy();
    expect(screen.queryByTestId('gatekeeper-rotate-secret')).toBeNull();
    // Legacy 701: its address is the platform instance's, which the platform administrator changes.
    expect(screen.queryByTestId('gatekeeper-change-address')).toBeNull();
  });
  it('legacy 456: an owner sees on the row that a deployed operation is classified otherwise than the adopted manifest, and aligns it there', async () => {
    let aligned = false;
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ principalId: 'p-self', gates: [gate({ name: '库存' })] }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
      preview_gate_instance_enable: () => driftPreview(aligned),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          operationNames: ['stock.adjust'],
          manifestDigest: 'digest-stock',
        });
        aligned = true;
        return {
          gatekeeperId: 'gk-1',
          refreshed: [
            {
              name: 'stock.adjust',
              before: governanceFields({
                mode: 'execute',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'execute',
                blastRadius: 'medium',
                autoApprovable: false,
              }),
              direction: 'tightened',
            },
          ],
          revisionDrafts: [],
          unchanged: [],
        };
      },
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    const notice = await within(card).findByTestId('gatekeeper-governance-drift-notice');
    expect(notice.textContent).toMatch(
      /^1 个已部署的 Operation 分类与平台最新清单不一致，需对齐：/,
    );
    const items = within(notice).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toMatch(
      /^stock\.adjust：影响级 低影响 → 中影响；自动批准 可自动批准 → .+$/,
    );
    expect(notice.textContent).toMatch(
      /对齐之前，这个工作区仍按旧分类执行，收紧的部分还没有生效。/,
    );

    const previews = () =>
      http.calls.filter((call) => call.name === 'preview_gate_instance_enable').length;
    const before = previews();
    fireEvent.click(within(card).getByTestId('gatekeeper-governance-drift-align'));
    const confirm = await screen.findByTestId('gatekeeper-governance-drift-align-confirm');
    // The confirm shows what the row listed: the preview is not read again for it.
    expect(previews()).toBe(before);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'refresh_operation_governance')).toBe(true),
    );
    await waitFor(() =>
      expect(within(card).queryByTestId('gatekeeper-governance-drift-notice')).toBeNull(),
    );
    // UX P3 on #733: what was done is said in its place, and focus lands on it.
    const done = await within(card).findByTestId('gatekeeper-governance-aligned');
    expect(done.textContent).toBe('已对齐 1 个 Operation 的分类，现在按平台最新清单执行。');
    await waitFor(() => expect(document.activeElement).toBe(done.parentElement));
  });

  it('legacy 456: nothing is said when the deployed operations match, and a member never reads the preview', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ principalId: 'p-self', gates: [gate({ name: '库存' })] }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
      preview_gate_instance_enable: () => driftPreview(true),
    });
    renderPage(http);
    await screen.findAllByTestId('gatekeeper-card');
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'preview_gate_instance_enable')).toBe(true),
    );
    expect(screen.queryByTestId('gatekeeper-governance-drift')).toBeNull();
    cleanup();

    const member = scriptedHttp({
      get_workspace: () => workspace('member'),
      execution_readiness: () =>
        readiness({ principalId: 'p-self', gates: [gate({ name: '库存' })] }),
      list_available_gate_instances: () => ({ items: [LINKED_STOCK_INSTANCE] }),
    });
    renderPage(member);
    await screen.findAllByTestId('gatekeeper-card');
    expect(member.calls.some((call) => call.name === 'preview_gate_instance_enable')).toBe(false);
    expect(screen.queryByTestId('gatekeeper-governance-drift')).toBeNull();
  });
});

describe('SystemsPage: S11 AA5b — the admin chat opens one connection request here', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '#/');
  });

  it('`?complete=<id>` opens that request’s 完成连接 drawer, and the query is dropped once read', async () => {
    window.history.replaceState(null, '', '#/govern/systems?complete=cr-2');
    const http = scriptedHttp({
      list_connection_requests: () => ({
        items: [requestRow(), requestRow({ id: 'cr-2', target: 'https://tickets.example.com' })],
      }),
    });
    renderPage(http);
    const drawer = await screen.findByTestId('complete-connection-drawer');
    expect(drawer.textContent).toContain('https://tickets.example.com');
    expect(window.location.hash).toBe('#/govern/systems');
    expect(screen.queryByTestId('linked-request-note')).toBeNull();
  });

  it('a link followed while the page is open opens the drawer too', async () => {
    window.history.replaceState(null, '', '#/govern/systems');
    const http = scriptedHttp({
      list_connection_requests: () => ({ items: [requestRow()] }),
    });
    renderPage(http);
    await screen.findByTestId('request-row');
    expect(screen.queryByTestId('complete-connection-drawer')).toBeNull();
    window.history.replaceState(null, '', '#/govern/systems?complete=cr-1');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await screen.findByTestId('complete-connection-drawer');
    expect(window.location.hash).toBe('#/govern/systems');
  });

  it('a request already completed says so, links the connected system, and lists every request', async () => {
    window.history.replaceState(null, '', '#/govern/systems?complete=cr-1');
    const http = scriptedHttp({
      list_connection_requests: () => ({
        items: [
          requestRow({
            status: 'completed',
            gatekeeperId: '11111111-1111-4111-8111-111111111111',
            completedBy: 'p-self',
            completedAt: '2026-09-02T00:00:00.000Z',
          }),
        ],
      }),
    });
    renderPage(http);
    const note = await screen.findByTestId('linked-request-note');
    expect(note.textContent).toContain('已经完成了');
    expect(within(note).getByTestId('linked-request-gate').getAttribute('href')).toBe(
      '#/govern/systems/11111111-1111-4111-8111-111111111111',
    );
    // The filter moved to 全部, so the completed row is in the list.
    expect(await screen.findByTestId('request-row')).toBeTruthy();
    expect(screen.queryByTestId('complete-connection-drawer')).toBeNull();
  });

  it('a cancelled request says nothing was connected', async () => {
    window.history.replaceState(null, '', '#/govern/systems?complete=cr-1');
    const http = scriptedHttp({
      list_connection_requests: () => ({ items: [requestRow({ status: 'cancelled' })] }),
    });
    renderPage(http);
    const note = await screen.findByTestId('linked-request-note');
    expect(note.textContent).toContain('已经取消了，什么也没有接入');
    expect(within(note).queryByTestId('linked-request-gate')).toBeNull();
  });

  it('a request this workspace does not have says it may be in another workspace', async () => {
    window.history.replaceState(null, '', '#/govern/systems?complete=cr-9');
    const http = scriptedHttp({
      list_connection_requests: () => ({ items: [requestRow()] }),
    });
    renderPage(http);
    const note = await screen.findByTestId('linked-request-note');
    expect(note.textContent).toContain('可能是在另一个工作区里提出的');
    expect(screen.queryByTestId('complete-connection-drawer')).toBeNull();
  });

  it('a member, who cannot read the requests, is told so once and no drawer opens', async () => {
    window.history.replaceState(null, '', '#/govern/systems?complete=cr-1');
    const http = scriptedHttp({
      get_workspace: () => workspace('member'),
      list_connection_requests: () => ({ items: [requestRow()] }),
    });
    renderPage(http);
    await screen.findByTestId('requests-forbidden');
    expect(screen.queryByTestId('linked-request-note')).toBeNull();
    expect(screen.queryByTestId('complete-connection-drawer')).toBeNull();
    expect(http.calls.some((call) => call.name === 'list_connection_requests')).toBe(false);
  });
});

describe('SystemsPage: S11 AA5b — requests in a trial workspace', () => {
  it('an owner who is not a platform administrator reads who completes a preset kind there', async () => {
    const http = scriptedHttp({
      list_connection_requests: () => ({
        items: [requestRow(), requestRow({ id: 'cr-2', kind: 'ssh', target: 'ops@host' })],
      }),
    });
    renderPage(http, false, true);
    const rows = await screen.findAllByTestId('request-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId('request-trial-note').textContent).toContain(
      '只有平台管理员能完成这个连接',
    );
    // The exception covers only the generic connectors (http, mcp).
    expect(within(rows[1] as HTMLElement).queryByTestId('request-trial-note')).toBeNull();
    // The 完成 button stays: the platform may well let the workspace connect it itself.
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: '完成' })).toBeTruthy();
  });

  it('a platform administrator, or any workspace that is not a trial one, reads no such note', async () => {
    const items = { items: [requestRow()] };
    renderPage(scriptedHttp({ list_connection_requests: () => items }), true, true);
    await screen.findByTestId('request-row');
    expect(screen.queryByTestId('request-trial-note')).toBeNull();
    cleanup();
    renderPage(scriptedHttp({ list_connection_requests: () => items }), false, false);
    await screen.findByTestId('request-row');
    expect(screen.queryByTestId('request-trial-note')).toBeNull();
  });

  it('a request the admin agent made is marked so on its row', async () => {
    const http = scriptedHttp({
      list_connection_requests: () => ({
        items: [
          requestRow({ adminAgentSessionId: '22222222-2222-4222-8222-222222222222' }),
          requestRow({ id: 'cr-2' }),
        ],
      }),
    });
    renderPage(http, true, true);
    const rows = await screen.findAllByTestId('request-row');
    expect(within(rows[0] as HTMLElement).getByTestId('request-admin-agent').textContent).toContain(
      '由管理员智能体代为',
    );
    expect(within(rows[1] as HTMLElement).queryByTestId('request-admin-agent')).toBeNull();
  });
});
