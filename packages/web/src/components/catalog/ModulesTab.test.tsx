// @vitest-environment jsdom
import type { WorkspaceModuleWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { ModulesTab } from './ModulesTab.js';

afterEach(() => cleanup());

const KNOWLEDGE: WorkspaceModuleWire = {
  name: 'knowledge',
  versions: [{ version: 1, file: 'knowledge-v1.yaml', notes: 'first', breaking: false }],
  latestVersion: 1,
  installedVersion: null,
  status: 'not_installed',
  provenance: { status: 'not_installed' },
};

const SEGMENT_ID = '11111111-2222-4333-8444-555555555555';

describe('ModulesTab', () => {
  it('I-P1: a 409 ontology_namespace_conflict on install reads as its own sentence and keeps the code', async () => {
    const http: CapabilityCaller = {
      call: <T,>(name: string): Promise<T> => {
        if (name === 'list_workspace_modules') return Promise.resolve({ items: [KNOWLEDGE] } as T);
        return Promise.reject(
          new HttpError(
            'capability_error',
            'ontology type names already taken in this workspace (I-P1): ObjectType "Service" (ontology …)',
            'ontology_namespace_conflict',
          ),
        );
      },
    };
    render(
      <PermissionsProvider>
        <ModulesTab http={http} />
      </PermissionsProvider>,
    );

    fireEvent.click(await screen.findByTestId('catalog-module-action-knowledge'));

    const banner = await screen.findByTestId('catalog-module-error-knowledge');
    expect(banner.textContent).toContain('重名');
    expect(banner.textContent).toContain('ontology_namespace_conflict');
  });

  it('legacy 406: a module that would widen authority says the page cannot confirm it and who to tell', async () => {
    const http: CapabilityCaller = {
      call: <T,>(name: string): Promise<T> =>
        name === 'list_workspace_modules'
          ? Promise.resolve({ items: [KNOWLEDGE] } as T)
          : Promise.reject(
              new HttpError(
                'capability_error',
                'install_module: module content widens authority (ActionType "restart" added)',
                'change_confirmation_required',
              ),
            ),
    };
    render(
      <PermissionsProvider>
        <ModulesTab http={http} />
      </PermissionsProvider>,
    );

    fireEvent.click(await screen.findByTestId('catalog-module-action-knowledge'));

    const banner = await screen.findByTestId('catalog-module-error-knowledge');
    expect(banner.textContent).toContain('模块页做不到，所以没有安装');
    expect(banner.textContent).toContain('平台管理员');
  });

  it('legacy 300: install names the version the row offered; a newer one since installs nothing, says so and reloads', async () => {
    const sent: unknown[] = [];
    let listed = 0;
    const http: CapabilityCaller = {
      call: <T,>(name: string, params?: unknown): Promise<T> => {
        if (name === 'list_workspace_modules') {
          listed += 1;
          return Promise.resolve({ items: [KNOWLEDGE] } as T);
        }
        sent.push({ name, params });
        return Promise.reject(
          new HttpError(
            'capability_error',
            'install_module: module knowledge is at v2 now, not the v1 that was reviewed',
            'version_changed',
          ),
        );
      },
    };
    render(
      <PermissionsProvider>
        <ModulesTab http={http} />
      </PermissionsProvider>,
    );

    fireEvent.click(await screen.findByTestId('catalog-module-action-knowledge'));

    const banner = await screen.findByTestId('catalog-module-error-knowledge');
    expect(banner.textContent).toContain('在你查看之后它有了新版本，本次没有写入任何内容');
    expect(sent.filter((call) => (call as { name: string }).name.endsWith('_module'))).toEqual([
      { name: 'install_module', params: { name: 'knowledge', version: 1 } },
    ]);
    await waitFor(() => expect(listed).toBe(2));
  });

  it('S11 P1-B: the 安装记录 column links the record that installed it; says when there is none', async () => {
    const recorded: WorkspaceModuleWire = {
      ...KNOWLEDGE,
      name: 'ops-assets',
      installedVersion: 1,
      status: 'up_to_date',
      provenance: {
        status: 'recorded',
        segmentId: SEGMENT_ID,
        segmentStatus: 'applied',
        channel: 'human',
        appliedBy: { id: 'p-1', kind: 'human', displayName: 'Ada' },
        appliedAt: new Date().toISOString(),
      },
    };
    const byPlatform: WorkspaceModuleWire = {
      ...recorded,
      name: 'default-mod',
      provenance: {
        ...recorded.provenance,
        channel: 'platform',
      } as WorkspaceModuleWire['provenance'],
    };
    const unknown: WorkspaceModuleWire = {
      ...KNOWLEDGE,
      name: 'old-mod',
      installedVersion: 1,
      status: 'up_to_date',
      provenance: { status: 'provenance_unknown' },
    };
    const http: CapabilityCaller = {
      call: <T,>(name: string): Promise<T> =>
        name === 'list_workspace_modules'
          ? Promise.resolve({ items: [recorded, byPlatform, unknown, KNOWLEDGE] } as T)
          : Promise.reject(new Error(`unexpected ${name}`)),
    };
    render(
      <PermissionsProvider>
        <ModulesTab http={http} />
      </PermissionsProvider>,
    );

    const link = await screen.findByTestId('catalog-module-provenance-link-ops-assets');
    expect(link.getAttribute('href')).toBe(`#/govern/catalog/changes/${SEGMENT_ID}`);
    // The link says what it opens; who installed it and when are plain text beside it.
    expect(link.textContent).toBe('查看安装记录');
    expect(screen.getByTestId('catalog-module-provenance-ops-assets').textContent).toMatch(
      /^Ada · /,
    );
    expect(screen.getByTestId('catalog-module-provenance-link-default-mod').textContent).toBe(
      '查看安装记录',
    );
    expect(screen.getByTestId('catalog-module-provenance-default-mod').textContent).toMatch(
      /^创建工作区时由平台安装 · /,
    );
    expect(screen.getByTestId('catalog-module-provenance-old-mod').textContent).toContain(
      '没有安装记录',
    );
    expect(screen.queryByTestId('catalog-module-provenance-knowledge')).toBeNull();
  });
});
