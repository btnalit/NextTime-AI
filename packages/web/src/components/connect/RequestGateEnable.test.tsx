// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { RequestGateEnable } from './RequestGateEnable.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem('nexttime.lang');
});

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

const ASKED = { id: 'cr-7', requestedAt: '2026-11-19T08:00:00.000Z' };

function requestWire() {
  return {
    id: ASKED.id,
    status: 'requested',
    kind: 'http',
    gateInstance: { gateId: 'stock', displayName: '库存' },
    requestedBy: 'p-self',
    gatekeeperId: null,
    completedBy: null,
    requestedAt: ASKED.requestedAt,
    completedAt: null,
  };
}

describe('RequestGateEnable (legacy 254): a member asks the owner to enable a platform instance', () => {
  it('asks once on click and then says it is asked, with when; the caller is told', async () => {
    const http = scriptedHttp({ request_gate_instance_enable: () => requestWire() });
    const onChange = vi.fn();
    render(
      <RequestGateEnable
        compact
        http={http}
        gateId="stock"
        gateName="库存"
        myEnableRequest={undefined}
        onChange={onChange}
        testId="req"
      />,
    );
    expect(screen.getByTestId('req-state').textContent).toBe('由工作区所有者启用');
    fireEvent.click(screen.getByTestId('req-ask'));
    await waitFor(() =>
      expect(screen.getByTestId('req-state').textContent).toBe('已申请，等所有者启用'),
    );
    expect(http.calls).toEqual([
      { name: 'request_gate_instance_enable', params: { gateId: 'stock' } },
    ]);
    expect(onChange).toHaveBeenCalledWith(ASKED);
    expect(screen.getByTestId('req-requested-at').getAttribute('dateTime')).toBe(ASKED.requestedAt);
    expect(screen.queryByTestId('req-ask')).toBeNull();
    expect(screen.getByTestId('req-withdraw')).toBeTruthy();
  });

  it('「已申请」 comes from the server read: after a refresh it shows with no call, and goes once a later read has none', () => {
    const http = scriptedHttp({});
    const view = render(
      <RequestGateEnable
        compact
        http={http}
        gateId="stock"
        gateName="库存"
        myEnableRequest={ASKED}
        testId="req"
      />,
    );
    expect(screen.getByTestId('req-state').textContent).toBe('已申请，等所有者启用');
    expect(http.calls).toEqual([]);
    // Declined, or withdrawn in another tab: the next read has no open request.
    view.rerender(
      <RequestGateEnable
        compact
        http={http}
        gateId="stock"
        gateName="库存"
        myEnableRequest={undefined}
        testId="req"
      />,
    );
    expect(screen.getByTestId('req-state').textContent).toBe('由工作区所有者启用');
    expect(screen.getByTestId('req-ask')).toBeTruthy();
  });

  it('撤回 asks first; confirming withdraws that request and offers asking again', async () => {
    const http = scriptedHttp({
      cancel_connection_request: () => ({
        ...requestWire(),
        status: 'cancelled',
        cancelReason: 'withdrawn',
        cancelledAt: '2026-11-19T09:00:00.000Z',
      }),
    });
    const onChange = vi.fn();
    render(
      <RequestGateEnable
        compact
        http={http}
        gateId="stock"
        gateName="库存"
        myEnableRequest={ASKED}
        onChange={onChange}
        testId="req"
      />,
    );
    fireEvent.click(screen.getByTestId('req-withdraw'));
    const confirm = await screen.findByTestId('req-withdraw-confirm');
    expect(http.calls).toEqual([]);
    expect(confirm.textContent).toContain('撤回启用申请');
    expect(confirm.textContent).toContain('库存');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(screen.getByTestId('req-ask')).toBeTruthy());
    expect(http.calls).toEqual([
      { name: 'cancel_connection_request', params: { connectionRequestId: 'cr-7' } },
    ]);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('a request already answered cannot be withdrawn: the confirm says to refresh, and 「已申请」 stays until the next read', async () => {
    const http = scriptedHttp({
      cancel_connection_request: () => {
        throw new HttpError('capability_error', 'not requested', 'illegal_transition');
      },
    });
    render(
      <RequestGateEnable
        compact
        http={http}
        gateId="stock"
        gateName="库存"
        myEnableRequest={ASKED}
        testId="req"
      />,
    );
    fireEvent.click(screen.getByTestId('req-withdraw'));
    const confirm = await screen.findByTestId('req-withdraw-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(confirm.textContent).toContain('刷新后再看'));
    expect(screen.getByTestId('req-state').textContent).toBe('已申请，等所有者启用');
  });

  it.each([
    ['gate_already_enabled', '本工作区已经启用了这个门实例'],
    ['gate_not_enabled', '平台侧现在没有启用这个门实例'],
    ['connector_not_preset', '不再向工作区开放'],
    ['gate_not_found', '平台目录里已经没有这个门实例'],
  ])(
    'a refused request (%s) says why in this place’s words and stays unasked',
    async (code, text) => {
      const http = scriptedHttp({
        request_gate_instance_enable: () => {
          throw new HttpError('capability_error', 'refused', code);
        },
      });
      render(
        <RequestGateEnable
          compact
          http={http}
          gateId="stock"
          gateName="库存"
          myEnableRequest={undefined}
          testId="req"
        />,
      );
      fireEvent.click(screen.getByTestId('req-ask'));
      const error = await screen.findByTestId('req-error');
      expect(error.textContent).toContain(text);
      expect(error.getAttribute('data-error-code')).toBe(code);
      expect(screen.getByTestId('req-state').textContent).toBe('由工作区所有者启用');
    },
  );

  it('the full notice (the launcher) says where the owner sees it, in English too', () => {
    localStorage.setItem('nexttime.lang', 'en');
    render(
      <LangProvider>
        <RequestGateEnable
          http={scriptedHttp({})}
          gateId="stock"
          gateName="Stock"
          myEnableRequest={undefined}
          testId="req"
        />
      </LangProvider>,
    );
    expect(screen.getByTestId('req-state').textContent).toContain(
      'Systems & access → Connection requests',
    );
    expect(screen.getByTestId('req-ask').textContent).toBe('Ask to enable');
  });
});
