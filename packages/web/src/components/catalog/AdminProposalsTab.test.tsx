// @vitest-environment jsdom
import type {
  AdminProposalSegmentPreviewWire,
  AvailableGateInstanceWire,
  PackInstallPreviewWire,
  PackWire,
  ReceivedAdminProposalSegmentWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { statusChipStyle } from '../../lib/status-tone.js';
import { AdminProposalsTab } from './AdminProposalsTab.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** S11 AA4a: 能力目录 · 管理员提案 — the owner reviews, applies or rejects the part of an admin
 *  proposal addressed to this workspace. */

const SEGMENT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const RECORD = '55555555-5555-4555-8555-555555555555';

const OWNER_WORKSPACE = {
  id: 'ws-1',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00Z',
  principalCount: 1,
  gatekeeperCount: 0,
  caller: { id: 'p-owner', role: 'owner', displayName: 'Owner', kind: 'human' },
};

const MEMBER_WORKSPACE = {
  ...OWNER_WORKSPACE,
  caller: { id: 'p-member', role: 'member', displayName: 'Member', kind: 'human' },
};

function received(
  patch: Partial<ReceivedAdminProposalSegmentWire> = {},
): ReceivedAdminProposalSegmentWire {
  return {
    id: SEGMENT,
    proposal: {
      id: 'proposal-1',
      title: '整理容器运维',
      description: '给运维加一个排障 Skill 和一个执行 Worker。',
      sourceName: 'ops-tuning',
      origin: 'agent',
      proposedBy: { userId: 'u-ada', displayName: 'Ada' },
      proposedAt: '2026-11-01T08:00:00.000Z',
    },
    ordinal: 1,
    items: [
      {
        kind: 'skill_version',
        skill: { name: 'docker-triage', description: '排查容器', markdown: '# 排查' },
      },
      {
        kind: 'worker_definition_version',
        definition: {
          name: 'ops-runner',
          systemPrompt: '你负责执行。',
          skills: ['docker-triage'],
          capabilities: ['request_action'],
        },
      },
      {
        kind: 'operation_version',
        gateId: 'docker-a',
        name: 'container.restart',
        set: { auto_approvable: true },
      },
    ],
    contentDigest: 'sha256:content',
    status: 'proposed',
    decidedAt: null,
    decidedBy: null,
    withdrawnOrigin: null,
    reason: null,
    appliedSegmentId: null,
    rolledBackAt: null,
    platformSegment: null,
    ...patch,
  };
}

function preview(
  patch: Partial<AdminProposalSegmentPreviewWire> = {},
  segmentPatch: Partial<ReceivedAdminProposalSegmentWire> = {},
): AdminProposalSegmentPreviewWire {
  return {
    segment: received(segmentPatch),
    blockers: [],
    platformChanges: [],
    targetChosen: true,
    digest: 'sha256:reviewed',
    unchanged: false,
    items: [
      {
        ordinal: 1,
        kind: 'skill_version',
        unchanged: false,
        classification: 'not_widening',
        widening: [],
        target: { skillId: 'ops-tuning-docker-triage', name: 'docker-triage' },
        newFamily: true,
        before: null,
        after: { contentDigest: 'sha256:s' },
        skill: {
          name: 'docker-triage',
          description: '排查容器',
          markdown: '# 排查',
          applicable: {},
        },
        changedFields: [],
      },
      {
        ordinal: 2,
        kind: 'worker_definition_version',
        unchanged: false,
        classification: 'authority_widening',
        widening: [{ path: 'worker.capabilities', reason: 'loosened' }],
        target: { definitionId: 'wd-runner', name: 'ops-runner' },
        newFamily: false,
        before: { version: 2, contentDigest: 'sha256:w1' },
        after: { contentDigest: 'sha256:w2' },
        definition: {
          name: 'ops-runner',
          systemPrompt: '你负责执行。',
          skills: ['docker-triage'],
          capabilities: ['request_action'],
        },
        gates: [{ id: 'gk-1', name: 'Docker prod' }],
        gateBinding: { systems: [], source: 'workspace', candidates: [] },
        changedFields: ['capabilities'],
      },
      {
        ordinal: 3,
        kind: 'operation_version',
        unchanged: false,
        classification: 'authority_widening',
        widening: [{ path: 'operation.auto_approvable', reason: 'loosened' }],
        target: { gatekeeperId: 'gk-1', gatekeeperName: 'Docker prod', name: 'container.restart' },
        before: { version: 1, contentDigest: 'sha256:o1' },
        after: { contentDigest: 'sha256:o2' },
        fields: [{ field: 'auto_approvable', before: false, after: true }],
      },
    ],
    suspectedSecretValues: 0,
    suspectedSecretPaths: [],
    ...patch,
  };
}

/** The proposal reduced to its Skill alone, as proposed and as previewed. */
const ONLY_SKILL = received().items.slice(0, 1);
const ONLY_SKILL_PREVIEW = preview().items.slice(0, 1);

const DOCKER: AvailableGateInstanceWire = {
  gateId: 'docker-a',
  connector: 'docker',
  displayName: 'Docker prod',
  transportKind: 'mcp',
  target: 'https://docker.example',
  status: 'enabled',
  trust: 'vetted',
  health: 'ok',
  operationCount: 3,
  gatekeeperId: null,
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

function named(calls: readonly { name: string; params: unknown }[], name: string) {
  return calls.filter((call) => call.name === name);
}

function Harness({
  http,
  initialItemId,
  platformAdmin,
}: {
  http: CapabilityCaller;
  initialItemId?: string;
  platformAdmin?: boolean;
}) {
  const [itemId, setItemId] = useState<string | undefined>(initialItemId);
  return (
    <AdminProposalsTab
      http={http}
      itemId={itemId}
      onSelectItem={(id) => setItemId(id ?? undefined)}
      platformAdmin={platformAdmin}
    />
  );
}

function renderTab(http: CapabilityCaller, initialItemId?: string, platformAdmin = false) {
  return render(
    <PermissionsProvider>
      <Harness http={http} initialItemId={initialItemId} platformAdmin={platformAdmin} />
    </PermissionsProvider>,
  );
}

describe('AdminProposalsTab (能力目录 · 管理员提案, S11 AA4a)', () => {
  it('lists what awaits a decision; the owner reviews it, ticks each widening item, and applies the reviewed digest', async () => {
    let applied = false;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: (params) => {
        const status = (params as { status?: string }).status;
        const row = received(
          applied
            ? {
                status: 'applied',
                appliedSegmentId: RECORD,
                decidedAt: '2026-11-02T08:00:00.000Z',
                decidedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
              }
            : {},
        );
        return { items: status === undefined || status === row.status ? [row] : [] };
      },
      list_available_gate_instances: () => ({ items: [DOCKER] }),
      preview_admin_proposal_segment: () => preview(),
      apply_admin_proposal_segment: () => {
        applied = true;
        return {
          segment: received({
            status: 'applied',
            appliedSegmentId: RECORD,
            decidedAt: '2026-11-02T08:00:00.000Z',
            decidedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
          }),
          changeSegmentId: RECORD,
        };
      },
    });
    renderTab(http);

    // 待确认 by default.
    await waitFor(() =>
      expect(named(http.calls, 'list_admin_proposal_segments')[0]?.params).toEqual({
        status: 'proposed',
      }),
    );
    const row = await screen.findByTestId(`catalog-proposal-row-${SEGMENT}`);
    expect(row.textContent).toContain('整理容器运维');
    expect(row.textContent).toContain('平台管理员 Ada 的管理员智能体');
    expect(row.textContent).toContain('待确认');
    fireEvent.click(row);

    const pane = await screen.findByTestId('catalog-proposal-detail');
    expect(within(pane).getByTestId('catalog-proposal-description').textContent).toBe(
      '给运维加一个排障 Skill 和一个执行 Worker。',
    );
    const items = await within(pane).findByTestId('catalog-proposal-items');
    expect(within(items).getByTestId('catalog-proposal-item-1').textContent).toContain(
      'Skill docker-triage：本工作区还没有，新建',
    );
    const worker = within(items).getByTestId('catalog-proposal-item-2');
    expect(worker.textContent).toContain('Worker ops-runner：第 2 版 → 新的一版');
    const gates = within(worker).getByTestId('catalog-proposal-item-2-gates').textContent;
    expect(gates).toContain('沿用工作区为它选的');
    expect(gates).toContain('Docker prod');
    expect(within(worker).getByTestId('catalog-proposal-item-2-changed').textContent).toContain(
      '能力范围',
    );
    const operation = within(items).getByTestId('catalog-proposal-item-3');
    expect(operation.textContent).toContain('Operation container.restart（门 Docker prod）');
    expect(within(operation).getByTestId('catalog-proposal-item-3-fields').textContent).toContain(
      '否 → 是',
    );

    // Two items move an authority boundary: Apply waits for both ticks.
    const trigger = within(pane).getByTestId('catalog-proposal-apply-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(within(pane).getByTestId('catalog-proposal-missing-steps').textContent).toBe(
      '还差：勾选 2 项权限边界确认',
    );
    fireEvent.click(within(pane).getByTestId('catalog-proposal-item-2-confirm'));
    fireEvent.click(within(pane).getByTestId('catalog-proposal-item-3-confirm'));
    expect(trigger.disabled).toBe(false);

    fireEvent.click(trigger);
    const confirm = await screen.findByTestId('catalog-proposal-apply-confirm');
    expect(confirm.textContent).toContain('记成一条安装记录（来源：管理员提案 ops-tuning）');
    fireEvent.click(within(confirm).getByRole('button', { name: '应用' }));

    await waitFor(() =>
      expect(named(http.calls, 'apply_admin_proposal_segment').map((call) => call.params)).toEqual([
        { segmentId: SEGMENT, reviewedDigest: 'sha256:reviewed', confirmedOrdinals: [2, 3] },
      ]),
    );
    // Applied: the detail says so and leads to the install record it left.
    const record = await screen.findByTestId('catalog-proposal-record');
    expect(record.querySelector('a')?.getAttribute('href')).toBe(
      `#/govern/catalog/changes/${RECORD}`,
    );
    expect(screen.getByTestId('catalog-proposal-status').textContent).toBe('已应用');
    expect(screen.getByTestId('catalog-proposal-decision').textContent).toContain('由 Owner 应用');
  });

  it('a value that looks like a credential needs the owner’s confirmation, which the apply carries', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({
        items: [received({ items: ONLY_SKILL })],
      }),
      preview_admin_proposal_segment: () =>
        preview({
          items: ONLY_SKILL_PREVIEW,
          suspectedSecretValues: 1,
          suspectedSecretPaths: ['items[0].skill.markdown'],
        }),
      apply_admin_proposal_segment: () => ({
        segment: received({ status: 'applied', appliedSegmentId: RECORD }),
        changeSegmentId: RECORD,
      }),
    });
    renderTab(http, SEGMENT);

    const review = await screen.findByTestId('catalog-proposal-review');
    expect(within(review).getByTestId('credential-review').textContent).toContain(
      '含 1 处疑似凭据',
    );
    const trigger = within(review).getByTestId(
      'catalog-proposal-apply-trigger',
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(within(review).getByTestId('catalog-proposal-missing-steps').textContent).toBe(
      '还差：核对疑似凭据',
    );
    fireEvent.click(within(review).getByRole('checkbox'));
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    fireEvent.click(
      within(await screen.findByTestId('catalog-proposal-apply-confirm')).getByRole('button', {
        name: '应用',
      }),
    );
    await waitFor(() =>
      expect(named(http.calls, 'apply_admin_proposal_segment')[0]?.params).toEqual({
        segmentId: SEGMENT,
        reviewedDigest: 'sha256:reviewed',
        credentialsReviewed: true,
      }),
    );
  });

  it('a system the platform offers but the workspace has not enabled is enabled on the spot, then the review is read again', async () => {
    let enabled = false;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received()] }),
      list_available_gate_instances: () => ({ items: [DOCKER] }),
      preview_admin_proposal_segment: () =>
        enabled
          ? preview()
          : preview({
              digest: null,
              items: [],
              blockers: [
                {
                  ordinal: 3,
                  kind: 'operation_version',
                  reason: 'gate_not_enabled',
                  gateAvailability: 'can_enable',
                },
              ],
            }),
      preview_gate_instance_enable: () => ({
        gateId: 'docker-a',
        ambiguousCandidates: [],
        wouldLink: null,
        operationsToImport: [],
        operationsAlreadyPresent: [],
        manifestDigest: 'sha256:manifest',
      }),
      enable_gate_instance: () => {
        enabled = true;
        return { gatekeeperId: 'gk-1', linkedExisting: false, publishedOperationNames: [] };
      },
    });
    renderTab(http, SEGMENT);

    const blocker = await screen.findByTestId('catalog-proposal-blocker-3');
    expect(blocker.textContent).toContain(
      'Operation container.restart（门 Docker prod）：它要改的系统平台已经提供，本工作区还没启用',
    );
    // Nothing is planned while a blocker is there: the intents show as proposed.
    expect(screen.getByTestId('catalog-proposal-intent-3').textContent).toBe(
      'Operation container.restart（门 Docker prod）',
    );
    expect(
      (screen.getByTestId('catalog-proposal-apply-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('catalog-proposal-missing-steps').textContent).toBe(
      '还差：处理 1 处对不上的地方',
    );

    fireEvent.click(within(blocker).getByTestId('catalog-proposal-blocker-3-enable'));
    fireEvent.click(await screen.findByRole('button', { name: '注册并启用' }));
    await waitFor(() =>
      expect(named(http.calls, 'enable_gate_instance').map((call) => call.params)).toEqual([
        { gateId: 'docker-a', manifestDigest: 'sha256:manifest' },
      ]),
    );
    await screen.findByTestId('catalog-proposal-items');
    expect(named(http.calls, 'preview_admin_proposal_segment').length).toBe(2);
    expect(screen.queryByTestId('catalog-proposal-blockers')).toBeNull();
  });

  it('a proposed Worker naming its systems says which gates applying binds it to, and the ones the owner does not hold', async () => {
    const bound = (held: boolean) =>
      preview({
        items: preview().items.map((item) =>
          item.kind === 'worker_definition_version'
            ? {
                ...item,
                newFamily: true,
                before: null,
                gates: [
                  { id: 'gk-1', name: 'Docker prod' },
                  { id: 'gk-2', name: 'Docker staging' },
                ],
                gateBinding: {
                  systems: ['docker'],
                  source: 'apply' as const,
                  candidates: [
                    { id: 'gk-1', name: 'Docker prod', connector: 'docker', held: true },
                    { id: 'gk-2', name: 'Docker staging', connector: 'docker', held },
                  ],
                },
              }
            : item,
        ),
      });
    for (const held of [true, false]) {
      cleanup();
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_admin_proposal_segments: () => ({ items: [received()] }),
        preview_admin_proposal_segment: () => bound(held),
      });
      renderTab(http, SEGMENT);
      const gates = (await screen.findByTestId('catalog-proposal-item-2-gates')).textContent;
      expect(gates).toMatch(
        /接入的系统：它要用 docker，应用时绑到本工作区的 Docker prod、Docker staging/,
      );
      if (held) expect(gates).not.toContain('还没有授权');
      else
        expect(gates).toContain(
          '其中 Docker staging 你还没有授权给自己：授权之前，目标里用到这个 Worker 的步骤会被拒绝，你的智能体委派它也可能被拒。先在「系统与授权」里授权',
        );
    }
  });

  it('the owner keeps fewer gates for a proposed Worker: the review is read again with that choice, and the apply binds exactly it and says how the check right after went', async () => {
    const candidates = [
      { id: 'gk-1', name: 'Docker prod', connector: 'docker', held: true },
      { id: 'gk-2', name: 'Docker staging', connector: 'docker', held: false },
    ];
    const reviewed = (kept: readonly string[] | undefined) => {
      const ids = kept ?? candidates.map((gate) => gate.id);
      return preview({
        digest: kept === undefined ? 'sha256:reviewed' : `sha256:kept-${ids.join('+') || 'none'}`,
        items: preview().items.map((item) =>
          item.kind === 'worker_definition_version'
            ? {
                ...item,
                newFamily: true,
                before: null,
                gates: candidates
                  .filter((gate) => ids.includes(gate.id))
                  .map((gate) => ({ id: gate.id, name: gate.name })),
                gateBinding: { systems: ['docker'], source: 'apply' as const, candidates },
              }
            : item,
        ),
      });
    };
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received()] }),
      preview_admin_proposal_segment: (params) =>
        reviewed(
          (params as { workerGates?: Record<string, readonly string[]> }).workerGates?.[
            'ops-runner'
          ],
        ),
      apply_admin_proposal_segment: () => ({
        segment: received({
          status: 'applied',
          appliedSegmentId: RECORD,
          decidedAt: '2026-11-02T08:00:00.000Z',
          decidedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
        }),
        changeSegmentId: RECORD,
        verification: {
          trigger: 'system',
          verifiedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
          verifiedAt: '2026-11-02T08:00:01.000Z',
          passed: true,
          sourceFound: true,
          items: [],
          requirements: [],
          dependencies: [],
        },
      }),
    });
    renderTab(http, SEGMENT);

    // Every candidate ticked by default; the one the owner does not hold says so.
    const choice = await screen.findByTestId('catalog-proposal-item-2-binding-choice');
    const prod = within(choice).getByTestId('catalog-proposal-item-2-binding-gate-gk-1');
    const staging = within(choice).getByTestId('catalog-proposal-item-2-binding-gate-gk-2');
    expect((prod as HTMLInputElement).checked).toBe(true);
    expect((staging as HTMLInputElement).checked).toBe(true);
    expect(
      within(choice).queryByTestId('catalog-proposal-item-2-binding-gate-gk-1-not-held'),
    ).toBeNull();
    expect(
      within(choice).getByTestId('catalog-proposal-item-2-binding-gate-gk-2-not-held'),
    ).toBeTruthy();

    // Unticking one reads the review again with the choice, by the name the Worker goes by; a
    // confirmation given before is given again for the new review.
    fireEvent.click(screen.getByTestId('catalog-proposal-item-2-confirm'));
    fireEvent.click(staging);
    expect(
      (screen.getByTestId('catalog-proposal-item-2-confirm') as HTMLInputElement).checked,
    ).toBe(false);
    await waitFor(() =>
      expect(
        named(http.calls, 'preview_admin_proposal_segment').map((call) => call.params),
      ).toEqual([
        { segmentId: SEGMENT },
        { segmentId: SEGMENT, workerGates: { 'ops-runner': ['gk-1'] } },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('catalog-proposal-item-2-gates').textContent).not.toContain(
        'Docker staging',
      ),
    );
    expect(screen.queryByTestId('catalog-proposal-rereading')).toBeNull();
    expect(
      (screen.getByTestId('catalog-proposal-item-2-binding-gate-gk-2') as HTMLInputElement).checked,
    ).toBe(false);

    // Unticking the other too binds none, and says what that means.
    fireEvent.click(screen.getByTestId('catalog-proposal-item-2-binding-gate-gk-1'));
    expect(await screen.findByTestId('catalog-proposal-item-2-binding-none-kept')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('catalog-proposal-item-2-gates').textContent).toContain(
        '这次应用一个门都不绑',
      ),
    );
    fireEvent.click(screen.getByTestId('catalog-proposal-item-2-binding-gate-gk-1'));
    await waitFor(() =>
      expect(screen.queryByTestId('catalog-proposal-item-2-binding-none-kept')).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByTestId('catalog-proposal-rereading')).toBeNull());

    fireEvent.click(screen.getByTestId('catalog-proposal-item-2-confirm'));
    fireEvent.click(screen.getByTestId('catalog-proposal-item-3-confirm'));
    fireEvent.click(screen.getByTestId('catalog-proposal-apply-trigger'));
    const confirm = await screen.findByTestId('catalog-proposal-apply-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: '应用' }));
    await waitFor(() =>
      expect(named(http.calls, 'apply_admin_proposal_segment').map((call) => call.params)).toEqual([
        {
          segmentId: SEGMENT,
          reviewedDigest: 'sha256:kept-gk-1',
          confirmedOrdinals: [2, 3],
          workerGates: { 'ops-runner': ['gk-1'] },
        },
      ]),
    );
    expect((await screen.findByTestId('catalog-proposal-applied-verification')).textContent).toBe(
      '应用后已核验：通过。',
    );
  });

  it('a gate kept for a Worker that can no longer be bound sends the choice back to the default, and says so', async () => {
    const candidates = [
      { id: 'gk-1', name: 'Docker prod', connector: 'docker', held: true },
      { id: 'gk-2', name: 'Docker staging', connector: 'docker', held: true },
    ];
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received()] }),
      preview_admin_proposal_segment: (params) => {
        if ((params as { workerGates?: unknown }).workerGates !== undefined) {
          throw new HttpError(
            'capability_error',
            'gate(s) gk-1 are not connected gates of the systems Worker "ops-runner" names',
            'invalid_params',
          );
        }
        return preview({
          items: preview().items.map((item) =>
            item.kind === 'worker_definition_version'
              ? {
                  ...item,
                  gates: candidates.map((gate) => ({ id: gate.id, name: gate.name })),
                  gateBinding: { systems: ['docker'], source: 'apply' as const, candidates },
                }
              : item,
          ),
        });
      },
    });
    renderTab(http, SEGMENT);
    fireEvent.click(await screen.findByTestId('catalog-proposal-item-2-binding-gate-gk-2'));
    expect((await screen.findByTestId('catalog-proposal-choice-reset')).textContent).toContain(
      '改回了默认',
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId('catalog-proposal-item-2-binding-gate-gk-2') as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
    expect(screen.queryByTestId('catalog-proposal-preview-error')).toBeNull();
  });

  it('a choice the apply refuses (a kept gate cut off since the review was read) reads the review again and goes back to the default', async () => {
    const candidates = [
      { id: 'gk-1', name: 'Docker prod', connector: 'docker', held: true },
      { id: 'gk-2', name: 'Docker staging', connector: 'docker', held: true },
    ];
    let cutOff = false;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received()] }),
      preview_admin_proposal_segment: (params) => {
        const kept = (params as { workerGates?: Record<string, readonly string[]> }).workerGates?.[
          'ops-runner'
        ];
        if (kept !== undefined && cutOff) {
          throw new HttpError(
            'capability_error',
            'gate(s) gk-1 are not connected gates of the systems Worker "ops-runner" names',
            'invalid_params',
          );
        }
        const ids = kept ?? candidates.map((gate) => gate.id);
        return preview({
          digest: kept === undefined ? 'sha256:reviewed' : `sha256:kept-${ids.join('+')}`,
          items: preview().items.map((item) =>
            item.kind === 'worker_definition_version'
              ? {
                  ...item,
                  newFamily: true,
                  before: null,
                  gates: candidates
                    .filter((gate) => ids.includes(gate.id))
                    .map((gate) => ({ id: gate.id, name: gate.name })),
                  gateBinding: { systems: ['docker'], source: 'apply' as const, candidates },
                }
              : item,
          ),
        });
      },
      apply_admin_proposal_segment: () => {
        cutOff = true;
        throw new HttpError(
          'capability_error',
          'gate(s) gk-1 are not connected gates of the systems Worker "ops-runner" names',
          'invalid_params',
        );
      },
    });
    renderTab(http, SEGMENT);
    fireEvent.click(await screen.findByTestId('catalog-proposal-item-2-binding-gate-gk-2'));
    await waitFor(() =>
      expect(screen.getByTestId('catalog-proposal-item-2-gates').textContent).not.toContain(
        'Docker staging',
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('catalog-proposal-rereading')).toBeNull());
    fireEvent.click(screen.getByTestId('catalog-proposal-item-2-confirm'));
    fireEvent.click(screen.getByTestId('catalog-proposal-item-3-confirm'));
    fireEvent.click(screen.getByTestId('catalog-proposal-apply-trigger'));
    const confirm = await screen.findByTestId('catalog-proposal-apply-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: '应用' }));

    expect((await screen.findByTestId('catalog-proposal-choice-reset')).textContent).toContain(
      '改回了默认',
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId('catalog-proposal-item-2-binding-gate-gk-2') as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
    expect(named(http.calls, 'preview_admin_proposal_segment').map((call) => call.params)).toEqual([
      { segmentId: SEGMENT },
      { segmentId: SEGMENT, workerGates: { 'ops-runner': ['gk-1'] } },
      { segmentId: SEGMENT, workerGates: { 'ops-runner': ['gk-1'] } },
      { segmentId: SEGMENT },
    ]);
  });

  it('applying says when the check right after could not run, or did not pass', async () => {
    for (const verification of [null, { passed: false }] as const) {
      cleanup();
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_admin_proposal_segments: () => ({ items: [received({ items: ONLY_SKILL })] }),
        preview_admin_proposal_segment: () => preview({ items: ONLY_SKILL_PREVIEW }),
        apply_admin_proposal_segment: () => ({
          segment: received({
            items: ONLY_SKILL,
            status: 'applied',
            appliedSegmentId: RECORD,
            decidedAt: '2026-11-02T08:00:00.000Z',
            decidedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
          }),
          changeSegmentId: RECORD,
          verification:
            verification === null
              ? null
              : {
                  trigger: 'system',
                  verifiedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
                  verifiedAt: '2026-11-02T08:00:01.000Z',
                  passed: false,
                  sourceFound: true,
                  items: [],
                  requirements: [],
                  dependencies: [],
                },
        }),
      });
      renderTab(http, SEGMENT);
      fireEvent.click(await screen.findByTestId('catalog-proposal-apply-trigger'));
      const confirm = await screen.findByTestId('catalog-proposal-apply-confirm');
      fireEvent.click(within(confirm).getByRole('button', { name: '应用' }));
      expect((await screen.findByTestId('catalog-proposal-applied-verification')).textContent).toBe(
        verification === null
          ? '应用后没能核验，可以在安装记录里再核验一次。'
          : '应用后已核验：没有通过，原因见安装记录。',
      );
    }
  });

  it('a system a proposed Worker names that is not connected here is enabled on the spot, each instance the platform offers', async () => {
    let enabled = false;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received()] }),
      list_available_gate_instances: () => ({ items: [DOCKER] }),
      preview_admin_proposal_segment: () =>
        enabled
          ? preview()
          : preview({
              digest: null,
              items: [],
              blockers: [
                {
                  ordinal: 2,
                  kind: 'worker_definition_version',
                  reason: 'worker_system_not_connected',
                  gateAvailability: 'can_enable',
                  connector: 'docker',
                  offered: [{ gateId: 'docker-a', displayName: 'Docker prod' }],
                },
              ],
            }),
      preview_gate_instance_enable: () => ({
        gateId: 'docker-a',
        ambiguousCandidates: [],
        wouldLink: null,
        operationsToImport: [],
        operationsAlreadyPresent: [],
        manifestDigest: 'sha256:manifest',
      }),
      enable_gate_instance: () => {
        enabled = true;
        return { gatekeeperId: 'gk-1', linkedExisting: false, publishedOperationNames: [] };
      },
    });
    renderTab(http, SEGMENT);

    const blocker = await screen.findByTestId('catalog-proposal-blocker-2');
    expect(blocker.textContent).toContain(
      'Worker ops-runner：它要用的系统 docker 平台已经提供，本工作区还没启用',
    );
    fireEvent.click(within(blocker).getByTestId('catalog-proposal-blocker-2-enable-docker-a'));
    fireEvent.click(await screen.findByRole('button', { name: '注册并启用' }));
    await waitFor(() =>
      expect(named(http.calls, 'enable_gate_instance').map((call) => call.params)).toEqual([
        { gateId: 'docker-a', manifestDigest: 'sha256:manifest' },
      ]),
    );
    await screen.findByTestId('catalog-proposal-items');
    expect(named(http.calls, 'preview_admin_proposal_segment').length).toBe(2);
    expect(screen.queryByTestId('catalog-proposal-blockers')).toBeNull();
  });

  it('a system a proposed Worker names that the platform does not offer says a platform administrator offers it first', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received()] }),
      preview_admin_proposal_segment: () =>
        preview({
          digest: null,
          items: [],
          blockers: [
            {
              ordinal: 2,
              kind: 'worker_definition_version',
              reason: 'worker_system_not_connected',
              gateAvailability: 'needs_platform',
              connector: 'tickets',
              offered: [],
            },
          ],
        }),
    });
    renderTab(http, SEGMENT);

    const blocker = await screen.findByTestId('catalog-proposal-blocker-2');
    expect(blocker.textContent).toContain(
      'Worker ops-runner：它要用的系统 tickets 平台还没有提供给工作区，需要平台管理员先提供。',
    );
    expect(within(blocker).queryByRole('button')).toBeNull();
  });

  it('UX M-1 (#968): while the platform part waits, only a system that part creates is said to wait on it; any other needs the platform some other way', async () => {
    const platformSegment = {
      id: OTHER,
      status: 'proposed' as const,
      items: [
        {
          kind: 'gate_instance' as const,
          gateId: 'ragflow-a',
          displayName: 'RAGFlow',
          preset: 'ragflow',
          target: 'https://ragflow.internal.example',
        },
      ],
    };
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received({ platformSegment })] }),
      preview_admin_proposal_segment: () =>
        preview(
          {
            digest: null,
            items: [],
            blockers: [
              {
                ordinal: 2,
                kind: 'worker_definition_version',
                reason: 'worker_system_not_connected',
                gateAvailability: 'needs_platform',
                connector: 'ragflow',
                fromPlatformSegment: true,
                offered: [],
              },
              {
                ordinal: 2,
                kind: 'worker_definition_version',
                reason: 'worker_system_not_connected',
                gateAvailability: 'needs_platform',
                connector: 'tickets',
                fromPlatformSegment: false,
                offered: [],
              },
            ],
          },
          { platformSegment },
        ),
    });
    renderTab(http, SEGMENT);

    const [created, other] = await screen.findAllByTestId('catalog-proposal-blocker-2');
    expect(created?.textContent).toContain(
      'Worker ops-runner：它要用的系统 ragflow 由这份提案的平台部分新建，要等平台管理员应用平台部分并启用这个系统',
    );
    expect(other?.textContent).toContain(
      'Worker ops-runner：它要用的系统 tickets 平台还没有提供给工作区，需要平台管理员先提供。',
    );
    expect(other?.textContent).not.toContain('平台部分');
  });

  it('a platform part not applied yet holds the apply and says who goes first', async () => {
    const platformSegment = {
      id: OTHER,
      status: 'proposed' as const,
      items: [
        {
          kind: 'gate_instance' as const,
          gateId: 'ragflow-a',
          displayName: 'RAGFlow',
          preset: 'ragflow',
          target: 'https://ragflow.internal.example',
        },
      ],
    };
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({
        items: [received({ items: ONLY_SKILL, platformSegment })],
      }),
      preview_admin_proposal_segment: () =>
        preview({ digest: null, items: ONLY_SKILL_PREVIEW }, { platformSegment }),
    });
    renderTab(http, SEGMENT);

    const platform = await screen.findByTestId('catalog-proposal-platform');
    expect(platform.textContent).toContain('要等平台管理员先应用它');
    expect(platform.textContent).toContain('新建门宿主实例 RAGFlow（预设 ragflow）');
    // The owner never reads the platform's address.
    expect(screen.getByTestId('catalog-proposal-detail').textContent).not.toContain(
      'ragflow.internal.example',
    );
    await screen.findByTestId('catalog-proposal-items');
    expect(screen.getByText('平台部分应用后，它会在这里改动')).toBeTruthy();
    expect(
      (screen.getByTestId('catalog-proposal-apply-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('catalog-proposal-missing-steps').textContent).toBe(
      '要等平台管理员先应用平台部分',
    );
  });

  it('UX P3-2 (#929): in English the reason after “Still needed: …;” goes on in lower case', async () => {
    localStorage.setItem('nexttime.lang', 'en');
    const platformSegment = {
      id: OTHER,
      status: 'proposed' as const,
      items: [
        {
          kind: 'gate_instance' as const,
          gateId: 'ragflow-a',
          displayName: 'RAGFlow',
          preset: 'ragflow',
          target: 'https://ragflow.internal.example',
        },
      ],
    };
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received({ platformSegment })] }),
      preview_admin_proposal_segment: () => preview({ digest: null }, { platformSegment }),
    });
    render(
      <LangProvider>
        <PermissionsProvider>
          <Harness http={http} initialItemId={SEGMENT} platformAdmin={false} />
        </PermissionsProvider>
      </LangProvider>,
    );
    expect((await screen.findByTestId('catalog-proposal-missing-steps')).textContent).toBe(
      'Still needed: tick 2 authority-boundary confirmations; a platform administrator has to apply the platform part first',
    );
  });

  it('an instance the platform part created that changed since is named with what changed, and the apply waits', async () => {
    const platformSegment = {
      id: OTHER,
      status: 'applied' as const,
      items: [
        {
          kind: 'gate_instance' as const,
          gateId: 'ragflow-a',
          displayName: 'RAGFlow',
          preset: 'ragflow',
          target: 'https://ragflow.internal.example',
        },
        {
          kind: 'gate_instance' as const,
          gateId: 'wiki-a',
          connector: 'wiki',
          transportKind: 'http' as const,
          credentialMode: 'shared' as const,
          manifestSource: 'https://wiki.internal.example/openapi.json',
          target: 'https://wiki.internal.example',
        },
      ],
    };
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received({ platformSegment })] }),
      preview_admin_proposal_segment: () =>
        preview(
          {
            digest: null,
            platformChanges: [
              { gateId: 'ragflow-a', gone: false, drift: ['target', 'connector'] },
              { gateId: 'wiki-a', gone: true, drift: [] },
            ],
          },
          { platformSegment },
        ),
    });
    renderTab(http, SEGMENT);

    const changes = await screen.findByTestId('catalog-proposal-platform-changes');
    expect(changes.textContent).toContain('RAGFlow：地址、接入包改过');
    expect(changes.textContent).toContain('wiki-a：已删除');
    expect(screen.getByTestId('catalog-proposal-platform').textContent).toContain(
      '平台管理员已经应用',
    );
    expect(
      (screen.getByTestId('catalog-proposal-apply-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    // UX P3-1 (#929): however it is ticked it cannot be applied, so only the reason is said and
    // the confirmations wait.
    expect(screen.getByTestId('catalog-proposal-missing-steps').textContent).toBe(
      '平台部分建好的门宿主实例之后被改过，现在不能应用',
    );
    for (const ordinal of [2, 3]) {
      expect(
        (screen.getByTestId(`catalog-proposal-item-${ordinal}-confirm`) as HTMLInputElement)
          .disabled,
      ).toBe(true);
    }
  });

  it('an apply refused because things moved since reads the review again and says why', async () => {
    let round = 0;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({
        items: [received({ items: ONLY_SKILL })],
      }),
      preview_admin_proposal_segment: () => {
        round += 1;
        return preview({ items: ONLY_SKILL_PREVIEW, digest: `sha256:round-${round}` });
      },
      apply_admin_proposal_segment: () =>
        Promise.reject(
          new HttpError('capability_error', 'the plan changed', 'change_plan_changed'),
        ),
    });
    renderTab(http, SEGMENT);

    fireEvent.click(await screen.findByTestId('catalog-proposal-apply-trigger'));
    fireEvent.click(
      within(await screen.findByTestId('catalog-proposal-apply-confirm')).getByRole('button', {
        name: '应用',
      }),
    );
    await waitFor(() => expect(named(http.calls, 'preview_admin_proposal_segment').length).toBe(2));
    expect((await screen.findByTestId('catalog-proposal-stale')).textContent).toContain(
      '什么也没有应用',
    );
  });

  it('S11 AA4c: a workspace the administrator no longer targets says so, holds the apply and leaves rejecting', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received({ items: ONLY_SKILL })] }),
      preview_admin_proposal_segment: () =>
        preview({ items: ONLY_SKILL_PREVIEW, targetChosen: false }),
    });
    renderTab(http, SEGMENT);

    expect((await screen.findByTestId('catalog-proposal-target-dropped')).textContent).toContain(
      '把本工作区从管理员智能体的目标里去掉了',
    );
    expect(
      (screen.getByTestId('catalog-proposal-apply-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('catalog-proposal-missing-steps').textContent).toContain(
      '请对方把本工作区重新加回目标',
    );
    expect(screen.getByTestId('catalog-proposal-reject-trigger')).toBeTruthy();
  });

  it('S11 AA4c: an apply refused because the target was just dropped reads the review again and says nothing was applied', async () => {
    let round = 0;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received({ items: ONLY_SKILL })] }),
      preview_admin_proposal_segment: () => {
        round += 1;
        return preview({
          items: ONLY_SKILL_PREVIEW,
          digest: `sha256:round-${round}`,
          targetChosen: round === 1,
        });
      },
      apply_admin_proposal_segment: () =>
        Promise.reject(
          new HttpError(
            'capability_error',
            'target no longer chosen',
            'admin_proposal_target_no_longer_chosen',
          ),
        ),
    });
    renderTab(http, SEGMENT);

    fireEvent.click(await screen.findByTestId('catalog-proposal-apply-trigger'));
    fireEvent.click(
      within(await screen.findByTestId('catalog-proposal-apply-confirm')).getByRole('button', {
        name: '应用',
      }),
    );
    await waitFor(() => expect(named(http.calls, 'preview_admin_proposal_segment').length).toBe(2));
    expect((await screen.findByTestId('catalog-proposal-target-dropped')).textContent).toContain(
      '不能应用',
    );
  });

  it('rejecting takes a reason, says who reads it, and sends it trimmed', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [received()] }),
      list_available_gate_instances: () => ({ items: [DOCKER] }),
      preview_admin_proposal_segment: () => preview(),
      reject_admin_proposal_segment: (params) =>
        received({
          status: 'rejected',
          reason: (params as { reason: string }).reason,
          decidedAt: '2026-11-02T08:00:00.000Z',
          decidedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
        }),
    });
    renderTab(http, SEGMENT);

    fireEvent.click(await screen.findByTestId('catalog-proposal-reject-trigger'));
    const confirm = await screen.findByTestId('catalog-proposal-reject-confirm');
    expect(confirm.textContent).toContain('平台管理员也看得到');
    expect(confirm.textContent).toContain('管理员智能体只知道被拒绝了，看不到理由');
    const reject = within(confirm).getByRole('button', { name: '拒绝' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(within(confirm).getByTestId('catalog-proposal-reject-reason'), {
      target: { value: '  这个 Worker 我们已经有了  ' },
    });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);

    await waitFor(() =>
      expect(named(http.calls, 'reject_admin_proposal_segment').map((call) => call.params)).toEqual(
        [{ segmentId: SEGMENT, reason: '这个 Worker 我们已经有了' }],
      ),
    );
    expect((await screen.findByTestId('catalog-proposal-status')).textContent).toBe('已拒绝');
    expect(screen.getByTestId('catalog-proposal-reason').textContent).toBe(
      '这个 Worker 我们已经有了',
    );
    expect(named(http.calls, 'apply_admin_proposal_segment')).toEqual([]);
  });

  it('a segment withdrawn because its platform part was rolled back says so and offers nothing to do', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: (params) =>
        (params as { status?: string }).status === 'withdrawn'
          ? {
              items: [
                received({
                  status: 'withdrawn',
                  withdrawnOrigin: 'platform_segment',
                  decidedAt: '2026-11-02T08:00:00.000Z',
                }),
              ],
            }
          : { items: [] },
      list_available_gate_instances: () => ({ items: [] }),
    });
    renderTab(http);

    expect((await screen.findByTestId('catalog-proposals-empty')).textContent).toContain(
      '没有待确认的管理员提案',
    );
    fireEvent.change(screen.getByTestId('catalog-proposals-filter'), {
      target: { value: 'withdrawn' },
    });
    fireEvent.click(await screen.findByTestId(`catalog-proposal-row-${SEGMENT}`));
    const pane = await screen.findByTestId('catalog-proposal-detail');
    expect(within(pane).getByTestId('catalog-proposal-decision').textContent).toContain(
      '它依赖的平台部分被拒绝或撤销了',
    );
    // Without a gate offered here, the Operation's gate reads by its id.
    expect(within(pane).getByTestId('catalog-proposal-intent-3').textContent).toBe(
      'Operation container.restart（门 docker-a）',
    );
    expect(within(pane).queryByTestId('catalog-proposal-apply-trigger')).toBeNull();
    expect(named(http.calls, 'preview_admin_proposal_segment')).toEqual([]);
  });

  it('is the owner’s alone: anyone else reads whose it is, and nothing is listed', async () => {
    const http = scriptedHttp({ get_workspace: () => MEMBER_WORKSPACE });
    renderTab(http);
    expect((await screen.findByTestId('catalog-proposals-owner-only')).textContent).toContain(
      '只有所有者看得到',
    );
    expect(named(http.calls, 'list_admin_proposal_segments')).toEqual([]);
  });

  it('every segment status reads as its own chip', () => {
    const labels = ['proposed', 'applied', 'rejected', 'withdrawn', 'rolled_back'].map((status) => {
      const style = statusChipStyle('adminProposalSegment', status);
      expect(style.unknown).toBe(false);
      return typeof style.label === 'string' ? style.label : style.label.zh;
    });
    expect(labels).toEqual(['待确认', '已应用', '已拒绝', '已撤回', '已撤销']);
  });
});

/** S11 AA5g-3: a segment asking this workspace to install a pack (`propose_pack_install`). */
const PACK_ASK = received({
  proposal: { ...received().proposal, title: '装上运维基础包', sourceName: 'pack-install' },
  items: [{ kind: 'pack_install', pack: 'ops-base', version: 2 }],
});

function opsBase(patch: Partial<PackWire> = {}): PackWire {
  return {
    name: 'ops-base',
    source: 'builtin',
    summary: '运维基础能力',
    latestVersion: 2,
    versions: [
      {
        version: 2,
        notes: null,
        breaking: false,
        requiredConnectors: [],
        requiredPacks: [],
        components: [],
      },
    ],
    status: 'not_installed',
    installedVersion: null,
    components: [],
    requirements: [],
    dependencies: [],
    ...patch,
  } as PackWire;
}

function opsBasePreview(): PackInstallPreviewWire {
  return {
    pack: opsBase(),
    targetVersion: 2,
    digest: 'sha256:pack-plan',
    unchanged: false,
    crossedVersions: [2],
    breaking: false,
    items: [],
    inUse: { objects: 0, links: 0, capped: false },
  };
}

describe('AdminProposalsTab — a proposal asking for a pack install (S11 AA5g-3)', () => {
  it('is installed through the pack’s own review, with the segment’s id; the proposal then reads applied with its install record', async () => {
    let applied = false;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({
        items: [
          applied
            ? {
                ...PACK_ASK,
                status: 'applied',
                appliedSegmentId: RECORD,
                decidedAt: '2026-11-02T08:00:00.000Z',
              }
            : PACK_ASK,
        ],
      }),
      list_packs: () => ({ items: [opsBase()] }),
      preview_pack_install: () => opsBasePreview(),
      install_pack: () => {
        applied = true;
        return {
          pack: opsBase({ status: 'up_to_date', installedVersion: 2 }),
          segmentId: RECORD,
          verification: null,
        };
      },
    });
    renderTab(http, SEGMENT);

    const review = await screen.findByTestId('catalog-proposal-pack-review');
    expect(within(review).getByTestId('catalog-proposal-pack-ask').textContent).toMatch(
      /请求在本工作区安装能力包 ops-base 的 v2/,
    );
    // Nothing is derived under its source name, so it is not shown.
    expect(screen.getByTestId('catalog-proposal-detail').textContent).not.toContain('来源名');
    // Never the generic proposal review: that one is refused for a pack install.
    expect(named(http.calls, 'preview_admin_proposal_segment')).toEqual([]);
    expect(screen.queryByTestId('catalog-proposal-apply-trigger')).toBeNull();

    fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
    await screen.findByTestId('catalog-pack-preview');
    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    await waitFor(() =>
      expect(named(http.calls, 'install_pack').map((call) => call.params)).toEqual([
        {
          name: 'ops-base',
          version: 2,
          reviewedDigest: 'sha256:pack-plan',
          adminProposalSegmentId: SEGMENT,
        },
      ]),
    );
    expect((await screen.findByTestId('catalog-proposal-status')).textContent).toBe('已应用');
    expect(screen.getByTestId('catalog-proposal-intent-1').textContent).toMatch(
      /^能力包 ops-base v2$/,
    );
    expect(screen.getByTestId('catalog-proposal-record').textContent).toMatch(/安装历史/);
    expect(named(http.calls, 'apply_admin_proposal_segment')).toEqual([]);
  });

  it('a pack with a newer version since says only the latest installs, offers no install and leaves rejecting', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [PACK_ASK] }),
      list_packs: () => ({ items: [opsBase({ latestVersion: 3 })] }),
      reject_admin_proposal_segment: (params) =>
        received({
          ...PACK_ASK,
          status: 'rejected',
          reason: (params as { reason: string }).reason,
          decidedAt: '2026-11-02T08:00:00.000Z',
          decidedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
        }),
    });
    renderTab(http, SEGMENT);

    expect((await screen.findByTestId('catalog-proposal-pack-newer')).textContent).toMatch(
      /最新版本是 v3.*请求的 v2 已经不是最新/,
    );
    expect(screen.queryByTestId('catalog-pack-install-trigger')).toBeNull();

    fireEvent.click(screen.getByTestId('catalog-proposal-reject-trigger'));
    const confirm = await screen.findByTestId('catalog-proposal-reject-confirm');
    fireEvent.change(within(confirm).getByTestId('catalog-proposal-reject-reason'), {
      target: { value: '已经有更新的版本' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: '拒绝' }));
    await waitFor(() =>
      expect(named(http.calls, 'reject_admin_proposal_segment').map((call) => call.params)).toEqual(
        [{ segmentId: SEGMENT, reason: '已经有更新的版本' }],
      ),
    );
    expect(named(http.calls, 'install_pack')).toEqual([]);
  });

  it('a pack already installed at that version, or gone from the deployment, says why there is nothing to install', async () => {
    const installed = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [PACK_ASK] }),
      list_packs: () => ({ items: [opsBase({ status: 'up_to_date', installedVersion: 2 })] }),
    });
    renderTab(installed, SEGMENT);
    expect((await screen.findByTestId('catalog-proposal-pack-installed')).textContent).toMatch(
      /已经装着 ops-base v2/,
    );
    expect(screen.queryByTestId('catalog-pack-install-trigger')).toBeNull();
    cleanup();

    const gone = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [PACK_ASK] }),
      list_packs: () => ({ items: [] }),
    });
    renderTab(gone, SEGMENT);
    expect((await screen.findByTestId('catalog-proposal-pack-gone')).textContent).toMatch(
      /已经没有能力包 ops-base/,
    );
    expect(screen.queryByTestId('catalog-pack-install-trigger')).toBeNull();
  });

  it('an install refused because the workspace was just dropped from the targets says nothing was installed', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [PACK_ASK] }),
      list_packs: () => ({ items: [opsBase()] }),
      preview_pack_install: () => opsBasePreview(),
      install_pack: () => {
        throw new HttpError(
          'capability_error',
          'workspace is no longer among the targets',
          'admin_proposal_target_no_longer_chosen',
        );
      },
    });
    renderTab(http, SEGMENT);

    fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
    await screen.findByTestId('catalog-pack-preview');
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    const confirm = await screen.findByTestId('catalog-pack-install-confirm');
    await waitFor(() =>
      expect(confirm.textContent).toMatch(/从管理员智能体的目标里去掉了，所以什么也没有安装/),
    );
  });

  it('is the owner’s to install or reject: a member reads that and gets no controls', async () => {
    const http = scriptedHttp({
      get_workspace: () => MEMBER_WORKSPACE,
      list_admin_proposal_segments: () => ({ items: [PACK_ASK] }),
      list_packs: () => ({ items: [opsBase()] }),
    });
    renderTab(http, SEGMENT);
    expect((await screen.findByTestId('catalog-proposals-owner-only')).textContent).toMatch(
      /工作区所有者/,
    );
    expect(screen.queryByTestId('catalog-pack-install-trigger')).toBeNull();
    expect(screen.queryByTestId('catalog-proposal-reject-trigger')).toBeNull();
  });
});
