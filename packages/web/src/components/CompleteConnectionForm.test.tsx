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
    // The error says what a valid value looks like.
    expect(
      await screen.findByText(/门端点是必填项：填门自己的地址，例如 http:\/\/gate-host:8080/),
    ).toBeTruthy();
    const endpoint = screen.getByLabelText(/门端点/) as HTMLInputElement;
    expect(endpoint.getAttribute('aria-invalid')).toBe('true');
    // C16: `Field` now renders the hint alongside the error — the control points at both ids,
    // each of which is in the DOM.
    expect(endpoint.getAttribute('aria-describedby')).toBe('cc-endpoint-hint cc-endpoint-error');
    expect(document.getElementById('cc-endpoint-hint')).not.toBeNull();
    expect(document.getElementById('cc-endpoint-error')).not.toBeNull();
    expect(createCalls(http)).toBe(0);
  });

  it('C15: an endpoint without a scheme gets http:// on blur (with a note) instead of an error; a malformed one is still refused', async () => {
    const http = httpWith(async (_name, params) => {
      expect((params as { endpoint: string }).endpoint).toBe('http://gate-host:8080');
      return {};
    });
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    const endpoint = screen.getByLabelText(/门端点/) as HTMLInputElement;
    // Before any submit the hint is the only description.
    expect(endpoint.getAttribute('aria-describedby')).toBe('cc-endpoint-hint');

    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: 'erp' } });
    // Malformed even with a scheme (a space in the host): refused on the field, with the shape.
    fireEvent.change(endpoint, { target: { value: 'gate host:8080' } });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    expect(
      await screen.findByText(/需要一个完整的地址，例如 http:\/\/gate-host:8080/),
    ).toBeTruthy();
    expect(createCalls(http)).toBe(0);

    fireEvent.change(endpoint, { target: { value: 'gate-host:8080' } });
    fireEvent.blur(endpoint);
    expect(endpoint.value).toBe('http://gate-host:8080');
    expect(screen.getByTestId('cc-endpoint-scheme-note').textContent).toContain('http://');
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

  it('offers <target>/openapi.json as a one-click manifest source for an http gate, never sets it silently', async () => {
    const http = httpWith(async (_name, params) => {
      expect((params as { manifestSource?: string }).manifestSource).toBe(
        'https://erp.example.com/api/openapi.json',
      );
      return {};
    });
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    const manifest = screen.getByLabelText(/清单来源/) as HTMLInputElement;
    // No target yet: nothing to suggest.
    expect(screen.queryByTestId('cc-manifest-suggest')).toBeNull();
    fireEvent.change(screen.getByLabelText(/目标系统/), {
      target: { value: 'erp.example.com/api/' },
    });
    const suggest = screen.getByTestId('cc-manifest-suggest');
    expect(suggest.textContent).toBe('使用 https://erp.example.com/api/openapi.json');
    expect(manifest.value).toBe('');
    fireEvent.click(suggest);
    expect(manifest.value).toBe('https://erp.example.com/api/openapi.json');
    expect(screen.queryByTestId('cc-manifest-suggest')).toBeNull();

    // Only http imports an OpenAPI document; an mcp gate gets no such suggestion.
    fireEvent.change(screen.getByLabelText(/^类型/), { target: { value: 'mcp' } });
    expect(screen.queryByTestId('cc-manifest-suggest')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^类型/), { target: { value: 'http' } });
    // A target that is not a host gives no suggestion either.
    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: '://bad url' } });
    expect(screen.queryByTestId('cc-manifest-suggest')).toBeNull();
    fireEvent.change(screen.getByLabelText(/目标系统/), {
      target: { value: 'erp.example.com/api/' },
    });

    fireEvent.change(screen.getByLabelText(/门端点/), { target: { value: 'http://gate:8080' } });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    await waitFor(() => expect(createCalls(http)).toBe(1));
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
    // A Chinese explanation leads; the kernel's raw English text is kept as the secondary detail.
    expect(fieldError.textContent?.startsWith('门没有接受这份凭证')).toBe(true);
    expect(fieldError.textContent).toContain('服务端原文：');
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
    expect(screen.getByRole('button', { name: '复制连接密钥' })).toBeTruthy();
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
    expect(fieldError.textContent).toContain('指向平台自身的服务');
  });

  it('picks "on behalf of" from list_principals (active humans only) and submits the chosen id', async () => {
    const http = httpWith(async (name, params) => {
      if (name === 'list_principals') {
        return {
          items: [
            {
              id: 'p-alice',
              kind: 'human',
              role: 'member',
              displayName: 'Alice',
              createdAt: '',
              hasApiKey: false,
            },
            {
              id: 'principal-b',
              kind: 'human',
              role: 'operator',
              displayName: 'Bob',
              createdAt: '',
              hasApiKey: false,
            },
            {
              id: 'p-gone',
              kind: 'human',
              role: 'member',
              displayName: 'Gone',
              createdAt: '',
              hasApiKey: false,
              disabledAt: '2026-09-01T00:00:00.000Z',
            },
            {
              id: 'p-svc',
              kind: 'service',
              role: 'member',
              displayName: 'svc',
              createdAt: '',
              hasApiKey: true,
            },
          ],
        };
      }
      expect(name).toBe('create_connection');
      expect((params as { onBehalfOf?: string }).onBehalfOf).toBe('p-alice');
      return { gatekeeperId: 'gk-1', importedOperationNames: [], connectionRequestId: null };
    });
    render(
      <CompleteConnectionForm http={http} request={request} onDone={vi.fn()} onCancel={vi.fn()} />,
    );
    await secretShown();
    // Not read until a per-member credential is chosen.
    expect(vi.mocked(http.call).mock.calls.some(([name]) => name === 'list_principals')).toBe(
      false,
    );
    fireEvent.click(screen.getByLabelText(/已连接账户/));
    const select = (await screen.findByTestId('cc-obo-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelector('option[value="p-alice"]')).not.toBeNull());
    // The default names the requester; disabled and non-human principals are not offered.
    expect(select.options[0]?.textContent).toMatch(/^默认：申请人\s*Bob$/);
    expect(select.querySelector('option[value="p-gone"]')).toBeNull();
    expect(select.querySelector('option[value="p-svc"]')).toBeNull();
    fireEvent.change(select, { target: { value: 'p-alice' } });

    fireEvent.change(screen.getByLabelText(/门端点/), { target: { value: 'http://gate:8080' } });
    fireEvent.change(screen.getByLabelText(/^凭证(?!类型)/), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: '注册门' }));
    await waitFor(() => expect(createCalls(http)).toBe(1));
  });

  it('falls back to a manual principal-id box when list_principals cannot be read', async () => {
    const http = httpWith(async (name) => {
      if (name === 'list_principals') {
        throw new HttpError('capability_error', 'forbidden', 'forbidden');
      }
      return {};
    });
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    await secretShown();
    fireEvent.click(screen.getByLabelText(/已连接账户/));
    const manual = (await screen.findByTestId('cc-obo-manual')) as HTMLInputElement;
    fireEvent.change(manual, { target: { value: '  p-x  ' } });
    expect(manual.value).toBe('p-x');
    expect(screen.getByText(/读不到成员列表/)).toBeTruthy();
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
