// @vitest-environment jsdom
import type {
  GateAddressChangePreviewWire,
  GateAddressChangeWire,
  GateAddressManifestComparisonWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { GateAddressChangeSheet } from './GateAddressChangeSheet.js';

afterEach(cleanup);

const GATE = 'gk-1';
const FROM = 'http://gate-a:8090';
const TO = 'http://gate-b:8443';
/** What `mint_connection_secret` answers, the n-th time it is called. */
const secretNo = (n: number) => `ntgc1_${String(n).repeat(32)}_${'b'.repeat(64)}`;
const DIGEST = 'p'.repeat(64);

const impact = {
  publishedOperationCount: 2,
  grantCount: 1,
  autoApprovedOperations: ['notes.list'],
  workerDefinitionCount: 0,
  inFlightActionRequestCount: 0,
};

const matching: GateAddressManifestComparisonWire = {
  matches: true,
  manifestDigest: 'm'.repeat(64),
  differing: [],
  notDescribed: [],
};

function preview(manifest = matching): GateAddressChangePreviewWire {
  return {
    gatekeeperId: GATE,
    fromEndpoint: FROM,
    toEndpoint: TO,
    manifest,
    impact,
    previewDigest: DIGEST,
  };
}

const change: GateAddressChangeWire = {
  id: 'gac-1',
  gatekeeperId: GATE,
  fromEndpoint: FROM,
  toEndpoint: TO,
  status: 'proposed',
  impact,
  previewDigest: DIGEST,
  proposedBy: 'p-owner',
  createdAt: '2026-11-13T00:00:00.000Z',
  expiresAt: '2026-11-14T00:00:00.000Z',
  decidedAt: null,
  rejectionReason: null,
};

interface Script {
  /** The gate's open proposal, read by every `get_gatekeeper`. */
  pending?: GateAddressChangeWire | undefined;
  preview?: (params: unknown) => unknown;
  /** Every `get_gatekeeper` after a withdrawal never answers (a slow read). */
  stallReadsAfterWithdraw?: boolean;
}

function scriptedHttp(script: Script): CapabilityCaller & {
  readonly calls: { name: string; params: unknown }[];
} {
  const calls: { name: string; params: unknown }[] = [];
  let minted = 0;
  let withdrawn = false;
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      switch (name) {
        case 'get_gatekeeper':
          if (withdrawn && script.stallReadsAfterWithdraw) return new Promise(() => {});
          return {
            id: GATE,
            name: 'notes',
            endpoint: FROM,
            ...(script.pending ? { pendingAddressChange: script.pending } : {}),
          };
        case 'mint_connection_secret':
          minted += 1;
          return { connectionSecret: secretNo(minted) };
        case 'preview_gate_address_change':
          return script.preview ? script.preview(params) : preview();
        case 'propose_gate_address_change':
          script.pending = change;
          return change;
        case 'withdraw_gate_address_change':
          withdrawn = true;
          script.pending = undefined;
          return { ...change, status: 'withdrawn' };
        default:
          throw new Error(`unscripted capability ${name}`);
      }
    }) as CapabilityCaller['call'],
  };
}

function show(http: CapabilityCaller) {
  render(
    <GateAddressChangeSheet
      http={http}
      open
      onOpenChange={vi.fn()}
      gatekeeperId={GATE}
      gateName="notes"
    />,
  );
}

function callsOf(http: ReturnType<typeof scriptedHttp>, name: string) {
  return http.calls.filter((call) => call.name === name);
}

const previewButton = () => screen.getByTestId('gate-address-change-preview') as HTMLButtonElement;
const proposeButton = () => screen.getByTestId('gate-address-change-propose') as HTMLButtonElement;

async function enterAddress(value: string): Promise<void> {
  await screen.findByTestId('connection-secret-value');
  fireEvent.change(screen.getByLabelText(/② 新地址/), { target: { value } });
}

describe('GateAddressChangeSheet (legacy 701)', () => {
  it('mints a secret for the new address, previews it with that secret, and proposes what was previewed', async () => {
    const http = scriptedHttp({});
    show(http);

    expect(screen.getByRole('dialog', { name: '更换「notes」的地址' })).toBeTruthy();
    expect((await screen.findByTestId('connection-secret-value')).textContent).toBe(secretNo(1));
    expect(screen.getByTestId('gate-address-change-current').textContent).toContain(FROM);
    // Nothing to preview until there is an address, and nothing to propose until a preview.
    expect(previewButton().disabled).toBe(true);
    expect(proposeButton().disabled).toBe(true);
    expect(screen.getByText(/先预览新地址/)).toBeTruthy();

    // A bare host:port gets http://, as 直接注册门 does.
    await enterAddress('gate-b:8443');
    fireEvent.click(previewButton());
    await screen.findByTestId('gate-address-change-manifest-match');
    expect(callsOf(http, 'preview_gate_address_change')[0]?.params).toEqual({
      gatekeeperId: GATE,
      endpoint: TO,
      connectionSecret: secretNo(1),
    });
    const lines = screen.getByTestId('gate-address-change-impact').textContent ?? '';
    expect(lines).toContain('2 个已发布的 Operation：新地址上的门必须原样提供');
    expect(lines).toContain('自动批准的 Operation：notes.list，在新地址同样不经审批');
    expect(lines).not.toContain('还没执行');

    expect(proposeButton().disabled).toBe(false);
    fireEvent.click(proposeButton());
    const pending = await screen.findByTestId('gate-address-change-pending');
    expect(callsOf(http, 'propose_gate_address_change')[0]?.params).toEqual({
      gatekeeperId: GATE,
      endpoint: TO,
      connectionSecret: secretNo(1),
      previewDigest: DIGEST,
    });
    // The proposal replaces the steps: from where to where, and 撤回.
    expect(pending.textContent).toContain(FROM);
    expect(pending.textContent).toContain(TO);
    expect(screen.queryByLabelText(/② 新地址/)).toBeNull();
    expect(screen.queryByTestId('connection-secret-value')).toBeNull();
  });

  it('a new host that does not describe the published Operations blocks the move, and says which', async () => {
    const http = scriptedHttp({
      preview: () =>
        preview({
          ...matching,
          matches: false,
          differing: ['notes.write'],
          notDescribed: ['notes.archive'],
        }),
    });
    show(http);
    await enterAddress(TO);
    fireEvent.click(previewButton());

    const mismatch = await screen.findByTestId('gate-address-change-manifest-mismatch');
    expect(mismatch.textContent).toContain('不能换过去');
    expect(mismatch.textContent).toMatch(
      /新地址上的门描述得和已发布的不同，或者这个工作区没有：notes\.write/,
    );
    expect(mismatch.textContent).toMatch(/已发布、但新地址上的门没有描述：notes\.archive/);
    expect(proposeButton().disabled).toBe(true);
    expect(screen.getByText(/已发布的 Operation，新地址上的门要先原样提供/)).toBeTruthy();
    expect(callsOf(http, 'propose_gate_address_change')).toHaveLength(0);
  });

  it('another address after a preview has to be previewed again', async () => {
    const http = scriptedHttp({});
    show(http);
    await enterAddress(TO);
    fireEvent.click(previewButton());
    await screen.findByTestId('gate-address-change-manifest-match');

    fireEvent.change(screen.getByLabelText(/② 新地址/), {
      target: { value: 'https://gate-c.example.com' },
    });
    expect(screen.queryByTestId('gate-address-change-preview-result')).toBeNull();
    expect(proposeButton().disabled).toBe(true);
  });

  it('an address that is not a URL is refused in the form, without asking the kernel', async () => {
    const http = scriptedHttp({});
    show(http);
    await enterAddress('gate b');
    fireEvent.click(previewButton());
    expect(await screen.findByText(/新地址需要一个完整的地址/)).toBeTruthy();
    expect(
      (screen.getByLabelText(/② 新地址/) as HTMLInputElement).getAttribute('aria-invalid'),
    ).toBe('true');
    expect(callsOf(http, 'preview_gate_address_change')).toHaveLength(0);
  });

  it('a refused preview says why and keeps the steps', async () => {
    const http = scriptedHttp({
      preview: () => {
        throw new HttpError(
          'capability_error',
          'preview_gate_address_change: Gatekeeper "gk-1" is already at that address',
          'gate_address_unchanged',
        );
      },
    });
    show(http);
    await enterAddress(FROM);
    fireEvent.click(previewButton());
    const banner = await screen.findByTestId('gate-address-change-error');
    expect(banner.textContent).toContain('没能提出更换地址');
    expect(proposeButton().disabled).toBe(true);
    expect(screen.getByLabelText(/② 新地址/)).toBeTruthy();
  });

  it('an open proposal shows instead of the steps; withdrawing it starts over with a new secret', async () => {
    const http = scriptedHttp({ pending: change });
    show(http);
    const pending = await screen.findByTestId('gate-address-change-pending');
    expect(pending.textContent).toContain(TO);
    // No secret is minted while a proposal is open: the steps are not there.
    expect(callsOf(http, 'mint_connection_secret')).toHaveLength(0);

    fireEvent.click(within(pending).getByTestId('gate-address-change-withdraw'));
    const confirm = await screen.findByRole('dialog', { name: '撤回换地址的申请' });
    expect(confirm.textContent).toContain('这次用的连接密钥作废');
    fireEvent.click(within(confirm).getByRole('button', { name: '撤回' }));

    await waitFor(() => expect(screen.queryByTestId('gate-address-change-pending')).toBeNull());
    expect(callsOf(http, 'withdraw_gate_address_change')[0]?.params).toEqual({ id: change.id });
    // The secret the proposal carried is spent: the steps come back with a new one.
    expect((await screen.findByTestId('connection-secret-value')).textContent).toBe(secretNo(1));
    expect(callsOf(http, 'mint_connection_secret')).toHaveLength(1);
  });

  // Review #501 of #1158: the withdrawn proposal and its 撤回 do not linger while the gate is read
  // again — that read still answers with the proposal until it returns.
  it('a withdrawn proposal is gone at once, before the gate is read again', async () => {
    const http = scriptedHttp({ pending: change, stallReadsAfterWithdraw: true });
    show(http);
    const pending = await screen.findByTestId('gate-address-change-pending');
    fireEvent.click(within(pending).getByTestId('gate-address-change-withdraw'));
    const confirm = await screen.findByRole('dialog', { name: '撤回换地址的申请' });
    fireEvent.click(within(confirm).getByRole('button', { name: '撤回' }));

    await waitFor(() => expect(callsOf(http, 'get_gatekeeper')).toHaveLength(2));
    expect(screen.queryByTestId('gate-address-change-pending')).toBeNull();
    expect(screen.queryByTestId('gate-address-change-withdraw')).toBeNull();
    expect((await screen.findByTestId('connection-secret-value')).textContent).toBe(secretNo(1));
  });
});
