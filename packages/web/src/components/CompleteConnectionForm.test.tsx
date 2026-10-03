// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import type { ConnectionRequestRow } from '../lib/connections.js';
import { HttpError } from '../lib/http-client.js';
import {
  CompleteConnectionForm,
  fieldForInvalidParams,
  parseCredentials,
} from './CompleteConnectionForm.js';

afterEach(cleanup);

const request: ConnectionRequestRow = {
  id: 'cr-1234-5678',
  status: 'requested',
  kind: 'http',
  target: 'https://inventory.example.internal',
  requestedBy: 'principal-b',
  gatekeeperId: null,
  completedBy: null,
  requestedAt: '2026-09-03T00:00:00.000Z',
  completedAt: null,
};

/** R-01: what `mint_connection_secret` answers in these tests. */
const SECRET = `ntgc1_${'a'.repeat(32)}_${'b'.repeat(64)}`;

/** A caller that answers the form's own `mint_connection_secret` (on mount) and hands every other
 *  call to `call`. */
function httpWith(call: (name: string, params: unknown) => Promise<unknown>): CapabilityCaller {
  return {
    call: vi.fn((name: string, params: unknown) =>
      name === 'mint_connection_secret'
        ? Promise.resolve({ connectionSecret: SECRET })
        : call(name, params),
    ) as CapabilityCaller['call'],
  };
}

/** How many `create_connection` calls `http` received. */
function createCalls(http: CapabilityCaller): number {
  return vi.mocked(http.call).mock.calls.filter(([name]) => name === 'create_connection').length;
}

/** The form's submit stays disabled until the connection secret is on screen. */
async function secretShown(): Promise<void> {
  await screen.findByTestId('cc-connection-secret-reveal');
}

describe('CompleteConnectionForm', () => {
  it('prefills kind/target from the request, requires an endpoint, and never submits an invalid form', async () => {
    const http = httpWith(async () => ({}));
    render(
      <CompleteConnectionForm http={http} request={request} onDone={vi.fn()} onCancel={vi.fn()} />,
    );
    await secretShown();

    expect((screen.getByLabelText(/^类型/) as HTMLSelectElement).value).toBe('http');
    expect((screen.getByLabelText(/目标系统/) as HTMLInputElement).value).toBe(request.target);

    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    expect(await screen.findByText('门端点是必填项。')).toBeTruthy();
    const endpoint = screen.getByLabelText(/门端点/) as HTMLInputElement;
    expect(endpoint.getAttribute('aria-invalid')).toBe('true');
    // C16: with the error shown, `Field` no longer renders the hint — the control must point
    // only at the error id, never at a `-hint` id that is not in the DOM.
    expect(endpoint.getAttribute('aria-describedby')).toBe('cc-endpoint-error');
    expect(document.getElementById('cc-endpoint-error')).not.toBeNull();
    expect(createCalls(http)).toBe(0);
  });

  it('C15: rejects a Gatekeeper endpoint that is not a URL, on the field, before any call', async () => {
    const http = httpWith(async () => ({}));
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    const endpoint = screen.getByLabelText(/门端点/) as HTMLInputElement;
    // Before any submit the hint is the only description.
    expect(endpoint.getAttribute('aria-describedby')).toBe('cc-endpoint-hint');

    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: 'erp' } });
    fireEvent.change(endpoint, { target: { value: 'gate-host:8080' } });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    expect(await screen.findByText(/必须是一个 URL/)).toBeTruthy();
    expect(createCalls(http)).toBe(0);

    fireEvent.change(endpoint, { target: { value: 'http://gate-host:8080' } });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    await waitFor(() => expect(createCalls(http)).toBe(1));
  });

  it('shows the credentials box only for connected_account, and requires it there', async () => {
    const http = httpWith(async () => ({}));
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    expect(screen.queryByLabelText(/^凭证(?!类型)/)).toBeNull();

    fireEvent.click(screen.getByLabelText(/已连接账户/));
    expect(screen.getByLabelText(/^凭证(?!类型)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: 'erp' } });
    fireEvent.change(screen.getByLabelText(/门端点/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    expect(await screen.findByText(/连接账户方式需要一份凭证/)).toBeTruthy();
    expect(createCalls(http)).toBe(0);
  });

  it('shows manifest source for http/mcp only', async () => {
    render(
      <CompleteConnectionForm
        http={httpWith(async () => ({}))}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await secretShown();
    expect(screen.getByLabelText(/清单来源/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^类型/), { target: { value: 'ssh' } });
    expect(screen.queryByLabelText(/清单来源/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^类型/), { target: { value: 'mcp' } });
    expect(screen.getByLabelText(/清单来源/)).toBeTruthy();
  });

  it('submits the create_connection params the registry defines, clears credentials, and reports the result', async () => {
    const onDone = vi.fn();
    const http = httpWith(async (name, params) => {
      expect(name).toBe('create_connection');
      expect(params).toEqual({
        connectionRequestId: 'cr-1234-5678',
        kind: 'http',
        target: 'https://inventory.example.internal',
        endpoint: 'http://gate:8080',
        connectionSecret: SECRET,
        credentialKind: 'connected_account',
        credentials: { apiKey: 'k' },
        manifestSource: 'https://inventory.example.internal/openapi.json',
      });
      return {
        gatekeeperId: 'gk-1',
        importedOperationNames: ['stock.get'],
        connectionRequestId: 'cr-1234-5678',
      };
    });
    render(
      <CompleteConnectionForm http={http} request={request} onDone={onDone} onCancel={vi.fn()} />,
    );
    await secretShown();

    fireEvent.change(screen.getByLabelText(/门端点/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByLabelText(/已连接账户/));
    const credentials = screen.getByLabelText(/^凭证(?!类型)/) as HTMLTextAreaElement;
    fireEvent.change(credentials, { target: { value: '{"apiKey":"k"}' } });
    fireEvent.change(screen.getByLabelText(/清单来源/), {
      target: { value: 'https://inventory.example.internal/openapi.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ gatekeeperId: 'gk-1' })),
    );
    expect(credentials.value).toBe('');
  });

  it('shows a 502 manifest_fetch_failed message verbatim and a 400 on the field it names', async () => {
    const http = httpWith(async () => {
      throw new HttpError(
        'capability_error',
        'create_connection: failed to fetch manifestSource "https://x/openapi.json"',
        'manifest_fetch_failed',
      );
    });
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/门端点/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    const banner = await screen.findByRole('alert');
    expect(banner.getAttribute('data-error-code')).toBe('manifest_fetch_failed');
    expect(banner.textContent).toContain('failed to fetch manifestSource "https://x/openapi.json"');
    cleanup();

    const http400 = httpWith(async () => {
      throw new HttpError(
        'capability_error',
        "create_connection: credentialKind is (or defaults to) 'connected_account' but no `credentials` was given",
        'invalid_params',
      );
    });
    render(<CompleteConnectionForm http={http400} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/门端点/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByLabelText(/已连接账户/));
    fireEvent.change(screen.getByLabelText(/^凭证(?!类型)/), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    const fieldError = await screen.findByText(/no `credentials` was given/);
    expect(fieldError.getAttribute('id')).toBe('cc-credentials-error');
  });

  it('hideKindField hides the Kind select and initialKind still drives the submitted kind', async () => {
    const http = httpWith(async (name, params) => {
      expect((params as { kind: string }).kind).toBe('mcp');
      return { gatekeeperId: 'gk-1', importedOperationNames: [], connectionRequestId: null };
    });
    render(
      <CompleteConnectionForm
        http={http}
        initialKind="mcp"
        hideKindField
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await secretShown();
    expect(screen.queryByLabelText(/^类型/)).toBeNull();
    // mcp supports manifestSource, so that field should still render.
    expect(screen.getByLabelText(/清单来源/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/目标系统/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(screen.getByLabelText(/门端点/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    await waitFor(() => expect(createCalls(http)).toBeGreaterThan(0));
  });

  // R-01 (D-01): the gate's own connection secret, minted when the form opens and shown once.
  it('shows the minted connection secret with a copy control before anything is registered', async () => {
    const http = httpWith(async () => ({}));
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    expect(screen.getByTestId('connection-secret-value').textContent).toBe(SECRET);
    expect(screen.getByRole('button', { name: 'Copy connection secret' })).toBeTruthy();
    expect(vi.mocked(http.call).mock.calls.map(([name]) => name)).toEqual([
      'mint_connection_secret',
    ]);
  });

  it('keeps Register disabled and says why when no connection secret could be minted', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new HttpError(
          'capability_error',
          'connection secrets are unavailable',
          'service_unavailable',
        );
      }) as CapabilityCaller['call'],
    };
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText(/无法生成连接密钥/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '注册门' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(createCalls(http)).toBe(0);
  });

  // R-27: an endpoint aimed at the platform's own services is refused on the field it names.
  it('shows a connection_target_refused 400 on the endpoint field', async () => {
    const http = httpWith(async () => {
      throw new HttpError(
        'capability_error',
        'create_connection: endpoint "worker-supervisor" is refused: a single-label host name (a platform service name, localhost) is not reachable from here',
        'connection_target_refused',
      );
    });
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/门端点/), {
      target: { value: 'http://worker-supervisor:8081' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    const fieldError = await screen.findByText(/is refused/);
    expect(fieldError.getAttribute('id')).toBe('cc-endpoint-error');
  });

  it('parses credentials as JSON when they are JSON, raw otherwise; maps 400 messages to fields', () => {
    expect(parseCredentials('{"a":1}')).toEqual({ a: 1 });
    expect(parseCredentials('  token  ')).toBe('token');
    expect(parseCredentials('')).toBeUndefined();
    expect(fieldForInvalidParams('no `credentials` was given')).toBe('credentials');
    expect(fieldForInvalidParams('bad manifestSource')).toBe('manifestSource');
    expect(
      fieldForInvalidParams('invalid params for capability "create_connection"'),
    ).toBeUndefined();
  });
});
