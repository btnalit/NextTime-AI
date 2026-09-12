// @vitest-environment jsdom
import type { GateInstanceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { CreateGateInstanceForm } from './CreateGateInstanceForm.js';

afterEach(cleanup);

/** Same "unscripted names throw loudly" fake `PlatformIntegrationsPage.test.tsx` uses. */
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

function created(overrides: Partial<GateInstanceWire> = {}): GateInstanceWire {
  return {
    gateId: 'gate-new',
    connector: 'http',
    displayName: 'gate-new',
    transportKind: 'http',
    target: 'https://target.internal',
    endpoint: 'https://target.internal',
    status: 'enabled',
    trust: 'byo',
    health: 'unknown',
    lastSeenAt: null,
    lastCheckedAt: null,
    operationCount: 0,
    enabledWorkspaceCount: 0,
    operations: [],
    hosted: true,
    definition: {
      transportKind: 'http',
      target: 'https://target.internal',
      credentialMode: 'shared',
      manifestSource: null,
    },
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('CreateGateInstanceForm', () => {
  it('shows the manifest source field for http and hides it for mcp', () => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    expect(within(form).getByLabelText(/Manifest source/)).toBeTruthy();

    fireEvent.click(within(form).getByLabelText(/mcp/));
    expect(within(form).queryByLabelText(/Manifest source/)).toBeNull();
  });

  it('submits gateId/transportKind/target/credentialMode, omitting a blank displayName and manifestSource', async () => {
    const result = created();
    const http = scriptedHttp({
      create_gate_instance: (params) => {
        expect(params).toEqual({
          gateId: 'billing-api',
          transportKind: 'http',
          target: 'https://billing.internal',
          credentialMode: 'connected_account',
        });
        return result;
      },
    });
    const onCreated = vi.fn();
    render(<CreateGateInstanceForm http={http} onCreated={onCreated} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/Gate id/), {
      target: { value: 'billing-api' },
    });
    fireEvent.change(within(form).getByLabelText(/目标 Target/), {
      target: { value: 'https://billing.internal' },
    });
    fireEvent.click(within(form).getByLabelText(/按人 Connected account/));
    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'create_gate_instance')).toBe(true),
    );
    expect(onCreated).toHaveBeenCalledWith(result);
  });

  it('includes manifestSource for http when filled in', async () => {
    const result = created();
    const http = scriptedHttp({
      create_gate_instance: (params) => {
        expect(params).toEqual({
          gateId: 'billing-api',
          transportKind: 'http',
          target: 'https://billing.internal',
          credentialMode: 'shared',
          manifestSource: 'https://billing.internal/openapi.json',
        });
        return result;
      },
    });
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/Gate id/), {
      target: { value: 'billing-api' },
    });
    fireEvent.change(within(form).getByLabelText(/目标 Target/), {
      target: { value: 'https://billing.internal' },
    });
    fireEvent.change(within(form).getByLabelText(/Manifest source/), {
      target: { value: 'https://billing.internal/openapi.json' },
    });
    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'create_gate_instance')).toBe(true),
    );
  });

  it('disables submit until gateId and target are both valid', () => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    const submit = within(form).getByTestId('create-gate-instance-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(within(form).getByLabelText(/Gate id/), { target: { value: 'Not Valid!' } });
    fireEvent.change(within(form).getByLabelText(/目标 Target/), {
      target: { value: 'https://target.internal' },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(within(form).getByLabelText(/Gate id/), { target: { value: 'valid-id' } });
    expect(submit.disabled).toBe(false);
  });
});
