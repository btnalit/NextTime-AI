// @vitest-environment jsdom
import type {
  PlatformDraftResidueWire,
  PlatformWorkspaceWire,
  RuntimeInventoryWire,
} from '@nexttime/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { PlatformResiduePage } from './PlatformResiduePage.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller {
  return {
    call: vi.fn(async (name: string, params?: unknown) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: 'ws-1',
    name: 'Acme',
    status: 'active',
    entryModel: null,
    allowedModels: [],
    ontologyEnforcement: 'reject',
    purpose: 'standard',
    expiresAt: null,
    disabledAt: null,
    purgeable: false,
    isDefault: false,
    memberCount: 0,
    owners: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function draftResidue(overrides: Partial<PlatformDraftResidueWire> = {}): PlatformDraftResidueWire {
  return {
    workerDefinitions: 0,
    skills: 0,
    procedures: 0,
    total: 0,
    expiryThresholdDays: 30,
    checkedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  };
}

function runtimeInventory(overrides: Partial<RuntimeInventoryWire> = {}): RuntimeInventoryWire {
  return {
    activeImage: 'nexttime-ai-worker-runtime:latest',
    activeImageSource: 'setting',
    activeImageInfo: null,
    images: [],
    residentContainers: [],
    checkedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  };
}

function renderPage(http: CapabilityCaller) {
  return render(<PlatformResiduePage http={http} />);
}

describe('PlatformResiduePage (journey ⑤ 清理验收残留)', () => {
  it('lists residue workspaces (disabled and expired-ephemeral), and only those', async () => {
    const http = scriptedHttp({
      list_workspaces: () => ({
        items: [
          workspace({ id: 'ws-1', name: 'prod', status: 'active', isDefault: true }),
          workspace({ id: 'ws-2', name: 'old', status: 'disabled' }),
          workspace({
            id: 'ws-3',
            name: 'accept-s3',
            status: 'active',
            purpose: 'ephemeral',
            expiresAt: '2020-01-01T00:00:00.000Z',
          }),
        ],
      }),
      platform_draft_residue: () => draftResidue(),
      runtime_inventory: () => runtimeInventory(),
    });
    renderPage(http);

    const list = await screen.findByTestId('residue-workspaces-list');
    expect(list.textContent).toContain('old');
    expect(list.textContent).toContain('accept-s3');
    expect(list.textContent).not.toContain('prod');
    expect(screen.getByTestId('residue-open-workspaces').getAttribute('href')).toBe(
      '#/platform/workspaces?residue=1',
    );
  });

  it('shows an empty state when there is no workspace residue', async () => {
    const http = scriptedHttp({
      list_workspaces: () => ({ items: [workspace({ status: 'active' })] }),
      platform_draft_residue: () => draftResidue(),
      runtime_inventory: () => runtimeInventory(),
    });
    renderPage(http);
    expect(await screen.findByTestId('residue-workspaces-empty')).toBeTruthy();
  });

  it('renders draft counts by kind and the expiry-threshold copy, never a draft’s own content', async () => {
    const http = scriptedHttp({
      list_workspaces: () => ({ items: [] }),
      platform_draft_residue: () =>
        draftResidue({ workerDefinitions: 2, skills: 1, procedures: 0, total: 3 }),
      runtime_inventory: () => runtimeInventory(),
    });
    renderPage(http);

    const counts = await screen.findByTestId('residue-drafts-counts');
    expect(counts.textContent).toContain('2');
    expect(counts.textContent).toContain('1');
    expect(counts.textContent).toContain('3');
    const card = screen.getByTestId('residue-drafts-card');
    expect(card.textContent).toContain('30');
    // Never a draft name, description, or proposer — the capability itself never sends one.
    expect(card.textContent).not.toMatch(/proposed_by|proposer/i);
  });

  it('lists exited entry containers only (running ones excluded), and names the missing reclaim capability', async () => {
    const http = scriptedHttp({
      list_workspaces: () => ({ items: [] }),
      platform_draft_residue: () => draftResidue(),
      runtime_inventory: () =>
        runtimeInventory({
          residentContainers: [
            {
              principalId: 'p-1',
              workspaceId: 'ws-1',
              containerId: 'c-running',
              running: true,
              status: 'running',
              image: 'nexttime-ai-worker-runtime:latest',
              imageId: 'sha256:aaa',
              startedAt: '2026-09-24T00:00:00.000Z',
              lastTouchedAt: '2026-09-25T00:00:00.000Z',
              needsRebuild: false,
            },
            {
              principalId: 'p-2',
              workspaceId: 'ws-2',
              containerId: 'c-exited',
              running: false,
              status: 'exited',
              image: 'nexttime-ai-worker-runtime:old',
              imageId: null,
              startedAt: null,
              lastTouchedAt: '2026-09-20T00:00:00.000Z',
              needsRebuild: false,
            },
          ],
        }),
    });
    renderPage(http);

    const list = await screen.findByTestId('residue-containers-list');
    expect(list.textContent).toContain('nexttime-ai-worker-runtime:old');
    expect(list.textContent).not.toContain('c-running');
    const card = screen.getByTestId('residue-containers-card');
    expect(card.textContent).not.toContain('遗留'); // no internal leftover number in visible copy
  });

  it('shows an empty state when no entry container has exited', async () => {
    const http = scriptedHttp({
      list_workspaces: () => ({ items: [] }),
      platform_draft_residue: () => draftResidue(),
      runtime_inventory: () => runtimeInventory({ residentContainers: [] }),
    });
    renderPage(http);
    expect(await screen.findByTestId('residue-containers-empty')).toBeTruthy();
  });
});
