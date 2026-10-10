// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { EnableGateConfirm } from './EnableGateConfirm.js';

/**
 * EnableGateConfirm.test.tsx (S8 W2-U1, audit J3/J4): the preview-then-confirm flow in front of
 * `enable_gate_instance`, over scripted capabilities — preview rendering (operations to import
 * incl. high-impact marking, operations already present incl. `differs`, a `wouldLink` legacy
 * association with drift), the ambiguous-endpoint block (no confirm renders at all), and a
 * successful enable calling back with the result.
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

function emptyPreview(overrides: Record<string, unknown> = {}) {
  return {
    gateId: 'gate-1',
    wouldLink: null,
    ambiguousCandidates: [],
    operationsToImport: [],
    operationsAlreadyPresent: [],
    awaitingPlatformAdoption: null,
    ...overrides,
  };
}

describe('EnableGateConfirm', () => {
  it('loads the preview on click and opens a medium confirm; confirming calls enable_gate_instance and reports the result', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return emptyPreview({
          operationsToImport: [
            {
              name: 'container.restart',
              mode: 'execute',
              blastRadius: 'high',
              autoApprovable: false,
            },
            { name: 'container.list', mode: 'observe', blastRadius: 'low', autoApprovable: true },
          ],
        });
      },
      enable_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return {
          gateId: 'gate-1',
          gatekeeperId: 'gk-1',
          publishedOperationNames: ['container.restart', 'container.list'],
          skippedOperationNames: [],
          linkedExisting: false,
        };
      },
    });
    const onEnabled = vi.fn();
    render(
      <EnableGateConfirm
        http={http}
        gateId="gate-1"
        gateDisplayName="Docker prod"
        onEnabled={onEnabled}
        testId="enable-gate-1"
      />,
    );

    fireEvent.click(screen.getByTestId('enable-gate-1'));
    const confirm = await screen.findByTestId('enable-gate-1-confirm');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    // Both the to-import operations render, with the execute/high one visibly marked.
    expect(within(confirm).getByText('container.restart')).toBeTruthy();
    expect(within(confirm).getByText('container.list')).toBeTruthy();
    expect(within(confirm).getAllByTestId('enable-preview-high-impact')).toHaveLength(1);
    // No prior registration — the confirm label is the "register" one, not "link".
    expect(within(confirm).getByTestId('confirm-button').textContent).toContain('注册并启用');

    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'enable_gate_instance')).toBe(true),
    );
    await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1));
    expect(onEnabled.mock.calls[0]?.[0]).toMatchObject({ gatekeeperId: 'gk-1' });
  });

  it('J4: operationsAlreadyPresent with differs is flagged, and wouldLink shows the drift + a different confirm label', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        emptyPreview({
          wouldLink: {
            gatekeeperId: 'gk-legacy',
            drift: { name: { existing: 'old-name', instance: 'new-name' } },
          },
          operationsAlreadyPresent: [
            {
              name: 'container.restart',
              existing: {
                mode: 'execute',
                blastRadius: 'medium',
                autoApprovable: false,
                status: 'published',
              },
              announced: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
              differs: true,
            },
          ],
        }),
      resolve_refs: () => ({
        items: [{ id: 'gk-legacy', kind: 'gatekeeper', name: 'docker-gate (legacy)' }],
      }),
      enable_gate_instance: () => ({
        gateId: 'gate-1',
        gatekeeperId: 'gk-legacy',
        publishedOperationNames: [],
        skippedOperationNames: ['container.restart'],
        linkedExisting: true,
      }),
    });
    render(
      <EnableGateConfirm
        http={http}
        gateId="gate-1"
        gateDisplayName="Docker prod"
        onEnabled={vi.fn()}
        testId="enable-gate-1"
      />,
    );

    fireEvent.click(screen.getByTestId('enable-gate-1'));
    const confirm = await screen.findByTestId('enable-gate-1-confirm');
    expect(within(confirm).getByTestId('enable-preview-would-link').textContent).toContain(
      '不会新建',
    );
    expect(within(confirm).getByTestId('enable-preview-drift').textContent).toContain('old-name');
    expect(within(confirm).getByTestId('enable-preview-drift').textContent).toContain('new-name');
    expect(within(confirm).getByTestId('enable-preview-differs')).toBeTruthy();
    expect(within(confirm).getByTestId('confirm-button').textContent).toContain('关联并启用');
  });

  it('UX acceptance of #538: enabling while the gate’s new manifest waits for the platform says calls to those Operations will be refused until it is adopted', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        emptyPreview({
          operationsToImport: [
            { name: 'stock.get', mode: 'observe', blastRadius: 'low', autoApprovable: true },
          ],
          awaitingPlatformAdoption: {
            announcedAt: '2026-10-10T04:00:00.000Z',
            operations: ['stock.get'],
          },
        }),
    });
    render(
      <EnableGateConfirm
        http={http}
        gateId="gate-1"
        gateDisplayName="库存"
        onEnabled={vi.fn()}
        testId="enable-gate-1"
      />,
    );
    fireEvent.click(screen.getByTestId('enable-gate-1'));
    const confirm = await screen.findByTestId('enable-gate-1-confirm');
    const notice = within(confirm).getByTestId('enable-gate-1-awaiting-adoption');
    expect(notice.textContent).toContain(
      '平台管理员还没采用。现在启用的话，采用之前对 stock.get 的调用会被拒绝。',
    );
    // Not a platform admin: told who to ask, no link.
    expect(notice.textContent).toContain('请平台管理员在「集成」里采用门的新清单。');
    expect(within(confirm).queryByTestId('enable-gate-1-awaiting-adoption-adopt-link')).toBeNull();
  });

  it('J4: ambiguousCandidates blocks the confirm entirely — only the notice renders', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => emptyPreview({ ambiguousCandidates: ['gk-a', 'gk-b'] }),
      resolve_refs: () => ({
        items: [
          { id: 'gk-a', kind: 'gatekeeper', name: 'docker-a' },
          { id: 'gk-b', kind: 'gatekeeper', name: 'docker-b' },
        ],
      }),
    });
    render(
      <EnableGateConfirm
        http={http}
        gateId="gate-1"
        gateDisplayName="Docker prod"
        onEnabled={vi.fn()}
        testId="enable-gate-1"
      />,
    );

    fireEvent.click(screen.getByTestId('enable-gate-1'));
    const notice = await screen.findByTestId('enable-gate-1-ambiguous');
    expect(notice.textContent).toContain('无法确定关联哪一个');
    expect(screen.queryByTestId('enable-gate-1-confirm')).toBeNull();
    expect(http.calls.some((call) => call.name === 'enable_gate_instance')).toBe(false);
  });

  it('maps a known platform wire code on the confirmed call to its bilingual copy', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => emptyPreview(),
      enable_gate_instance: () => {
        throw new HttpError('capability_error', 'not preset', 'connector_not_preset');
      },
    });
    render(
      <EnableGateConfirm
        http={http}
        gateId="gate-1"
        gateDisplayName="Docker prod"
        onEnabled={vi.fn()}
        testId="enable-gate-1"
      />,
    );

    fireEvent.click(screen.getByTestId('enable-gate-1'));
    const confirm = await screen.findByTestId('enable-gate-1-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const error = await within(confirm).findByTestId('confirm-error');
    expect(error.textContent).toContain('不是平台预置模式');
  });

  it('L4-13: a preview refused as gatekeeper_already_linked explains why and opens no confirm', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () => {
        throw new HttpError(
          'capability_error',
          'Gatekeeper gk-a … is already linked to gate instance "gate-0"',
          'gatekeeper_already_linked',
        );
      },
    });
    render(
      <EnableGateConfirm
        http={http}
        gateId="gate-1"
        gateDisplayName="Docker prod"
        onEnabled={vi.fn()}
        testId="enable-gate-1"
      />,
    );

    fireEvent.click(screen.getByTestId('enable-gate-1'));
    const notice = await screen.findByTestId('enable-gate-1-preview-error');
    expect(notice.textContent).toContain('一个门只能关联一个实例');
    expect(screen.queryByTestId('enable-gate-1-confirm')).toBeNull();
  });
});
