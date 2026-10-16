// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { RefreshOperationGovernanceConfirm } from './RefreshOperationGovernanceConfirm.js';

/**
 * RefreshOperationGovernanceConfirm.test.tsx (closing wave C6, G3, leftover 79's exit): the
 * preview-then-confirm flow in front of `refresh_operation_governance` — the "already aligned"
 * no-op path (no confirm renders), the diff preview + medium confirm, a successful refresh
 * reporting back to the caller, and a refused call (`no_announced_manifest`) rendering inline.
 * R-19 (D-17): the danger case follows the kernel's `direction` only (a lower blast radius and
 * execute → observe count as loosening) with old → new values and plain consequences; R-18 (D-18):
 * the confirm carries the preview's `manifestDigest` back.
 */

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
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

function preview(operationsAlreadyPresent: readonly Record<string, unknown>[] = []) {
  return {
    gateId: 'gate-1',
    wouldLink: null,
    ambiguousCandidates: [],
    operationsToImport: [],
    operationsAlreadyPresent,
    manifestDigest: 'digest-1',
    awaitingPlatformAdoption: null as null | { announcedAt: string; operations: string[] },
  };
}

const ALIGNED_ROW = {
  name: 'stock.get',
  existing: { mode: 'observe', blastRadius: 'low', autoApprovable: true, status: 'published' },
  announced: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
  differs: false,
  definitionDiffers: false,
  direction: 'neutral',
};

function renderConfirm(http: CapabilityCaller, onRefreshed = vi.fn()) {
  render(
    <RefreshOperationGovernanceConfirm
      http={http}
      gatekeeperId="gk-1"
      platformGateId="gate-1"
      gateDisplayName="Docker prod"
      onRefreshed={onRefreshed}
      testId="align-gk-1"
    />,
  );
  return onRefreshed;
}

function confirmButtonIsDanger(confirm: HTMLElement): boolean {
  return within(confirm).getByTestId('confirm-button').className.includes('text-danger');
}

describe('RefreshOperationGovernanceConfirm', () => {
  it('loads the preview on click and, when nothing differs, shows an "already aligned" notice with no confirm', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return preview([
          {
            name: 'container.list',
            existing: {
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
            differs: false,
            direction: 'neutral',
          },
        ]);
      },
    });
    render(
      <RefreshOperationGovernanceConfirm
        http={http}
        gatekeeperId="gk-1"
        platformGateId="gate-1"
        gateDisplayName="Docker prod"
        onRefreshed={vi.fn()}
        testId="align-gk-1"
      />,
    );

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const notice = await screen.findByTestId('align-gk-1-aligned');
    expect(notice.textContent).toContain('已与门的公告一致');
    expect(screen.queryByTestId('align-gk-1-confirm')).toBeNull();
    expect(http.calls.some((call) => call.name === 'refresh_operation_governance')).toBe(false);
  });

  it('UX acceptance of #538: while the platform has not adopted the gate’s new manifest, it never says 「已一致」 — it says who has to adopt it first (a platform admin gets the link)', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([ALIGNED_ROW]),
        awaitingPlatformAdoption: {
          announcedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          operations: ['stock.get'],
        },
      }),
    });
    render(
      <RefreshOperationGovernanceConfirm
        http={http}
        gatekeeperId="gk-1"
        platformGateId="gate-1"
        gateDisplayName="库存"
        onRefreshed={vi.fn()}
        platformAdmin
        testId="align-gk-1"
      />,
    );
    fireEvent.click(screen.getByTestId('align-gk-1'));
    const notice = await screen.findByTestId('align-gk-1-awaiting-adoption');
    expect(notice.textContent).toContain('门公布了新清单（');
    expect(notice.textContent).toContain(
      '平台管理员还没采用。采用之前这里对齐不了，对 stock.get 的调用会被拒绝。',
    );
    expect(
      screen.getByTestId('align-gk-1-awaiting-adoption-adopt-link').getAttribute('href'),
    ).toContain('gate-1');
    expect(screen.queryByTestId('align-gk-1-aligned')).toBeNull();
    expect(screen.queryByTestId('align-gk-1-confirm')).toBeNull();
  });

  it('UX acceptance of #579 (legacy 297): an Operation the gate dropped is never promised back by adoption', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([ALIGNED_ROW]),
        awaitingPlatformAdoption: {
          announcedAt: '2026-10-10T04:00:00.000Z',
          operations: ['orders.cancel', 'stock.get'],
          dropped: ['orders.cancel'],
        },
      }),
    });
    renderConfirm(http);
    fireEvent.click(screen.getByTestId('align-gk-1'));
    const notice = await screen.findByTestId('align-gk-1-awaiting-adoption');
    expect(notice.textContent).toContain('对 stock.get 的调用会被拒绝。');
    expect(notice.textContent).not.toContain('orders.cancel、stock.get');
    expect(screen.getByTestId('align-gk-1-awaiting-adoption-dropped').textContent).toContain(
      '门已经不再提供 orders.cancel，对它的调用会被拒绝，采用和对齐都恢复不了',
    );
  });

  it('UX acceptance of #583 (P3-2): for an Operation the gate dropped, the align offers no revision and no rewrite to publish — only that adoption removes it', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([
          {
            name: 'orders.cancel',
            existing: {
              mode: 'execute',
              blastRadius: 'medium',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'medium', autoApprovable: false },
            differs: false,
            direction: 'neutral',
            definitionDiffers: true,
          },
        ]),
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
            // The kernel never marks a dropped Operation's draft rewritable.
            pendingDraft: { rewritable: false, fromGate: true },
          },
        ],
        awaitingPlatformAdoption: {
          announcedAt: '2026-10-10T04:00:00.000Z',
          operations: ['orders.cancel', 'stock.reserve'],
          dropped: ['orders.cancel', 'stock.reserve'],
        },
      }),
    });
    renderConfirm(http);
    fireEvent.click(screen.getByTestId('align-gk-1'));
    const notice = await screen.findByTestId('align-gk-1-awaiting-adoption');
    expect(screen.getByTestId('align-gk-1-awaiting-adoption-dropped').textContent).toContain(
      '采用和对齐都恢复不了',
    );
    expect(notice.textContent).not.toContain('发布');
    // Neither a revision to publish nor a draft said to wait on the gate's manifest.
    expect(screen.queryByTestId('align-gk-1-confirm')).toBeNull();
    expect(screen.queryByTestId('align-gk-1-held')).toBeNull();
    expect(screen.queryByTestId('align-gk-1-aligned')).toBeNull();
    expect(http.calls.some((call) => call.name === 'refresh_operation_governance')).toBe(false);
  });

  it('UX acceptance of #538: anyone but a platform admin is told who to ask, with no link', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([ALIGNED_ROW]),
        awaitingPlatformAdoption: {
          announcedAt: '2026-10-10T04:00:00.000Z',
          operations: ['stock.get'],
        },
      }),
    });
    renderConfirm(http);
    fireEvent.click(screen.getByTestId('align-gk-1'));
    const notice = await screen.findByTestId('align-gk-1-awaiting-adoption');
    expect(notice.textContent).toContain('请平台管理员在「集成」里采用门的新清单。');
    expect(screen.queryByTestId('align-gk-1-awaiting-adoption-adopt-link')).toBeNull();
    expect(screen.queryByTestId('align-gk-1-aligned')).toBeNull();
  });

  it('shows the drifting operations in a medium confirm; confirming calls refresh_operation_governance with just their names and reports the result', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.restart',
            existing: {
              mode: 'observe',
              blastRadius: 'medium',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
            differs: true,
            direction: 'tightened',
          },
          {
            name: 'container.list',
            existing: {
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
            differs: false,
            direction: 'neutral',
          },
        ]),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          operationNames: ['container.restart'],
          manifestDigest: 'digest-1',
        });
        return {
          gatekeeperId: 'gk-1',
          refreshed: [
            {
              name: 'container.restart',
              before: { mode: 'observe', blastRadius: 'medium', autoApprovable: false },
              after: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
              direction: 'tightened',
            },
          ],
          revisionDrafts: [],
          unchanged: [],
        };
      },
    });
    const onRefreshed = vi.fn();
    render(
      <RefreshOperationGovernanceConfirm
        http={http}
        gatekeeperId="gk-1"
        platformGateId="gate-1"
        gateDisplayName="Docker prod"
        onRefreshed={onRefreshed}
        testId="align-gk-1"
      />,
    );

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    // Only the drifting operation renders in the diff — the unchanged one is not listed.
    expect(within(confirm).getByText('container.restart')).toBeTruthy();
    expect(within(confirm).queryByText('container.list')).toBeNull();
    // A tightening needs no extra warning and no danger styling.
    expect(within(confirm).queryByTestId('align-gk-1-loosens')).toBeNull();
    expect(confirmButtonIsDanger(confirm)).toBe(false);
    expect(within(confirm).getByTestId('governance-diff-list-item').dataset.direction).toBe(
      'tightened',
    );

    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'refresh_operation_governance')).toBe(true),
    );
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
    expect(onRefreshed.mock.calls[0]?.[0]).toMatchObject({ gatekeeperId: 'gk-1' });
    const result = await screen.findByTestId('align-gk-1-result');
    expect(result.textContent).toContain('1');
    expect(within(result).queryByTestId('align-gk-1-drafts')).toBeNull();
  });

  it('legacy K (G1/G2): a changed definition with matching governance is not "aligned" — the confirm says the gate refuses calls until the revision is published, and the result links each draft to the catalog', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.restart',
            existing: {
              mode: 'execute',
              blastRadius: 'medium',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'medium', autoApprovable: false },
            differs: false,
            direction: 'neutral',
            definitionDiffers: true,
          },
          {
            name: 'container.list',
            existing: {
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
            differs: false,
            direction: 'neutral',
            definitionDiffers: false,
          },
        ]),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          operationNames: ['container.restart'],
          manifestDigest: 'digest-1',
        });
        return {
          gatekeeperId: 'gk-1',
          refreshed: [],
          revisionDrafts: [{ name: 'container.restart', version: 2 }],
          unchanged: [],
        };
      },
    });
    const onRefreshed = renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(screen.queryByTestId('align-gk-1-aligned')).toBeNull();
    const redefined = within(confirm).getByTestId('align-gk-1-redefined');
    expect(redefined.textContent).toContain('container.restart');
    expect(redefined.textContent).toContain('门会拒绝对它们的调用');
    expect(redefined.textContent).not.toContain('container.list');
    // No governance change to list, and nothing loosens.
    expect(within(confirm).queryByTestId('governance-diff-list')).toBeNull();
    expect(confirmButtonIsDanger(confirm)).toBe(false);
    expect(confirm.textContent).toContain('container.restart：门运行的定义变了，打开修订草稿');
    expect(confirm.textContent).not.toContain('就地修正');

    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
    const result = await screen.findByTestId('align-gk-1-result');
    expect(result.textContent).not.toContain('已对齐 0');
    const drafts = within(result).getByTestId('align-gk-1-drafts');
    expect(drafts.textContent).toContain('container.restart');
    expect(drafts.textContent).toContain('修订');
    expect(drafts.textContent).toContain('v2');
    expect(drafts.textContent).toContain('发布之前，门会拒绝对它们的调用');
    expect(within(drafts).getByTestId('align-gk-1-draft-link').getAttribute('href')).toBe(
      '#/govern/catalog/operations/gk-1%3A%3Acontainer.restart%40draft',
    );
  });

  it('legacy K: a governance change and a definition change in one alignment — both are sent, only the first is a classification change', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.restart',
            existing: {
              mode: 'observe',
              blastRadius: 'medium',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
            differs: true,
            direction: 'tightened',
            definitionDiffers: true,
          },
          {
            name: 'container.logs',
            existing: {
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
            differs: false,
            direction: 'neutral',
            definitionDiffers: true,
          },
        ]),
      refresh_operation_governance: (params) => {
        expect((params as { operationNames: string[] }).operationNames).toEqual([
          'container.restart',
          'container.logs',
        ]);
        return {
          gatekeeperId: 'gk-1',
          refreshed: [
            {
              name: 'container.restart',
              before: { mode: 'observe', blastRadius: 'medium', autoApprovable: false },
              after: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
              direction: 'tightened',
            },
          ],
          revisionDrafts: [
            { name: 'container.restart', version: 3 },
            { name: 'container.logs', version: 2 },
          ],
          unchanged: [],
        };
      },
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(within(confirm).getAllByTestId('governance-diff-list-item')).toHaveLength(1);
    expect(confirm.textContent).toContain('就地修正');
    const redefined = within(confirm).getByTestId('align-gk-1-redefined');
    expect(redefined.textContent).toContain('container.restart、container.logs');

    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const result = await screen.findByTestId('align-gk-1-result');
    expect(result.textContent).toContain('已对齐');
    expect(result.textContent).toContain('1');
    expect(within(result).getAllByTestId('align-gk-1-draft-link')).toHaveLength(2);
  });

  it('auto-approve switched on at high impact is a loosening, said accurately (high still needs a person)', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.restart',
            existing: {
              mode: 'execute',
              blastRadius: 'high',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'high', autoApprovable: true },
            differs: true,
            direction: 'loosened',
          },
        ]),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    expect(confirmButtonIsDanger(confirm)).toBe(true);
    const warning = within(confirm).getByTestId('align-gk-1-loosens');
    expect(warning.textContent).toContain('container.restart');
    expect(warning.textContent).toContain('高影响仍必须人工审批');
  });

  it('R-19 scenario A: high → low blast radius is a loosening — danger, old → new, and no longer mandatory approval', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'db.restart',
            existing: {
              mode: 'execute',
              blastRadius: 'high',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'low', autoApprovable: true },
            differs: true,
            direction: 'loosened',
          },
        ]),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(confirmButtonIsDanger(confirm)).toBe(true);
    // Old → new in the impact line, from the shared status labels.
    expect(confirm.textContent).toContain('db.restart: 影响级');
    expect(confirm.textContent).toMatch(/影响级 \S+ → \S+/);
    const warning = within(confirm).getByTestId('align-gk-1-loosens');
    expect(warning.textContent).toContain('不再是高影响');
    expect(warning.textContent).toContain('请求者可以批准自己的请求');
    expect(warning.textContent).toContain('自动批准策略可以直接放行');
    expect(within(confirm).getByTestId('governance-diff-list-item').dataset.direction).toBe(
      'loosened',
    );
  });

  it('R-19 scenario B: execute → observe says it needs no grant either, and the description no longer claims who may call is unchanged', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.remove',
            existing: {
              mode: 'execute',
              blastRadius: 'medium',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'medium', autoApprovable: false },
            differs: true,
            direction: 'loosened',
          },
        ]),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(confirmButtonIsDanger(confirm)).toBe(true);
    const warning = within(confirm).getByTestId('align-gk-1-loosens');
    expect(warning.textContent).toContain('不再需要授权');
    expect(confirm.textContent).not.toContain('不改变谁能调用这个系统');
  });

  it('follows the kernel direction, never its own ranking: a mixed change is a danger case', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.exec',
            existing: {
              mode: 'execute',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'high', autoApprovable: true },
            differs: true,
            direction: 'mixed',
          },
        ]),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(confirmButtonIsDanger(confirm)).toBe(true);
    expect(within(confirm).getByTestId('align-gk-1-loosens')).toBeTruthy();
  });

  it('R-18: a manifest that changed after the preview is refused with its own copy', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.restart',
            existing: {
              mode: 'execute',
              blastRadius: 'high',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'medium', autoApprovable: false },
            differs: true,
            direction: 'loosened',
          },
        ]),
      refresh_operation_governance: () => {
        throw new HttpError('capability_error', 'changed', 'manifest_changed');
      },
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const error = await within(confirm).findByTestId('confirm-error');
    expect(error.textContent).toContain('门的清单在你查看之后变了');
  });

  it('review #501 on #577 ①: a preview handed in serves the first open only — after a manifest_changed refusal, reopening reads it again and sends the new digest', async () => {
    const held = {
      name: 'stock.reserve',
      mode: 'execute',
      blastRadius: 'medium',
      autoApprovable: false,
      pendingDraft: { rewritable: true, fromGate: true },
    } as const;
    const stale = {
      gateId: 'gate-1',
      wouldLink: null,
      ambiguousCandidates: [],
      operationsToImport: [held],
      operationsAlreadyPresent: [],
      manifestDigest: 'digest-old',
      awaitingPlatformAdoption: null,
    };
    const sentDigests: string[] = [];
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview(),
        operationsToImport: [held],
        manifestDigest: 'digest-new',
      }),
      refresh_operation_governance: (params) => {
        const { manifestDigest } = params as { manifestDigest: string };
        sentDigests.push(manifestDigest);
        if (manifestDigest === 'digest-old') {
          throw new HttpError('capability_error', 'changed', 'manifest_changed');
        }
        return {
          gatekeeperId: 'gk-1',
          refreshed: [],
          revisionDrafts: [{ name: 'stock.reserve', version: 2 }],
          unchanged: [],
        };
      },
    });
    const onRefreshed = vi.fn();
    render(
      <RefreshOperationGovernanceConfirm
        http={http}
        gatekeeperId="gk-1"
        platformGateId="gate-1"
        gateDisplayName="Docker prod"
        onRefreshed={onRefreshed}
        operationNames={['stock.reserve']}
        preview={stale}
        testId="align-one"
      />,
    );

    fireEvent.click(screen.getByTestId('align-one'));
    let confirm = await screen.findByTestId('align-one-confirm');
    expect(http.calls.filter((c) => c.name === 'preview_gate_instance_enable')).toHaveLength(0);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await within(confirm).findByTestId('confirm-error');
    fireEvent.click(within(confirm).getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('align-one-confirm')).toBeNull());

    fireEvent.click(screen.getByTestId('align-one'));
    confirm = await screen.findByTestId('align-one-confirm');
    expect(http.calls.filter((c) => c.name === 'preview_gate_instance_enable')).toHaveLength(1);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
    expect(sentDigests).toEqual(['digest-old', 'digest-new']);
  });

  it('maps no_announced_manifest on the confirmed call to its bilingual copy', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            name: 'container.restart',
            existing: {
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
            differs: true,
            direction: 'tightened',
          },
        ]),
      refresh_operation_governance: () => {
        throw new HttpError('capability_error', 'no manifest', 'no_announced_manifest');
      },
    });
    render(
      <RefreshOperationGovernanceConfirm
        http={http}
        gatekeeperId="gk-1"
        platformGateId="gate-1"
        gateDisplayName="Docker prod"
        onRefreshed={vi.fn()}
        testId="align-gk-1"
      />,
    );

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const error = await within(confirm).findByTestId('confirm-error');
    expect(error.textContent).toContain('没有可对齐的公告清单');
  });
  it('console G4: a draft held back for a gate-owned param, once the gate’s manifest drops it, is rewritten by the align — said in the confirm, sent with the rest, linked to the catalog after', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([ALIGNED_ROW]),
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            pendingDraft: { rewritable: true },
          },
          // New on the gate, never imported here: not this align's concern.
          { name: 'stock.audit', mode: 'observe', blastRadius: 'low', autoApprovable: true },
        ],
      }),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          operationNames: ['stock.reserve'],
          manifestDigest: 'digest-1',
        });
        return {
          gatekeeperId: 'gk-1',
          refreshed: [],
          revisionDrafts: [{ name: 'stock.reserve', version: 1 }],
          unchanged: [],
        };
      },
    });
    const onRefreshed = renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(within(confirm).getByTestId('align-gk-1-rewrites').textContent).toContain(
      'stock.reserve',
    );
    expect(confirm.textContent).toContain('stock.reserve：门的清单改了，按新清单重写待发布的草稿');
    expect(confirm.textContent).not.toContain('stock.audit');

    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
    const result = await screen.findByTestId('align-gk-1-result');
    // A rewritten draft is not a revision of a published version.
    expect(within(result).queryByTestId('align-gk-1-drafts')).toBeNull();
    const rewritten = within(result).getByTestId('align-gk-1-rewritten');
    expect(rewritten.textContent).toContain('已按门的新清单重写 1 份待发布的草稿');
    expect(within(rewritten).getByTestId('align-gk-1-rewritten-link').getAttribute('href')).toBe(
      '#/govern/catalog/operations/gk-1%3A%3Astock.reserve',
    );
  });

  it('console G4: a held draft the gate still announces with the param is not 「已一致」 — it names the param and who fixes it', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([ALIGNED_ROW]),
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
            pendingDraft: { rewritable: false },
          },
        ],
      }),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const held = await screen.findByTestId('align-gk-1-held');
    expect(held.textContent).toContain('门的清单还没改');
    expect(held.textContent).toContain('stock.reserve：Authorization（请求头）');
    expect(held.textContent).toContain('门的维护者');
    expect(screen.queryByTestId('align-gk-1-aligned')).toBeNull();
    expect(screen.queryByTestId('align-gk-1-confirm')).toBeNull();
    expect(http.calls.some((call) => call.name === 'refresh_operation_governance')).toBe(false);
  });

  it('review #501 on #571 ①: an agent’s or member’s proposal is never said to wait on the gate', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([ALIGNED_ROW]),
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
            pendingDraft: { rewritable: false, fromGate: false },
          },
        ],
      }),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    await screen.findByTestId('align-gk-1-aligned');
    expect(screen.queryByTestId('align-gk-1-held')).toBeNull();
  });

  it('review #501 on #571 ③: a revision whose new definition declares a gate-owned param is said to stay a draft, before the align opens it', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            ...ALIGNED_ROW,
            name: 'orders.lookup',
            definitionDiffers: true,
            gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
          },
        ]),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(confirm.textContent).toContain(
      'orders.lookup：打开的修订发布不了，新定义声明了只能由门自己设置的参数 Authorization（请求头）',
    );
  });

  it('UX acceptance of #573 P2: a held revision is kept out of "calls resume once published", in the confirm and in the result', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        preview([
          {
            ...ALIGNED_ROW,
            name: 'orders.lookup',
            definitionDiffers: true,
            gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
          },
          { ...ALIGNED_ROW, name: 'orders.list', definitionDiffers: true },
        ]),
      refresh_operation_governance: () => ({
        gatekeeperId: 'gk-1',
        refreshed: [],
        revisionDrafts: [
          { name: 'orders.lookup', version: 2 },
          { name: 'orders.list', version: 2 },
        ],
        unchanged: [],
      }),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    const redefined = within(confirm).getByTestId('align-gk-1-redefined');
    expect(redefined.textContent).toContain('orders.list');
    expect(redefined.textContent).not.toContain('orders.lookup');
    expect(within(confirm).getByTestId('align-gk-1-redefined-held').textContent).toContain(
      '门的维护者去掉这些参数、平台采用改好的清单之前，门会一直拒绝对它们的调用',
    );
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    const drafts = await screen.findByTestId('align-gk-1-drafts');
    expect(drafts.textContent).toContain('orders.list');
    expect(drafts.textContent).not.toContain('orders.lookup');
    const held = screen.getByTestId('align-gk-1-held-drafts');
    expect(held.textContent).toContain('orders.lookup');
    expect(held.textContent).toContain('Authorization（请求头）');
    expect(held.textContent).toContain('对它们的调用不会恢复');
    expect(within(held).getByTestId('align-gk-1-held-draft-link').textContent).toBe(
      '去能力目录看说明',
    );
  });

  it('review #501 on #573: a rewrite that keeps the gate-owned param still runs, and says the draft still cannot be published', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([]),
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'high',
            autoApprovable: false,
            gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
            pendingDraft: { rewritable: true, fromGate: true },
          },
        ],
      }),
    });
    renderConfirm(http);

    fireEvent.click(screen.getByTestId('align-gk-1'));
    const confirm = await screen.findByTestId('align-gk-1-confirm');
    expect(confirm.textContent).toContain(
      'stock.reserve：门的清单改了，按新清单重写待发布的草稿；新清单仍声明只能由门自己设置的参数 Authorization（请求头），重写后仍发布不了',
    );
    expect(within(confirm).queryByTestId('align-gk-1-rewrites')).toBeNull();
  });

  it('console G4: narrowed to one draft (the catalog’s), it aligns only that one, under its own label', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => ({
        ...preview([{ ...ALIGNED_ROW, name: 'stock.get', definitionDiffers: true }]),
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            pendingDraft: { rewritable: true },
          },
        ],
      }),
      refresh_operation_governance: (params) => {
        expect((params as { operationNames: string[] }).operationNames).toEqual(['stock.reserve']);
        return {
          gatekeeperId: 'gk-1',
          refreshed: [],
          revisionDrafts: [{ name: 'stock.reserve', version: 1 }],
          unchanged: [],
        };
      },
    });
    const onRefreshed = vi.fn();
    render(
      <RefreshOperationGovernanceConfirm
        http={http}
        gatekeeperId="gk-1"
        platformGateId="gate-1"
        gateDisplayName="Docker prod"
        onRefreshed={onRefreshed}
        operationNames={['stock.reserve']}
        label="按门的最新清单重写"
        testId="align-one"
      />,
    );

    expect(screen.getByTestId('align-one').textContent).toBe('按门的最新清单重写');
    fireEvent.click(screen.getByTestId('align-one'));
    const confirm = await screen.findByTestId('align-one-confirm');
    expect(confirm.textContent).not.toContain('stock.get');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
  });
});
