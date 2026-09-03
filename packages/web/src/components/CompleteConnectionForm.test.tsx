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

function httpWith(call: (name: string, params: unknown) => Promise<unknown>): CapabilityCaller {
  return { call: vi.fn(call) as CapabilityCaller['call'] };
}

describe('CompleteConnectionForm', () => {
  it('prefills kind/target from the request, requires an endpoint, and never submits an invalid form', async () => {
    const http = httpWith(async () => ({}));
    render(
      <CompleteConnectionForm http={http} request={request} onDone={vi.fn()} onCancel={vi.fn()} />,
    );

    expect((screen.getByLabelText(/Kind/) as HTMLSelectElement).value).toBe('http');
    expect((screen.getByLabelText(/Target system/) as HTMLInputElement).value).toBe(request.target);

    fireEvent.click(screen.getByRole('button', { name: 'Register Gatekeeper' }));
    expect(await screen.findByText('The Gatekeeper endpoint is required.')).toBeTruthy();
    expect(
      (screen.getByLabelText(/Gatekeeper endpoint/) as HTMLInputElement).getAttribute(
        'aria-invalid',
      ),
    ).toBe('true');
    expect(http.call).not.toHaveBeenCalled();
  });

  it('shows the credentials box only for connected_account, and requires it there', async () => {
    const http = httpWith(async () => ({}));
    render(<CompleteConnectionForm http={http} onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText(/^Credentials/)).toBeNull();

    fireEvent.click(screen.getByLabelText(/Connected account/));
    expect(screen.getByLabelText(/^Credentials/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Target system/), { target: { value: 'erp' } });
    fireEvent.change(screen.getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register Gatekeeper' }));
    expect(await screen.findByText(/connected-account credential is required/)).toBeTruthy();
    expect(http.call).not.toHaveBeenCalled();
  });

  it('shows manifest source for http/mcp only', () => {
    render(
      <CompleteConnectionForm
        http={httpWith(async () => ({}))}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Manifest source/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Kind/), { target: { value: 'ssh' } });
    expect(screen.queryByLabelText(/Manifest source/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Kind/), { target: { value: 'mcp' } });
    expect(screen.getByLabelText(/Manifest source/)).toBeTruthy();
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

    fireEvent.change(screen.getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByLabelText(/Connected account/));
    const credentials = screen.getByLabelText(/^Credentials/) as HTMLTextAreaElement;
    fireEvent.change(credentials, { target: { value: '{"apiKey":"k"}' } });
    fireEvent.change(screen.getByLabelText(/Manifest source/), {
      target: { value: 'https://inventory.example.internal/openapi.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register Gatekeeper' }));

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
    fireEvent.change(screen.getByLabelText(/Target system/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register Gatekeeper' }));
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
    fireEvent.change(screen.getByLabelText(/Target system/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://gate:8080' },
    });
    fireEvent.click(screen.getByLabelText(/Connected account/));
    fireEvent.change(screen.getByLabelText(/^Credentials/), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register Gatekeeper' }));
    const fieldError = await screen.findByText(/no `credentials` was given/);
    expect(fieldError.getAttribute('id')).toBe('cc-credentials-error');
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
