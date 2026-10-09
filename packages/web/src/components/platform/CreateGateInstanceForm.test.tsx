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
    expect(within(form).getByLabelText(/清单来源/)).toBeTruthy();

    fireEvent.click(within(form).getByLabelText(/mcp/));
    expect(within(form).queryByLabelText(/清单来源/)).toBeNull();
  });

  it('submits gateId/transportKind/target/credentialMode for mcp, omitting a blank displayName and the (hidden) manifestSource', async () => {
    // Was an http submission with a blank manifest source before C12 — exactly the 400 the kernel
    // `superRefine` guarantees; mcp is the transport that legitimately omits `manifestSource`.
    const result = created();
    const http = scriptedHttp({
      create_gate_instance: (params) => {
        expect(params).toEqual({
          gateId: 'billing-api',
          transportKind: 'mcp',
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
    fireEvent.click(within(form).getByLabelText(/mcp/));
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.internal' },
    });
    fireEvent.click(within(form).getByLabelText(/^按人/));
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
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.internal' },
    });
    fireEvent.change(within(form).getByLabelText(/清单来源/), {
      target: { value: 'https://billing.internal/openapi.json' },
    });
    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'create_gate_instance')).toBe(true),
    );
  });

  it('disables submit until gateId, target and (for http, C12) manifestSource are all valid', () => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    const submit = within(form).getByTestId('create-gate-instance-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Normalization turns most input into a valid id; a single character is still too short.
    fireEvent.change(within(form).getByLabelText(/Gate id/), { target: { value: 'x' } });
    expect(within(form).getByText(/至少需要 2 个字符/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://target.internal' },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(within(form).getByLabelText(/Gate id/), { target: { value: 'valid-id' } });
    // http with a blank manifest source: the kernel would 400 — still disabled.
    expect(submit.disabled).toBe(true);

    fireEvent.change(within(form).getByLabelText(/清单来源/), {
      target: { value: 'not a url' },
    });
    expect(submit.disabled).toBe(true);
    // The error says what a valid value looks like.
    expect(
      within(form).getByText(
        /需要一个完整的地址，例如 https:\/\/billing\.example\.com\/openapi\.json/,
      ),
    ).toBeTruthy();

    fireEvent.change(within(form).getByLabelText(/清单来源/), {
      target: { value: 'https://target.internal/openapi.json' },
    });
    expect(submit.disabled).toBe(false);

    // Switching to mcp hides the field and stops requiring it.
    fireEvent.change(within(form).getByLabelText(/清单来源/), { target: { value: '' } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(form).getByLabelText(/mcp/));
    expect(submit.disabled).toBe(false);
  });

  it('derives the gate id from the display name, then the target host, until it is edited', () => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    const gateId = within(form).getByLabelText(/Gate id/) as HTMLInputElement;

    // From the target host when there is no usable name.
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.example.com:8443/api' },
    });
    expect(gateId.value).toBe('billing-example-com');
    expect(within(form).getByTestId('cgi-gate-id-derived').textContent).toContain('目标地址');

    // An all-Chinese name has nothing to slug — the target host still wins.
    fireEvent.change(within(form).getByLabelText(/^名称/), { target: { value: '账单系统' } });
    expect(gateId.value).toBe('billing-example-com');

    // A Latin name takes over.
    fireEvent.change(within(form).getByLabelText(/^名称/), {
      target: { value: 'Billing_API v2.1' },
    });
    expect(gateId.value).toBe('billing-api-v2-1');
    expect(within(form).getByTestId('cgi-gate-id-derived').textContent).toContain('名称');

    // Editing stops derivation; typed input is normalized live, not refused.
    fireEvent.change(gateId, { target: { value: 'My_Gate.Prod' } });
    expect(gateId.value).toBe('my-gate-prod');
    expect(within(form).getByTestId('cgi-gate-id-adjusted').textContent).toContain('my-gate-prod');
    fireEvent.change(within(form).getByLabelText(/^名称/), { target: { value: 'Other' } });
    expect(gateId.value).toBe('my-gate-prod');

    // Emptied and left: derivation resumes.
    fireEvent.change(gateId, { target: { value: '' } });
    fireEvent.blur(gateId);
    expect(gateId.value).toBe('other');
  });

  it('prepends https:// to a target without a scheme on blur, says so, and submits the completed URL', async () => {
    const http = scriptedHttp({
      create_gate_instance: (params) => {
        expect(params).toEqual({
          gateId: 'billing-internal',
          transportKind: 'mcp',
          target: 'https://billing.internal:8080',
          credentialMode: 'shared',
        });
        return created();
      },
    });
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.click(within(form).getByLabelText(/^mcp/));
    const target = within(form).getByLabelText(/^目标/) as HTMLInputElement;
    fireEvent.change(target, { target: { value: 'billing.internal:8080' } });
    // No "not a URL" refusal while typing.
    expect(within(form).queryByText(/需要一个完整的地址/)).toBeNull();
    fireEvent.blur(target);
    expect(target.value).toBe('https://billing.internal:8080');
    expect(within(form).getByTestId('cgi-target-scheme-note').textContent).toContain('https://');

    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'create_gate_instance')).toBe(true),
    );
  });

  it('suggests <target>/openapi.json for the manifest as a placeholder and a one-click fill, never silently', () => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    expect(within(form).queryByTestId('cgi-manifest-suggest')).toBeNull();
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.example.com/' },
    });
    const manifest = within(form).getByLabelText(/清单来源/) as HTMLInputElement;
    expect(manifest.value).toBe('');
    expect(manifest.placeholder).toBe('https://billing.example.com/openapi.json');
    const submit = within(form).getByTestId('create-gate-instance-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(within(form).getByTestId('cgi-manifest-suggest'));
    expect(manifest.value).toBe('https://billing.example.com/openapi.json');
    expect(within(form).queryByTestId('cgi-manifest-suggest')).toBeNull();
    expect(submit.disabled).toBe(false);
  });
});
