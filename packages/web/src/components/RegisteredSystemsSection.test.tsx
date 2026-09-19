// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { RpcError } from '../lib/ws-client.js';
import { GatekeeperCard } from './RegisteredSystemsSection.js';

afterEach(cleanup);

const GATEKEEPER = {
  id: 'gk-1',
  name: 'Billing API',
  transportKind: 'http',
  target: 'https://billing.internal',
  endpoint: 'http://gate:8080',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

const DRAFT_OPERATION = {
  objectId: 'op-1',
  gatekeeperId: 'gk-1',
  name: 'billing.refund',
  status: 'draft',
  mode: 'execute',
  blastRadius: 'medium',
};

function renderCard(http: CapabilityCaller, onForbidden = vi.fn()) {
  render(
    <GatekeeperCard
      http={http}
      gatekeeper={GATEKEEPER}
      operations={[DRAFT_OPERATION]}
      canPublish
      canGrant
      onChanged={vi.fn()}
      onForbidden={onForbidden}
    />,
  );
  return onForbidden;
}

/** C18 (console-completion-plan §2b): the card's 403 detection goes through `lib/errors.ts`
 *  `isForbiddenError`, which normalizes both transports — the former local helper only matched
 *  an HTTP-shaped `{code: 'forbidden'}` and would have missed a WS `RpcError` (numeric -32002). */
describe('GatekeeperCard forbidden detection (C18)', () => {
  it('reports publish_manifest as forbidden for an HTTP 403', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new HttpError('capability_error', 'owner only', 'forbidden');
      }) as CapabilityCaller['call'],
    };
    const onForbidden = renderCard(http);
    fireEvent.click(screen.getByRole('button', { name: /Publish manifest/ }));
    await waitFor(() => expect(onForbidden).toHaveBeenCalledWith('publish_manifest'));
  });

  it('reports publish_manifest as forbidden for a JSON-RPC -32002 too', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new RpcError(-32002, 'forbidden');
      }) as CapabilityCaller['call'],
    };
    const onForbidden = renderCard(http);
    fireEvent.click(screen.getByRole('button', { name: /Publish manifest/ }));
    await waitFor(() => expect(onForbidden).toHaveBeenCalledWith('publish_manifest'));
  });

  it('does not report a non-403 failure as forbidden', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new HttpError('capability_error', 'gate down', 'gatekeeper_timeout');
      }) as CapabilityCaller['call'],
    };
    const onForbidden = renderCard(http);
    fireEvent.click(screen.getByRole('button', { name: /Publish manifest/ }));
    await screen.findByText(/gate down/);
    expect(onForbidden).not.toHaveBeenCalled();
  });
});
