// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindApiKeyForm } from './BindApiKeyForm.js';

afterEach(cleanup);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BindApiKeyForm', () => {
  it('POSTs the API key to /api/auth/bind-api-key and calls onBound on success', async () => {
    const onBound = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          user: {
            id: 'u1',
            login: 'admin',
            displayName: 'Admin',
            platformRole: 'admin',
            mustChangePassword: false,
          },
          memberships: [{ workspaceId: 'ws-1', workspaceName: 'Acme', principalId: 'p1', role: 'owner' }],
        },
      }),
    );

    render(<BindApiKeyForm onBound={onBound} fetchImpl={fetchImpl as unknown as typeof fetch} />);

    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-bind' } });
    fireEvent.click(screen.getByRole('button', { name: '绑定 Bind' }));

    await waitFor(() => expect(onBound).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/bind-api-key');
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: 'sk-bind' });
  });

  it('maps invalid_api_key to a friendly inline message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, {
        ok: false,
        error: { code: 'invalid_api_key', message: 'that API key does not belong to a person' },
      }),
    );
    render(
      <BindApiKeyForm onBound={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByRole('button', { name: '绑定 Bind' }));

    await waitFor(() => expect(screen.getByText('这把 API key 不属于任何成员')).toBeTruthy());
  });

  it('maps already_member to a friendly inline message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, {
        ok: false,
        error: { code: 'already_member', message: 'already a member' },
      }),
    );
    render(
      <BindApiKeyForm onBound={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-dup' } });
    fireEvent.click(screen.getByRole('button', { name: '绑定 Bind' }));

    await waitFor(() => expect(screen.getByText('你已经是该工作区的成员了')).toBeTruthy());
  });
});
