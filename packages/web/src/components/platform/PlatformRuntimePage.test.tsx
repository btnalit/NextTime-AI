// @vitest-environment jsdom
import type {
  PiDriftWire,
  PlatformWorkspaceWire,
  RollEntryContainersResultWire,
  RuntimeInventoryWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ToastProvider } from '../ui/Toast.js';
import { PlatformRuntimePage } from './PlatformRuntimePage.js';

afterEach(cleanup);

/** A `CapabilityCaller` whose named answers are scripted; unscripted names throw loudly (the
 *  convention every page test in this package uses). */
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

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <ToastProvider>
        <PlatformRuntimePage http={http} />
      </ToastProvider>
    </PermissionsProvider>,
  );
}

function image(overrides: Partial<RuntimeInventoryWire['images'][number]> = {}) {
  // `activatableRef` defaults to `tags[0]` (the same fallback expression the real kernel handler
  // used pre-P1-a-follow-up) so a test that overrides `tags` without separately overriding
  // `activatableRef` still gets a self-consistent fixture, not a stale default that silently
  // mismatches the new `tags`.
  const tags = overrides.tags ?? ['nexttime-ai-worker-runtime:v1'];
  return {
    id: 'sha256:v1000000000000000000000000000000000000000000000000000000000000',
    tags,
    createdAt: '2026-09-01T00:00:00.000Z',
    piVersion: '0.84.4',
    platformExtensionVersion: '1.0.0',
    builtFrom: 'v0.15.0 (abc1234)',
    labels: {},
    allowed: true,
    activatableRef: tags[0] ?? null,
    ...overrides,
  };
}

function resident(overrides: Partial<RuntimeInventoryWire['residentContainers'][number]> = {}) {
  return {
    principalId: 'p-1',
    workspaceId: 'ws-1',
    containerId: 'container-1',
    running: true,
    status: 'running',
    image: 'nexttime-ai-worker-runtime:v1',
    imageId: image().id,
    startedAt: '2026-09-20T00:00:00.000Z',
    lastTouchedAt: '2026-09-21T00:00:00.000Z',
    needsRebuild: false,
    ...overrides,
  };
}

function inventory(overrides: Partial<RuntimeInventoryWire> = {}): RuntimeInventoryWire {
  const activeImage = image();
  return {
    activeImage: activeImage.tags[0] ?? null,
    activeImageSource: 'setting',
    activeImageInfo: activeImage,
    images: [activeImage],
    residentContainers: [],
    checkedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

function piDrift(overrides: Partial<PiDriftWire> = {}): PiDriftWire {
  return {
    status: 'unknown',
    pinnedPiVersion: null,
    activeImagePiVersion: '0.84.4',
    platformExtensionVersion: '1.0.0',
    detail: 'no CI-produced pi-drift file yet',
    checkedAt: null,
    ...overrides,
  };
}

function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: 'ws-1',
    name: 'Ops workspace',
    status: 'active',
    entryModel: null,
    allowedModels: [],
    ontologyEnforcement: 'reject',
    purpose: 'standard',
    expiresAt: null,
    disabledAt: null,
    purgeable: false,
    isDefault: false,
    memberCount: 1,
    owners: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PlatformRuntimePage', () => {
  it('renders the active image, the image inventory and the pi drift panel', async () => {
    const http = scriptedHttp({
      runtime_inventory: () => inventory(),
      pi_drift: () => piDrift({ status: 'consistent', pinnedPiVersion: '0.84.4' }),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    const activeImage = await screen.findByTestId('runtime-active-image');
    expect(activeImage.textContent).toContain('nexttime-ai-worker-runtime:v1');
    expect(activeImage.textContent).toContain('0.84.4');

    const imagesTable = screen.getByTestId('runtime-images-table');
    expect(within(imagesTable).getByTestId('runtime-image-active-chip')).toBeTruthy();

    const drift = await screen.findByTestId('pi-drift-body');
    expect(within(drift).getByTestId('pi-drift-status').textContent).toBe('consistent');
  });

  it('shows the active image as unresolved without guessing needsRebuild', async () => {
    const http = scriptedHttp({
      runtime_inventory: () =>
        inventory({
          activeImage: 'nexttime-ai-worker-runtime:not-in-inventory',
          activeImageSource: 'env_default',
          activeImageInfo: null,
          residentContainers: [resident({ needsRebuild: false })],
        }),
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    const notice = await screen.findByTestId('runtime-active-image-unresolved');
    expect(notice.textContent).toContain('not-in-inventory');
    expect(screen.queryByTestId('runtime-active-image')).toBeNull();
  });

  it('设为活动', async () => {
    const otherImage = image({
      id: 'sha256:v2000000000000000000000000000000000000000000000000000000000000',
      tags: ['nexttime-ai-worker-runtime:v2'],
    });
    const http = scriptedHttp({
      runtime_inventory: () => inventory({ images: [image(), otherImage] }),
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [] }),
      set_active_runtime_image: (params) => {
        expect(params).toEqual({ image: 'nexttime-ai-worker-runtime:v2' });
        return {};
      },
    });
    renderPage(http);

    const row = await screen.findByTestId(`runtime-image-row-${otherImage.id}`);
    fireEvent.click(within(row).getByTestId('runtime-image-activate'));

    const confirm = await screen.findByTestId('runtime-activate-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'set_active_runtime_image')).toBe(true),
    );
  });

  it('设为活动 sends activatableRef, not tags[0], for a multi-tag image where only a later tag is allowlisted (review follow-up, PR #233)', async () => {
    const multiTagImage = image({
      id: 'sha256:v3000000000000000000000000000000000000000000000000000000000000',
      tags: ['nexttime-ai-worker-runtime:stale-alias', 'nexttime-ai-worker-runtime:v3'],
      activatableRef: 'nexttime-ai-worker-runtime:v3',
    });
    const http = scriptedHttp({
      runtime_inventory: () => inventory({ images: [image(), multiTagImage] }),
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [] }),
      set_active_runtime_image: (params) => {
        expect(params).toEqual({ image: 'nexttime-ai-worker-runtime:v3' });
        return {};
      },
    });
    renderPage(http);

    const row = await screen.findByTestId(`runtime-image-row-${multiTagImage.id}`);
    fireEvent.click(within(row).getByTestId('runtime-image-activate'));

    const confirm = await screen.findByTestId('runtime-activate-confirm');
    expect(confirm.textContent).toContain('nexttime-ai-worker-runtime:v3');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'set_active_runtime_image')).toBe(true),
    );
  });

  it('设为活动', async () => {
    const notAllowed = image({
      id: 'sha256:v2000000000000000000000000000000000000000000000000000000000000',
      tags: ['nexttime-ai-worker-runtime:v2'],
      allowed: false,
      activatableRef: null,
    });
    const http = scriptedHttp({
      runtime_inventory: () => inventory({ images: [image(), notAllowed] }),
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    const row = await screen.findByTestId(`runtime-image-row-${notAllowed.id}`);
    const button = within(row).getByTestId('runtime-image-activate') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(row.textContent).toContain('WORKER_IMAGE_ALLOWLIST');

    fireEvent.click(button);
    expect(http.calls.some((c) => c.name === 'set_active_runtime_image')).toBe(false);
  });

  it('回滚到上一个镜像', async () => {
    const otherImage = image({
      id: 'sha256:v2000000000000000000000000000000000000000000000000000000000000',
      tags: ['nexttime-ai-worker-runtime:v2'],
    });
    const http = scriptedHttp({
      runtime_inventory: () => inventory({ images: [image(), otherImage] }),
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [] }),
      rollback_runtime_image: () => ({}),
    });
    renderPage(http);

    fireEvent.click(await screen.findByTestId('runtime-rollback'));
    const confirm = await screen.findByTestId('runtime-rollback-confirm');
    // RT2: the copy renders the emphasis, not a literal `*different*`.
    expect(confirm.textContent).not.toContain('*different*');
    const emphasised = Array.from(confirm.querySelectorAll('em')).map((el) => el.textContent);
    expect(emphasised).toContain('different');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'rollback_runtime_image')).toBe(true),
    );
  });

  it('回滚到上一个镜像 (RT2) is disabled with an explanation when fewer than two images are known', async () => {
    const http = scriptedHttp({
      runtime_inventory: () => inventory(), // default fixture: one image
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    const button = (await screen.findByTestId('runtime-rollback')) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('没有可回滚到的不同值');

    fireEvent.click(button);
    expect(screen.queryByTestId('runtime-rollback-confirm')).toBeNull();
    expect(http.calls.some((c) => c.name === 'rollback_runtime_image')).toBe(false);
  });

  it('resident containers show a named workspace, a bare-id principal chip and the 待重建', async () => {
    const http = scriptedHttp({
      runtime_inventory: () =>
        inventory({ residentContainers: [resident({ needsRebuild: true })] }),
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [workspace()] }),
    });
    renderPage(http);

    const row = await screen.findByTestId('runtime-resident-row-p-1');
    expect(row.textContent).toContain('Ops workspace');
    expect(within(row).getByTestId('runtime-resident-needs-rebuild')).toBeTruthy();
    // No name source for a cross-workspace principal — RefChip honestly falls back to the bare id.
    expect(within(row).getByText('p-1')).toBeTruthy();
  });

  it('现在重建空闲的', async () => {
    const result: RollEntryContainersResultWire = {
      outcomes: [
        { principalId: 'p-1', workspaceId: 'ws-1', action: 'stopped' },
        { principalId: 'p-2', workspaceId: 'ws-1', action: 'skipped_in_flight' },
      ],
      stoppedCount: 1,
    };
    const http = scriptedHttp({
      runtime_inventory: () =>
        inventory({ residentContainers: [resident({ needsRebuild: true })] }),
      pi_drift: () => piDrift(),
      list_workspaces: () => ({ items: [] }),
      roll_entry_containers: (params) => {
        expect(params).toEqual({});
        return result;
      },
    });
    renderPage(http);

    const button = await screen.findByTestId('runtime-roll-entry-containers');
    fireEvent.click(button);

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'roll_entry_containers')).toBe(true),
    );
    expect(await screen.findByText(/已重建 1 个/)).toBeTruthy();
  });
});
