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
  };
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
          },
        ]),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          operationNames: ['container.restart'],
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
    // A tightening needs no extra warning.
    expect(within(confirm).queryByTestId('align-gk-1-loosens')).toBeNull();

    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'refresh_operation_governance')).toBe(true),
    );
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
    expect(onRefreshed.mock.calls[0]?.[0]).toMatchObject({ gatekeeperId: 'gk-1' });
    const result = await screen.findByTestId('align-gk-1-result');
    expect(result.textContent).toContain('1');
  });

  it('calls out an Operation that would stop needing approval (auto-approve switched on)', async () => {
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
          },
        ]),
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
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    const warning = within(confirm).getByTestId('align-gk-1-loosens');
    expect(warning.textContent).toContain('container.restart');
    expect(warning.textContent).toContain('不再需要人工审批');
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
});
