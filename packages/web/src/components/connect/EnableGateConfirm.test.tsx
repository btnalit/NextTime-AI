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
});
