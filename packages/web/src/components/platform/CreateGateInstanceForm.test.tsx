// @vitest-environment jsdom
import type { ConnectorPresetWire, ConnectorWire, GateInstanceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
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

function connectorRow(overrides: Partial<ConnectorWire> & { name: string }): ConnectorWire {
  return {
    kind: 'http',
    packaged: false,
    mode: 'platform_preset',
    disabledOperations: [],
    operationCount: 0,
    instanceCount: 1,
    selfConnectionCount: 0,
    suspendedSelfConnectionCount: 0,
    updatedAt: null,
    ...overrides,
  };
}

/** `list_connectors` as a fresh platform has it, plus a packaged gate's and two gate-host system
 *  connectors (one per kind). */
const CONNECTORS: ConnectorWire[] = [
  connectorRow({ name: 'http', mode: 'self_serve', instanceCount: 0 }),
  connectorRow({ name: 'mcp', kind: 'mcp', mode: 'self_serve', instanceCount: 0 }),
  connectorRow({ name: 'docker', packaged: true }),
  connectorRow({ name: 'billing', instanceCount: 2 }),
  connectorRow({ name: 'widgets', kind: 'mcp' }),
];

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
    let sent: unknown;
    const http = scriptedHttp({
      create_gate_instance: (params) => {
        sent = params;
        return result;
      },
    });
    const onCreated = vi.fn();
    render(<CreateGateInstanceForm http={http} onCreated={onCreated} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/门 ID/), {
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
    expect(sent).toEqual({
      gateId: 'billing-api',
      transportKind: 'mcp',
      target: 'https://billing.internal',
      credentialMode: 'connected_account',
      connector: 'billing-api',
    });
    expect(onCreated).toHaveBeenCalledWith(result);
  });

  it('includes manifestSource for http when filled in', async () => {
    const result = created();
    let sent: unknown;
    const http = scriptedHttp({
      create_gate_instance: (params) => {
        sent = params;
        return result;
      },
    });
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/门 ID/), {
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
    expect(sent).toEqual({
      gateId: 'billing-api',
      transportKind: 'http',
      target: 'https://billing.internal',
      credentialMode: 'shared',
      manifestSource: 'https://billing.internal/openapi.json',
      connector: 'billing-api',
    });
  });

  it('disables submit until gateId, target and (for http, C12) manifestSource are all valid', () => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);

    const form = screen.getByTestId('create-gate-instance-form');
    const submit = within(form).getByTestId('create-gate-instance-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Normalization turns most input into a valid id; a single character is still too short.
    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'x' } });
    expect(within(form).getByText(/至少需要 2 个字符/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://target.internal' },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'valid-id' } });
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
    const gateId = within(form).getByLabelText(/门 ID/) as HTMLInputElement;

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
    const note = within(form).getByTestId('cgi-target-scheme-note');
    expect(note.textContent).toContain('https://');
    // UX acceptance of #583 P3-1: no half-width space between the two Chinese sentences.
    expect(note.textContent?.startsWith(' ')).toBe(false);
    expect(note.parentElement?.textContent).toContain('会自动补上。已自动补上 https://');

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

  // Review of #549: a suggestion never copies a credential, nor the target's query.
  it.each([
    ['a password', 'https://ops:Synth-Pw-4417@billing.example.com'],
    ['a token query', 'https://billing.example.com/?token=abcdefghijklmnopqrstuvwxyz0123'],
  ])('offers no manifest suggestion for a target carrying %s', (_name, value) => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/^目标/), { target: { value } });
    const manifest = within(form).getByLabelText(/清单来源/) as HTMLInputElement;
    expect(within(form).queryByTestId('cgi-manifest-suggest')).toBeNull();
    expect(manifest.placeholder).toBe('https://billing.example.com/openapi.json');
  });

  it('drops the target query from the manifest suggestion', () => {
    const http = scriptedHttp({});
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.example.com/api?version=3' },
    });
    expect(within(form).getByTestId('cgi-manifest-suggest').textContent).toBe(
      '使用 https://billing.example.com/api/openapi.json',
    );
  });

  it.each([
    ['target', /^目标/, 'cgi-target-error', '目标地址里带了凭据'],
    ['manifestSource', /清单来源/, 'cgi-manifest-source-error', '清单来源里带了凭据'],
  ])(
    'shows a credentials_in_connection_params refusal of the %s on that field, the kernel text in 「技术细节」',
    async (field, _label, errorId, explanation) => {
      const kernelText = `create_gate_instance: ${field} carries what looks like a credential — refused, nothing was stored.`;
      const http = scriptedHttp({
        create_gate_instance: () => {
          throw new HttpError('capability_error', kernelText, 'credentials_in_connection_params', {
            field,
          });
        },
      });
      render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
      const form = screen.getByTestId('create-gate-instance-form');
      fireEvent.change(within(form).getByLabelText(/门 ID/), {
        target: { value: 'billing-api' },
      });
      fireEvent.change(within(form).getByLabelText(/^目标/), {
        target: { value: 'https://billing.internal' },
      });
      fireEvent.change(within(form).getByLabelText(/清单来源/), {
        target: { value: 'https://billing.internal/openapi.json' },
      });
      fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));

      const raw = await screen.findByTestId(`${errorId}-detail`);
      expect(raw.textContent).toBe(kernelText);
      expect((raw.closest('details') as HTMLDetailsElement).open).toBe(false);
      const fieldId = field === 'target' ? 'cgi-target-error' : 'cgi-manifest-source-error';
      const line = document.getElementById(fieldId);
      expect(line?.textContent).toContain(explanation);
      expect(line?.textContent).not.toContain('refused, nothing was stored');
      expect(screen.queryByTestId('create-gate-instance-error')).toBeNull();
    },
  );

  it('P1: files the instance under a connector named after the gate id, offers same-kind system connectors, and says on the field why a name cannot be used', async () => {
    let sent: unknown;
    const http = scriptedHttp({
      list_connectors: () => ({ items: CONNECTORS }),
      create_gate_instance: (params) => {
        sent = params;
        return created();
      },
    });
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'invoices' } });
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.internal' },
    });
    fireEvent.change(within(form).getByLabelText(/清单来源/), {
      target: { value: 'https://billing.internal/openapi.json' },
    });

    const name = within(form).getByLabelText(/接入包名称/) as HTMLInputElement;
    expect(name.value).toBe('invoices');
    expect(within(form).getByTestId('cgi-connector-derived')).toBeTruthy();
    expect(within(form).getByTestId('cgi-connector-new').textContent).toContain(
      '新的接入包是「平台预置」',
    );
    // Only http system connectors: not the mcp one, the packaged one or the generic kinds.
    const suggestions = await within(form).findByTestId('cgi-connector-suggestions');
    expect(
      within(suggestions)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['billing']);

    fireEvent.click(within(form).getByTestId('cgi-connector-suggestion-billing'));
    expect(name.value).toBe('billing');
    expect(within(form).getByTestId('cgi-connector-joins').textContent).toContain('已有 2 个实例');
    // Legacy 395: joining says so, without the 「新的接入包…」 sentence that contradicted it.
    expect(within(form).queryByTestId('cgi-connector-new')).toBeNull();

    const submit = within(form).getByTestId('create-gate-instance-submit') as HTMLButtonElement;
    for (const [value, said] of [
      ['docker', '属于一个打包的门'],
      ['widgets', '是 mcp 接入包，放不了 http 实例'],
      ['http', '是通用接入包的名字'],
    ] as const) {
      fireEvent.change(name, { target: { value } });
      expect(document.getElementById('cgi-connector-error')?.textContent).toContain(said);
      expect(submit.disabled).toBe(true);
      expect(within(form).getByTestId('create-gate-instance-missing').textContent).toContain(
        '改正接入包名称',
      );
    }

    fireEvent.change(name, { target: { value: 'billing' } });
    fireEvent.click(submit);
    await waitFor(() => expect(sent).toMatchObject({ gateId: 'invoices', connector: 'billing' }));
  });

  it('legacy 396: a gate id that extends an existing connector name joins that connector by default', async () => {
    let sent: unknown;
    const http = scriptedHttp({
      list_connectors: () => ({
        items: [
          ...CONNECTORS,
          connectorRow({ name: 'billing-eu', instanceCount: 1 }),
          // Same prefix but the other kind: never picked for an http instance.
          connectorRow({ name: 'billing-eu-2', kind: 'mcp' }),
        ],
      }),
      create_gate_instance: (params) => {
        sent = params;
        return created();
      },
    });
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    const name = within(form).getByLabelText(/接入包名称/) as HTMLInputElement;

    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'billing-2' } });
    await waitFor(() => expect(name.value).toBe('billing'));
    expect(within(form).getByTestId('cgi-connector-derived').textContent).toContain(
      '门 ID 以这个已有接入包的名字开头',
    );
    expect(within(form).getByTestId('cgi-connector-joins').textContent).toContain('已有 2 个实例');
    expect(within(form).queryByTestId('cgi-connector-new')).toBeNull();

    // The longest matching name wins; one of the other kind does not count.
    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'billing-eu-2' } });
    expect(name.value).toBe('billing-eu');

    // Legacy 402: a gate id equal to an existing connector's name joins it and says so.
    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'billing' } });
    expect(name.value).toBe('billing');
    expect(within(form).getByTestId('cgi-connector-derived').textContent).toContain(
      '门 ID 和这个已有接入包同名',
    );
    expect(within(form).queryByTestId('cgi-connector-new')).toBeNull();

    // No connector name to extend: named after the gate id, as before.
    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'payroll' } });
    expect(name.value).toBe('payroll');
    expect(within(form).getByTestId('cgi-connector-derived').textContent).toContain(
      '已根据门 ID 自动生成',
    );
    expect(within(form).getByTestId('cgi-connector-new')).toBeTruthy();

    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'billing-2' } });
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.internal' },
    });
    fireEvent.change(within(form).getByLabelText(/清单来源/), {
      target: { value: 'https://billing.internal/openapi.json' },
    });
    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));
    await waitFor(() => expect(sent).toMatchObject({ gateId: 'billing-2', connector: 'billing' }));
  });

  it('P1: the generic connector sends the transport kind and says what presetting it does to self-connections', async () => {
    let sent: unknown;
    const http = scriptedHttp({
      list_connectors: () => ({ items: CONNECTORS }),
      create_gate_instance: (params) => {
        sent = params;
        return created();
      },
    });
    render(<CreateGateInstanceForm http={http} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const form = screen.getByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/门 ID/), { target: { value: 'widgets-2' } });
    fireEvent.click(within(form).getByLabelText(/^mcp/));
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://widgets.internal' },
    });
    fireEvent.click(within(form).getByTestId('cgi-connector-generic'));
    expect(within(form).queryByLabelText(/接入包名称/)).toBeNull();
    await waitFor(() =>
      expect(within(form).getByTestId('cgi-connector-generic-note').textContent).toContain(
        '所有工作区都不能再自己接入 mcp 系统',
      ),
    );

    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));
    await waitFor(() => expect(sent).toMatchObject({ gateId: 'widgets-2', connector: 'mcp' }));
  });
});

/** `list_connector_presets` as this repository ships it: RAGFlow, four Operations, one shared key. */
function ragflowPreset(overrides: Partial<ConnectorPresetWire> = {}): ConnectorPresetWire {
  const operation = (name: string, mode: 'observe' | 'execute') => ({
    name,
    mode,
    blastRadius: mode === 'observe' ? 'low' : 'medium',
    autoApprovable: mode === 'observe',
    readOnlyHint: null,
    destructiveHint: null,
    idempotentHint: null,
  });
  return {
    name: 'ragflow',
    displayName: 'RAGFlow',
    summary: '知识库检索：列出知识库和其中的文档，按问题检索相关片段。',
    transportKind: 'http',
    credentialMode: 'shared',
    targetHint: 'RAGFlow 的访问地址，例如 https://ragflow.example.com，不带 /api/v1。',
    credentialHint: 'RAGFlow 的 API key，在 RAGFlow 的「API」页面生成；整个实例共用这一个。',
    operations: [
      operation('kb.list', 'observe'),
      operation('kb.documents', 'observe'),
      operation('retrieve', 'observe'),
      operation('document.parse', 'execute'),
    ],
    packagedConnector: false,
    instanceCount: 0,
    ...overrides,
  };
}

describe('CreateGateInstanceForm from a connector preset (S11 P1-F)', () => {
  it('offers each preset above 其他系统; picking RAGFlow asks for the address only and sends the preset', async () => {
    let sent: unknown;
    const result = created({ gateId: 'ragflow', connector: 'ragflow' });
    const http = scriptedHttp({
      list_connector_presets: () => ({ items: [ragflowPreset()] }),
      list_connectors: () => ({ items: CONNECTORS }),
      create_gate_instance: (params) => {
        sent = params;
        return result;
      },
    });
    const onCreated = vi.fn();
    render(<CreateGateInstanceForm http={http} onCreated={onCreated} onCancel={vi.fn()} />);

    // 其他系统 stays the default: the custom form is shown until a preset is picked.
    fireEvent.click(await screen.findByTestId('cgi-source-preset-ragflow'));
    expect(screen.queryByTestId('create-gate-instance-form')).toBeNull();
    const form = screen.getByTestId('preset-gate-instance-form');
    expect(within(form).getByTestId('preset-operations').textContent).toContain('document.parse');
    expect(within(form).getAllByRole('listitem')).toHaveLength(4);
    expect(within(form).getByTestId('preset-credential').textContent).toContain(
      '整个实例共用这一个',
    );
    expect(within(form).getByTestId('preset-connector').textContent).toContain(
      '新的接入包「ragflow」',
    );
    // Nothing a preset fixes is asked for.
    expect(within(form).queryByLabelText(/清单来源/)).toBeNull();
    expect(within(form).queryByLabelText(/^mcp/)).toBeNull();
    expect(within(form).queryByLabelText(/接入包名称/)).toBeNull();
    expect(
      (within(form).getByTestId('preset-gate-instance-submit') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(form).getByTestId('preset-gate-instance-missing').textContent).toContain(
      '填写地址',
    );

    const address = within(form).getByLabelText(/^地址/);
    fireEvent.change(address, { target: { value: 'kb.example.com' } });
    fireEvent.blur(address);
    expect(within(form).getByTestId('pgi-target-scheme-note')).toBeTruthy();
    expect((within(form).getByLabelText(/门 ID/) as HTMLInputElement).value).toBe('ragflow');
    fireEvent.click(within(form).getByTestId('preset-gate-instance-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
    expect(sent).toEqual({
      gateId: 'ragflow',
      displayName: 'RAGFlow',
      preset: 'ragflow',
      target: 'https://kb.example.com',
    });
  });

  it('opens on the preset a link names; a second instance gets the next gate id and joins the connector', async () => {
    let sent: unknown;
    const http = scriptedHttp({
      list_connector_presets: () => ({ items: [ragflowPreset({ instanceCount: 1 })] }),
      list_connectors: () => ({
        items: [...CONNECTORS, connectorRow({ name: 'ragflow', instanceCount: 1 })],
      }),
      create_gate_instance: (params) => {
        sent = params;
        return created();
      },
    });
    render(
      <CreateGateInstanceForm
        http={http}
        initialPreset="ragflow"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const form = await screen.findByTestId('preset-gate-instance-form');
    await waitFor(() =>
      expect(within(form).getByTestId('preset-connector').textContent).toContain('它已有 1 个实例'),
    );
    fireEvent.change(within(form).getByLabelText(/^名称/), { target: { value: 'KB Archive' } });
    expect((within(form).getByLabelText(/门 ID/) as HTMLInputElement).value).toBe('kb-archive');
    fireEvent.change(within(form).getByLabelText(/^名称/), { target: { value: '' } });
    expect((within(form).getByLabelText(/门 ID/) as HTMLInputElement).value).toBe('ragflow-2');
    fireEvent.change(within(form).getByLabelText(/^地址/), {
      target: { value: 'https://kb-2.example.com' },
    });
    fireEvent.click(within(form).getByTestId('preset-gate-instance-submit'));
    await waitFor(() =>
      expect(sent).toEqual({
        gateId: 'ragflow-2',
        displayName: 'RAGFlow',
        preset: 'ragflow',
        target: 'https://kb-2.example.com',
      }),
    );
  });

  it('a preset whose connector a packaged gate holds says the system is connected and offers no create', async () => {
    const http = scriptedHttp({
      list_connector_presets: () => ({
        items: [ragflowPreset({ packagedConnector: true, instanceCount: 1 })],
      }),
      list_connectors: () => ({ items: CONNECTORS }),
    });
    render(
      <CreateGateInstanceForm
        http={http}
        initialPreset="ragflow"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const form = await screen.findByTestId('preset-gate-instance-form');
    expect(within(form).getByTestId('preset-packaged').textContent).toContain('这个系统已经接上了');
    expect(within(form).queryByTestId('preset-gate-instance-submit')).toBeNull();
    expect(within(form).queryByLabelText(/^地址/)).toBeNull();
    expect(screen.getByTestId('cgi-source-preset-ragflow').parentElement?.textContent).toContain(
      '已由打包的门接入',
    );
  });

  it('a credential in the address is said on that field, with the kernel’s own text in its details', async () => {
    const http = scriptedHttp({
      list_connector_presets: () => ({ items: [ragflowPreset()] }),
      list_connectors: () => ({ items: CONNECTORS }),
      create_gate_instance: () => {
        throw new HttpError(
          'capability_error',
          'target carries a credential',
          'credentials_in_connection_params',
          { field: 'target' },
        );
      },
    });
    render(
      <CreateGateInstanceForm
        http={http}
        initialPreset="ragflow"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const form = await screen.findByTestId('preset-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/^地址/), {
      target: { value: 'https://kb.example.com/?api_key=x' },
    });
    fireEvent.click(within(form).getByTestId('preset-gate-instance-submit'));
    expect((await within(form).findByRole('alert')).textContent).toContain('地址里带了凭据');
    expect(within(form).getByTestId('pgi-target-error-detail').textContent).toContain(
      'target carries a credential',
    );
    expect(screen.queryByTestId('preset-gate-instance-error')).toBeNull();
  });

  it('no preset for an mcp system, an unknown preset falls back to 其他系统, and an unreadable list hides the choice', async () => {
    const listed = scriptedHttp({ list_connector_presets: () => ({ items: [ragflowPreset()] }) });
    render(
      <CreateGateInstanceForm
        http={listed}
        transportKind="mcp"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(listed.calls.some((call) => call.name === 'list_connector_presets')).toBe(true),
    );
    expect(screen.queryByTestId('cgi-source-preset-ragflow')).toBeNull();
    expect(screen.getByTestId('create-gate-instance-form')).toBeTruthy();
    cleanup();

    render(
      <CreateGateInstanceForm
        http={listed}
        initialPreset="confluence"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect((await screen.findByTestId('cgi-preset-unknown')).textContent).toContain(
      '没有「confluence」的接入预设',
    );
    expect(screen.getByTestId('create-gate-instance-form')).toBeTruthy();
    expect((screen.getByTestId('cgi-source-custom') as HTMLInputElement).checked).toBe(true);
    cleanup();

    // `scriptedHttp` throws for an unscripted name: the list cannot be read.
    render(
      <CreateGateInstanceForm
        http={scriptedHttp({})}
        initialPreset="ragflow"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect((await screen.findByTestId('cgi-preset-unknown')).textContent).toContain(
      '读不到平台的接入预设',
    );
    expect(screen.queryByTestId('cgi-source-custom')).toBeNull();
  });
});
