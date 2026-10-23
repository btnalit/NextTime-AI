// @vitest-environment jsdom
import type {
  PackComponentStateWire,
  PackInstallItemWire,
  PackInstallPreviewWire,
  PackWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { PacksTab } from './PacksTab.js';

afterEach(cleanup);

const SEGMENT_ID = '11111111-2222-4333-8444-555555555555';
const NEW_SEGMENT_ID = '66666666-7777-4888-8999-000000000000';

const VERSIONS: PackWire['versions'] = [
  {
    version: 1,
    summary: 'Hosts and the services on them',
    notes: 'First version',
    breaking: false,
    requiredConnectors: [],
    requiredPacks: [],
    components: [{ kind: 'ontology', family: 'ops-assets', domainPack: 'ops-assets-v1.yaml' }],
  },
  {
    version: 2,
    summary: 'Hosts and the services on them',
    notes: '新增 Disk 与 restart 动作',
    breaking: true,
    requiredConnectors: [],
    requiredPacks: [],
    components: [{ kind: 'ontology', family: 'ops-assets', domainPack: 'ops-assets-v2.yaml' }],
  },
];

function component(patch: Partial<PackComponentStateWire> = {}): PackComponentStateWire {
  return {
    kind: 'ontology',
    family: 'ops-assets',
    domainPack: 'ops-assets-v2.yaml',
    status: 'outdated',
    installedVersion: 1,
    provenance: {
      status: 'recorded',
      segmentId: SEGMENT_ID,
      segmentStatus: 'applied',
      channel: 'human',
      appliedBy: { id: 'p-1', kind: 'human', displayName: 'Ada' },
      appliedAt: new Date().toISOString(),
    },
    ...patch,
  } as PackComponentStateWire;
}

function pack(patch: Partial<PackWire> = {}): PackWire {
  return {
    name: 'ops-assets',
    summary: 'Hosts and the services on them',
    latestVersion: 2,
    versions: VERSIONS,
    status: 'outdated',
    installedVersion: 1,
    components: [component()],
    requirements: [],
    dependencies: [],
    ...patch,
  };
}

function item(patch: Partial<PackInstallItemWire> = {}): PackInstallItemWire {
  return {
    ordinal: 1,
    kind: 'ontology_version',
    target: { family: 'ops-assets', ontologyId: 'o-1' },
    domainPack: 'ops-assets-v2.yaml',
    before: { version: 3, definitionDigest: 'sha256:before' },
    after: { definitionDigest: 'sha256:after' },
    unchanged: false,
    classification: 'not_widening',
    widening: [],
    types: {
      added: { objectTypes: ['Disk'], linkTypes: [], actionTypes: [] },
      removed: { objectTypes: ['Rack'], linkTypes: [], actionTypes: [] },
      changed: { objectTypes: ['Host'], linkTypes: [], actionTypes: [] },
    },
    ...patch,
  } as PackInstallItemWire;
}

function preview(patch: Partial<PackInstallPreviewWire> = {}): PackInstallPreviewWire {
  return {
    pack: pack(),
    targetVersion: 2,
    digest: 'sha256:plan',
    unchanged: false,
    crossedVersions: [2],
    breaking: true,
    items: [item()],
    inUse: { objects: 4, links: 1, capped: false },
    ...patch,
  };
}

const OWNER_WORKSPACE = {
  id: 'ws-1',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00Z',
  principalCount: 1,
  gatekeeperCount: 0,
  caller: { id: 'p-owner', role: 'owner', displayName: 'Owner', kind: 'human' },
};

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown>,
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

function Harness({
  http,
  initialItemId,
  platformAdmin,
}: {
  http: CapabilityCaller;
  initialItemId?: string;
  platformAdmin?: boolean;
}) {
  const [itemId, setItemId] = useState<string | undefined>(initialItemId);
  return (
    <PacksTab
      http={http}
      itemId={itemId}
      onSelectItem={(id) => setItemId(id ?? undefined)}
      platformAdmin={platformAdmin}
    />
  );
}

function renderTab(
  http: CapabilityCaller,
  initialItemId?: string,
  options: { readonly platformAdmin?: boolean } = {},
) {
  return render(
    <PermissionsProvider>
      <Harness http={http} initialItemId={initialItemId} platformAdmin={options.platformAdmin} />
    </PermissionsProvider>,
  );
}

const named = <T extends { readonly name: string }>(calls: readonly T[], name: string) =>
  calls.filter((call) => call.name === name);

describe('PacksTab (能力目录 · 能力包, S11 P1-C)', () => {
  it('lists packs; a pack shows its parts with the record behind each, and its versions', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({
        items: [
          pack({
            name: 'kit',
            status: 'customized',
            installedVersion: null,
            components: [
              component({ family: 'kit-core', status: 'up_to_date', installedVersion: 2 }),
              component({
                family: 'kit-platform',
                status: 'outdated',
                installedVersion: 1,
                provenance: {
                  ...(component().provenance as Extract<
                    PackComponentStateWire['provenance'],
                    { status: 'recorded' }
                  >),
                  channel: 'platform',
                },
              }),
              component({
                family: 'kit-old',
                status: 'customized',
                installedVersion: null,
                provenance: { status: 'provenance_unknown' },
              }),
              component({
                family: 'kit-new',
                status: 'not_installed',
                installedVersion: null,
                provenance: { status: 'not_installed' },
              }),
            ],
          }),
          pack(),
        ],
      }),
    });
    renderTab(http);

    const row = await screen.findByTestId('catalog-pack-row-ops-assets');
    expect(row.textContent).toMatch(/已装 v1 · 最新 v2/);
    expect(within(row).getByText('有新版')).toBeTruthy();
    fireEvent.click(screen.getByTestId('catalog-pack-row-kit'));

    const pane = await screen.findByTestId('catalog-pack-detail');
    expect(within(pane).getByTestId('catalog-pack-status').textContent).toBe('已定制');
    expect(pane.textContent).toContain('对不上任何一个版本（已定制）');
    expect(within(pane).getByTestId('catalog-pack-customized-why').textContent).toMatch(
      /可能只装了其中一部分/,
    );

    const link = within(pane).getByTestId('catalog-pack-provenance-link-kit-core');
    expect(link.getAttribute('href')).toBe(`#/govern/catalog/changes/${SEGMENT_ID}`);
    expect(link.textContent).toBe('查看安装记录');
    expect(within(pane).getByTestId('catalog-pack-provenance-kit-core').textContent).toMatch(
      /^Ada · /,
    );
    expect(within(pane).getByTestId('catalog-pack-provenance-kit-platform').textContent).toMatch(
      /^创建工作区时由平台安装 · /,
    );
    expect(within(pane).getByTestId('catalog-pack-provenance-kit-old').textContent).toMatch(
      /^没有安装记录/,
    );
    expect(within(pane).queryByTestId('catalog-pack-provenance-kit-new')).toBeNull();
    expect(within(pane).getByTestId('catalog-pack-component-kit-platform').textContent).toMatch(
      /内容与能力包 v1 一致/,
    );

    const versions = within(pane).getByTestId('catalog-pack-versions');
    expect(versions.firstElementChild?.getAttribute('data-testid')).toBe('catalog-pack-version-2');
    expect(within(pane).getByTestId('catalog-pack-version-2').textContent).toMatch(/不兼容升级/);
    expect(within(pane).getByTestId('catalog-pack-install-trigger').textContent).toBe(
      '换成 v2 的标准内容…',
    );
  });

  it('the owner reviews an upgrade (versions, type changes, data in use), ticks the authority change, installs what was reviewed', async () => {
    let installed = false;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({
        items: [
          installed
            ? pack({
                status: 'up_to_date',
                installedVersion: 2,
                components: [component({ status: 'up_to_date', installedVersion: 2 })],
              })
            : pack(),
        ],
      }),
      preview_pack_install: () =>
        preview({
          items: [
            item({
              classification: 'authority_widening',
              widening: [{ path: 'actionTypes[restart]', reason: 'added' }],
            }),
          ],
        }),
      install_pack: () => {
        installed = true;
        return {
          pack: pack({ status: 'up_to_date', installedVersion: 2 }),
          segmentId: NEW_SEGMENT_ID,
          verification: null,
        };
      },
    });
    renderTab(http, 'ops-assets');

    fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
    const review = await screen.findByTestId('catalog-pack-preview');
    expect(named(http.calls, 'preview_pack_install')).toEqual([
      { name: 'preview_pack_install', params: { name: 'ops-assets' } },
    ]);
    expect(within(review).getByTestId('catalog-pack-preview-versions').textContent).toMatch(
      /这次会装上 v2：v2（不兼容升级）：新增 Disk 与 restart 动作/,
    );
    expect(within(review).getByTestId('catalog-pack-preview-breaking').textContent).toMatch(
      /经过不兼容升级的版本/,
    );
    const changes = within(review).getByTestId('catalog-pack-item-1');
    expect(changes.textContent).toMatch(/本体 ops-assets：第 3 版 → 新的一版/);
    expect(changes.textContent).toMatch(/新增：对象类型 Disk/);
    expect(changes.textContent).toMatch(/修改：对象类型 Host/);
    expect(changes.textContent).toMatch(/装好后不再有：对象类型 Rack/);
    expect(within(review).getByTestId('catalog-pack-in-use').textContent).toMatch(
      /4 个对象、1 条有效关系/,
    );

    const confirm = screen.getByRole('button', { name: '升级' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId('catalog-pack-missing').textContent).toBe(
      '还差：勾选 1 项权限边界确认',
    );
    const tick = screen.getByTestId('catalog-pack-confirm-item-1');
    expect(tick.closest('label')?.textContent).toMatch(/新增动作类型 restart/);
    fireEvent.click(tick);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(named(http.calls, 'install_pack')).toEqual([
        {
          name: 'install_pack',
          params: {
            name: 'ops-assets',
            version: 2,
            reviewedDigest: 'sha256:plan',
            confirmedOrdinals: [1],
          },
        },
      ]),
    );
    const done = await screen.findByTestId('catalog-pack-installed');
    expect(done.closest('output')).not.toBeNull();
    expect(done.textContent).toMatch(/已装上 v2/);
    expect(screen.getByTestId('catalog-pack-installed-verification').textContent).toBe(
      '装完没能核验，可以在安装记录里再核验一次。',
    );
    expect(screen.getByTestId('catalog-pack-installed-record').getAttribute('href')).toBe(
      `#/govern/catalog/changes/${NEW_SEGMENT_ID}`,
    );
    await waitFor(() => expect(named(http.calls, 'list_packs')).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByTestId('catalog-pack-status').textContent).toBe('已是最新'),
    );
    expect(screen.queryByTestId('catalog-pack-install-trigger')).toBeNull();
  });

  it('a customized pack says what installing replaces; an unchanged part is left as is', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [pack({ status: 'customized', installedVersion: null })] }),
      preview_pack_install: () =>
        preview({
          pack: pack({ status: 'customized', installedVersion: null }),
          breaking: false,
          inUse: { objects: 0, links: 0, capped: false },
          items: [item({ unchanged: true, before: { version: 2, definitionDigest: 'sha256:a' } })],
        }),
    });
    renderTab(http, 'ops-assets');

    fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
    const review = await screen.findByTestId('catalog-pack-preview');
    expect(within(review).getByTestId('catalog-pack-preview-customized').textContent).toMatch(
      /在能力包之外做的修改会被替换/,
    );
    expect(within(review).queryByTestId('catalog-pack-preview-breaking')).toBeNull();
    expect(within(review).queryByTestId('catalog-pack-in-use')).toBeNull();
    expect(within(review).getByTestId('catalog-pack-item-1').textContent).toBe(
      '本体 ops-assets：已经是这一版的内容，不改动',
    );
  });

  it('a change since the review installs nothing, says so and reloads the review', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [pack({ status: 'not_installed', installedVersion: null })] }),
      preview_pack_install: () =>
        preview({
          pack: pack({ status: 'not_installed', installedVersion: null }),
          breaking: false,
          items: [item({ before: null })],
        }),
      install_pack: () =>
        Promise.reject(
          new HttpError(
            'capability_error',
            'install_pack: the plan changed since it was reviewed',
            'change_plan_changed',
          ),
        ),
    });
    renderTab(http, 'ops-assets');

    fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
    await screen.findByTestId('catalog-pack-preview');
    expect(screen.getByTestId('catalog-pack-item-1').textContent).toMatch(/未安装 → 新的一版/);
    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    const error = await screen.findByTestId('confirm-error');
    expect(error.textContent).toMatch(/所以什么也没有安装。上面已经换成现在的样子/);
    expect(error.textContent).toContain('change_plan_changed');
    await waitFor(() => expect(named(http.calls, 'preview_pack_install')).toHaveLength(2));
    await waitFor(() => expect(named(http.calls, 'list_packs')).toHaveLength(2));
    expect(screen.queryByTestId('catalog-pack-installed')).toBeNull();
  });

  it('a name another ontology already holds reads as its own sentence in the review', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [pack({ status: 'not_installed', installedVersion: null })] }),
      preview_pack_install: () =>
        Promise.reject(
          new HttpError(
            'capability_error',
            'ontology type names already taken in this workspace (I-P1): ObjectType "Host"',
            'ontology_namespace_conflict',
          ),
        ),
    });
    renderTab(http, 'ops-assets');

    fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
    const banner = await screen.findByTestId('catalog-pack-preview-error');
    expect(banner.textContent).toMatch(/装上会让两个本体重名/);
    expect(banner.textContent).toContain('ontology_namespace_conflict');
    expect((screen.getByRole('button', { name: '安装' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a member reads packs but is never offered the review, and no preview is read', async () => {
    const http = scriptedHttp({
      get_workspace: () => ({
        ...OWNER_WORKSPACE,
        caller: { ...OWNER_WORKSPACE.caller, role: 'member' },
      }),
      list_packs: () => ({ items: [pack()] }),
    });
    renderTab(http, 'ops-assets');

    await screen.findByTestId('catalog-pack-detail');
    expect(await screen.findByTestId('catalog-pack-owner-only')).toBeTruthy();
    expect(screen.queryByTestId('catalog-pack-install-trigger')).toBeNull();
    expect(named(http.calls, 'preview_pack_install')).toEqual([]);
  });

  it('a pack that needs systems says where each stands, before and in the review; the install says how its verification went (P1-E)', async () => {
    const needs = pack({
      requirements: [
        {
          connector: 'docker',
          state: 'can_enable',
          gatekeepers: [],
          offered: [{ gateId: 'docker-a', displayName: '容器主机甲' }],
          platformPreset: false,
        },
        {
          connector: 'ragflow',
          state: 'needs_platform',
          gatekeepers: [],
          offered: [],
          platformPreset: false,
        },
      ],
      versions: VERSIONS.map((version) =>
        version.version === 2 ? { ...version, requiredConnectors: ['docker', 'ragflow'] } : version,
      ),
    });
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [needs] }),
      preview_pack_install: () => preview({ pack: needs }),
      install_pack: () => ({
        pack: pack({ status: 'up_to_date', installedVersion: 2 }),
        segmentId: NEW_SEGMENT_ID,
        verification: {
          trigger: 'system',
          verifiedBy: { id: 'p-owner', kind: 'human', displayName: 'Owner' },
          verifiedAt: new Date().toISOString(),
          passed: false,
          sourceFound: true,
          items: [{ ordinal: 1, kind: 'ontology_version', state: 'in_effect' }],
          requirements: [
            { connector: 'docker', state: 'can_enable', gates: [], met: false },
            { connector: 'ragflow', state: 'needs_platform', gates: [], met: false },
          ],
        },
      }),
    });
    renderTab(http, 'ops-assets');

    const listed = await screen.findByTestId('catalog-pack-requirements');
    const docker = within(listed).getByTestId('catalog-pack-requirements-docker');
    expect(docker.textContent).toMatch(/docker待启用平台已经提供，工作区还没启用。容器主机甲/);
    // P1-E2: enabled right here, not by a trip to another page.
    expect(
      within(docker).getByTestId('catalog-pack-requirements-docker-enable-docker-a'),
    ).toBeTruthy();
    expect(within(docker).queryByRole('link')).toBeNull();
    const ragflow = within(listed).getByTestId('catalog-pack-requirements-ragflow');
    // Not offered, or every instance of it disabled (UX acceptance of #705, P3-3).
    expect(ragflow.textContent).toMatch(/平台未提供平台没有提供它，或者提供的门实例已经停用/);
    // Not a platform administrator: told who does it, no link to a page they cannot open.
    expect(
      within(ragflow).getByTestId('catalog-pack-requirements-ragflow-ask-platform').textContent,
    ).toMatch(/请平台管理员在「平台 · 集成」里添加或重新启用它的门实例/);
    expect(within(ragflow).queryByRole('link')).toBeNull();
    expect(screen.getByTestId('catalog-pack-version-2').textContent).toMatch(
      /要用到的系统：docker、ragflow/,
    );
    expect(screen.getByTestId('catalog-pack-version-1').textContent).not.toMatch(/要用到的系统/);

    fireEvent.click(screen.getByTestId('catalog-pack-install-trigger'));
    const review = await screen.findByTestId('catalog-pack-preview-requirements');
    expect(review.textContent).toMatch(/安装不会等它们接好；装完会马上核验一次/);
    const inReview = within(review).getByTestId('catalog-pack-preview-requirement-docker');
    // Inside the review (itself a confirm) the list only says where each system stands.
    expect(within(inReview).queryByRole('button')).toBeNull();
    // Nothing to confirm (the item widens nothing): installing does not wait for the systems.
    const confirm = screen.getByRole('button', { name: '升级' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect((await screen.findByTestId('catalog-pack-installed-verification')).textContent).toBe(
      '装完已核验：没有通过，原因见安装记录。',
    );
  });

  it('a pack that builds on another: the review waits for it, and it is installed right on the pack’s page (P1-F)', async () => {
    let assetsInstalled = false;
    let knowledgeInstalled = false;
    const assets = () =>
      pack({
        status: assetsInstalled ? 'up_to_date' : 'not_installed',
        installedVersion: assetsInstalled ? 2 : null,
        components: [component({ status: assetsInstalled ? 'up_to_date' : 'not_installed' })],
      });
    const knowledge = () =>
      pack({
        name: 'knowledge',
        summary: 'Knowledge bases',
        latestVersion: 1,
        status: knowledgeInstalled ? 'up_to_date' : 'not_installed',
        installedVersion: knowledgeInstalled ? 1 : null,
        versions: [
          {
            ...(VERSIONS[0] as PackWire['versions'][number]),
            requiredPacks: [{ name: 'ops-assets', minVersion: 2 }],
          },
        ],
        components: [],
        dependencies: [
          {
            name: 'ops-assets',
            minVersion: 2,
            status: assetsInstalled ? 'up_to_date' : 'not_installed',
            installedVersion: assetsInstalled ? 2 : null,
            met: assetsInstalled,
          },
        ],
      });
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [assets(), knowledge()] }),
      preview_pack_install: (params) =>
        (params as { name: string }).name === 'knowledge'
          ? preview({
              pack: knowledge(),
              targetVersion: 1,
              crossedVersions: [1],
              breaking: false,
              items: [item({ before: null })],
              inUse: { objects: 0, links: 0, capped: false },
            })
          : preview({
              pack: assets(),
              breaking: false,
              items: [item({ before: null })],
              inUse: { objects: 0, links: 0, capped: false },
            }),
      install_pack: (params) => {
        if ((params as { name: string }).name === 'knowledge') {
          knowledgeInstalled = true;
          return { pack: knowledge(), segmentId: NEW_SEGMENT_ID, verification: null };
        }
        assetsInstalled = true;
        return { pack: assets(), segmentId: NEW_SEGMENT_ID, verification: null };
      },
    });
    renderTab(http, 'knowledge');

    const row = await screen.findByTestId('catalog-pack-dependency-ops-assets');
    expect(row.textContent).toMatch(/ops-assetsv2 或更高还没满足现在未安装工作区还没安装它。/);
    expect(
      within(row).getByTestId('catalog-pack-dependency-ops-assets-link').getAttribute('href'),
    ).toBe('#/govern/catalog/packs/ops-assets');
    expect(screen.getByTestId('catalog-pack-version-1').textContent).toMatch(
      /依赖的能力包：ops-assets v2 或更高/,
    );

    // The pack's own review says what it waits for, and cannot be confirmed.
    const ownTrigger = screen
      .getAllByTestId('catalog-pack-install-trigger')
      .find((trigger) => !trigger.closest('[data-testid="catalog-pack-dependencies"]'));
    fireEvent.click(ownTrigger as HTMLElement);
    const waits = await screen.findByTestId('catalog-pack-preview-dependencies');
    expect(waits.textContent).toMatch(
      /要先装好它们才能安装：ops-assets（v2 或更高，现在未安装）。关掉这个窗口，在「依赖的能力包」里可以直接安装。/,
    );
    expect((screen.getByRole('button', { name: '安装' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('catalog-pack-missing').textContent).toBe(
      '还差：先装好 ops-assets（v2 或更高）',
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByTestId('catalog-pack-preview')).toBeNull());

    // The dependency is installed from its row, behind its own review.
    fireEvent.click(within(row).getByTestId('catalog-pack-install-trigger'));
    await screen.findByTestId('catalog-pack-preview');
    expect(named(http.calls, 'preview_pack_install').at(-1)?.params).toEqual({
      name: 'ops-assets',
    });
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    const installed = await screen.findByTestId('catalog-pack-dependency-installed');
    expect(installed.closest('output')).not.toBeNull();
    expect(named(http.calls, 'install_pack')).toEqual([
      {
        name: 'install_pack',
        params: { name: 'ops-assets', version: 2, reviewedDigest: 'sha256:plan' },
      },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('catalog-pack-dependency-installed').textContent).toMatch(
        /已装上 ops-assets v2。 依赖的能力包都已装好，现在可以安装 knowledge 了。/,
      ),
    );
    expect(
      screen.getByTestId('catalog-pack-dependency-installed-record').getAttribute('href'),
    ).toBe(`#/govern/catalog/changes/${NEW_SEGMENT_ID}`);
    const met = screen.getByTestId('catalog-pack-dependency-ops-assets');
    expect(met.textContent).toMatch(/已满足现在已装 v2/);
    expect(within(met).queryByTestId('catalog-pack-install-trigger')).toBeNull();
    // Its button is gone: focus is on the row that now reads met (UX acceptance of #721, P3-1).
    await waitFor(() => expect(document.activeElement).toBe(met));
    // Still on the pack's own page.
    expect(screen.getByTestId('catalog-pack-title').textContent).toBe('knowledge');

    // The pack itself installs now; what the list said about doing so is gone (P3-2).
    fireEvent.click(screen.getByTestId('catalog-pack-install-trigger'));
    await screen.findByTestId('catalog-pack-preview');
    const install = screen.getByRole('button', { name: '安装' }) as HTMLButtonElement;
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    await screen.findByTestId('catalog-pack-installed');
    expect(screen.queryByTestId('catalog-pack-dependency-installed')).toBeNull();
  });

  it('a pack it builds on changing after the review installs nothing and reloads the review (P1-F)', async () => {
    const knowledge = pack({
      name: 'knowledge',
      latestVersion: 1,
      status: 'not_installed',
      installedVersion: null,
      versions: [VERSIONS[0] as PackWire['versions'][number]],
      dependencies: [
        {
          name: 'ops-assets',
          minVersion: 2,
          status: 'up_to_date',
          installedVersion: 2,
          met: true,
        },
      ],
    });
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [knowledge] }),
      preview_pack_install: () =>
        preview({
          pack: knowledge,
          targetVersion: 1,
          crossedVersions: [1],
          breaking: false,
          items: [item({ before: null })],
          inUse: { objects: 0, links: 0, capped: false },
        }),
      install_pack: () =>
        Promise.reject(
          new HttpError(
            'capability_error',
            'pack knowledge builds on ops-assets v2 or later, not installed here at that version',
            'pack_dependency_unmet',
          ),
        ),
    });
    renderTab(http, 'knowledge');

    const row = await screen.findByTestId('catalog-pack-dependency-ops-assets');
    expect(row.textContent).toMatch(/已满足现在已装 v2/);
    expect(within(row).queryByTestId('catalog-pack-install-trigger')).toBeNull();
    fireEvent.click(screen.getByTestId('catalog-pack-install-trigger'));
    await screen.findByTestId('catalog-pack-preview');
    expect(screen.queryByTestId('catalog-pack-preview-dependencies')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    const error = await screen.findByTestId('confirm-error');
    expect(error.textContent).toMatch(
      /它依赖的能力包有了变化（被撤销或换了版本），现在不满足要求，所以什么也没有安装/,
    );
    await waitFor(() => expect(named(http.calls, 'preview_pack_install')).toHaveLength(2));
    await waitFor(() => expect(named(http.calls, 'list_packs')).toHaveLength(2));
  });

  it('a pack this deployment does not ship says so', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [pack()] }),
    });
    renderTab(http, 'gone');
    expect((await screen.findByTestId('catalog-pack-not-found')).textContent).toMatch(
      /这个部署里没有这个能力包/,
    );
  });
  it('Skills and Workers: each part says what it is and links to its page; the review shows what each installs and what it may do', async () => {
    const CREW_VERSIONS: PackWire['versions'] = [
      {
        version: 1,
        summary: 'Ops crew',
        notes: 'First version',
        breaking: false,
        requiredConnectors: [],
        requiredPacks: [],
        components: [
          { kind: 'skill', name: 'docker-triage', description: '排查容器问题' },
          { kind: 'worker', name: 'ops-runner', description: '通用运维执行者', systems: [] },
        ],
      },
    ];
    const recorded = component().provenance;
    const crew = pack({
      name: 'ops-base',
      latestVersion: 1,
      versions: CREW_VERSIONS,
      status: 'customized',
      installedVersion: null,
      components: [
        {
          kind: 'skill',
          name: 'docker-triage',
          skillId: 'skill-1',
          status: 'up_to_date',
          installedVersion: 1,
          provenance: recorded,
        },
        {
          kind: 'worker',
          name: 'ops-runner',
          definitionId: 'def-1',
          headVersion: null,
          systems: [],
          gates: [],
          gatesKept: false,
          bindable: false,
          status: 'not_installed',
          installedVersion: null,
          provenance: { status: 'not_installed' },
        },
      ],
    });
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_packs: () => ({ items: [crew] }),
      preview_pack_install: () =>
        preview({
          pack: crew,
          targetVersion: 1,
          crossedVersions: [1],
          breaking: false,
          inUse: { objects: 0, links: 0, capped: false },
          items: [
            {
              ordinal: 1,
              kind: 'skill_version',
              target: { skillId: 'skill-1', name: 'docker-triage' },
              before: { version: 2, contentDigest: 'sha256:b' },
              after: { contentDigest: 'sha256:c' },
              unchanged: false,
              classification: 'authority_widening',
              widening: [{ path: 'skill.markdown', reason: 'changed' }],
              skill: {
                name: 'docker-triage',
                description: '排查容器问题',
                markdown: '# Triage\n\nLook first.',
              },
              changedFields: ['markdown'],
            },
            {
              ordinal: 2,
              kind: 'worker_definition_version',
              target: { definitionId: 'def-1', name: 'ops-runner' },
              before: null,
              after: { contentDigest: 'sha256:d' },
              unchanged: false,
              classification: 'authority_widening',
              widening: [{ path: 'worker', reason: 'added' }],
              worker: {
                name: 'ops-runner',
                description: '通用运维执行者',
                systemPrompt: 'You are ops-runner.',
                skills: ['docker-triage'],
                capabilities: null,
                egressDeny: [],
              },
              binding: { systems: [], source: 'none', gates: [], candidates: [], model: null },
              changedFields: ['description', 'name', 'skills', 'systemPrompt'],
            },
          ],
        }),
      install_pack: () => ({ pack: crew, segmentId: NEW_SEGMENT_ID, verification: null }),
    });
    renderTab(http, 'ops-base');

    const pane = await screen.findByTestId('catalog-pack-detail');
    const skill = within(pane).getByTestId('catalog-pack-component-skill-docker-triage');
    expect(skill.textContent).toMatch(/^Skill docker-triage/);
    expect(skill.textContent).toContain('排查容器问题');
    expect(
      within(skill)
        .getByTestId('catalog-pack-component-page-skill-docker-triage')
        .getAttribute('href'),
    ).toBe('#/govern/catalog/skills/skill-1');
    const worker = within(pane).getByTestId('catalog-pack-component-worker-ops-runner');
    expect(worker.textContent).toMatch(/^Worker ops-runner/);
    // Not installed: nothing to open yet.
    expect(
      within(worker).queryByTestId('catalog-pack-component-page-worker-ops-runner'),
    ).toBeNull();

    fireEvent.click(within(pane).getByTestId('catalog-pack-install-trigger'));
    const review = await screen.findByTestId('catalog-pack-preview');
    const skillItem = within(review).getByTestId('catalog-pack-item-1');
    expect(skillItem.textContent).toMatch(/Skill docker-triage：第 2 版 → 新的一版/);
    expect(within(skillItem).getByTestId('catalog-pack-item-1-changed').textContent).toBe(
      '和工作区里现在的相比，改动了：正文',
    );
    expect(within(skillItem).getByTestId('catalog-pack-item-1-content').textContent).toMatch(
      /查看 Skill 正文.*Look first\./,
    );
    expect(screen.getByTestId('catalog-pack-confirm-item-1').closest('label')?.textContent).toMatch(
      /Skill 正文有改动/,
    );

    const workerItem = within(review).getByTestId('catalog-pack-item-2');
    expect(workerItem.textContent).toMatch(/Worker ops-runner：未安装 → 新的一版/);
    // A first install lists no "changed" fields: everything is new.
    expect(within(workerItem).queryByTestId('catalog-pack-item-2-changed')).toBeNull();
    expect(within(workerItem).getByTestId('catalog-pack-item-2-skills').textContent).toMatch(
      /^挂载的 Skill：docker-triage$/,
    );
    expect(within(workerItem).getByTestId('catalog-pack-item-2-capabilities').textContent).toMatch(
      /平台默认.*不能执行需要审批的操作/,
    );
    expect(screen.getByTestId('catalog-pack-confirm-item-2').closest('label')?.textContent).toMatch(
      /新增这个 Worker：能委派任务的助手都可以调用它/,
    );

    fireEvent.click(screen.getByTestId('catalog-pack-confirm-item-1'));
    fireEvent.click(screen.getByTestId('catalog-pack-confirm-item-2'));
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    await waitFor(() =>
      expect(named(http.calls, 'install_pack')).toEqual([
        {
          name: 'install_pack',
          params: {
            name: 'ops-base',
            version: 1,
            reviewedDigest: 'sha256:plan',
            confirmedOrdinals: [1, 2],
          },
        },
      ]),
    );
  });
  describe('a pack Worker’s systems (P1-E2)', () => {
    const SYSTEMS_VERSIONS: PackWire['versions'] = [
      {
        version: 1,
        summary: 'Ops crew',
        notes: 'First version',
        breaking: false,
        requiredConnectors: ['docker'],
        requiredPacks: [],
        components: [
          { kind: 'worker', name: 'ops-runner', description: null, systems: ['docker'] },
        ],
      },
    ];
    const DOCKER_CONNECTED: PackWire['requirements'] = [
      {
        connector: 'docker',
        state: 'connected',
        gatekeepers: [
          { id: 'gk-north', name: 'north' },
          { id: 'gk-south', name: 'south' },
        ],
        offered: [],
        platformPreset: false,
      },
    ];
    const CANDIDATES = [
      { id: 'gk-north', name: 'north', connector: 'docker' },
      { id: 'gk-south', name: 'south', connector: 'docker' },
    ];
    function runner(
      patch: Partial<Extract<PackComponentStateWire, { kind: 'worker' }>> = {},
    ): PackComponentStateWire {
      return {
        kind: 'worker',
        name: 'ops-runner',
        definitionId: 'def-1',
        headVersion: null,
        systems: ['docker'],
        gates: [],
        gatesKept: false,
        bindable: false,
        status: 'not_installed',
        installedVersion: null,
        provenance: { status: 'not_installed' },
        ...patch,
      } as PackComponentStateWire;
    }
    function crew(patch: Partial<PackWire> = {}): PackWire {
      return pack({
        name: 'ops-base',
        latestVersion: 1,
        versions: SYSTEMS_VERSIONS,
        status: 'not_installed',
        installedVersion: null,
        components: [runner()],
        requirements: DOCKER_CONNECTED,
        ...patch,
      });
    }
    function runnerItem(
      binding: Partial<
        Extract<PackInstallItemWire, { kind: 'worker_definition_version' }>['binding']
      >,
    ): PackInstallItemWire {
      return {
        ordinal: 1,
        kind: 'worker_definition_version',
        target: { definitionId: 'def-1', name: 'ops-runner' },
        before: null,
        after: { contentDigest: 'sha256:d' },
        unchanged: false,
        classification: 'authority_widening',
        widening: [{ path: 'worker', reason: 'added' }],
        worker: {
          name: 'ops-runner',
          description: null,
          systemPrompt: 'You are ops-runner.',
          skills: [],
          capabilities: null,
          egressDeny: [],
        },
        binding: {
          systems: ['docker'],
          source: 'install',
          gates: [],
          candidates: CANDIDATES,
          model: null,
          ...binding,
        },
        changedFields: ['name', 'systemPrompt'],
      };
    }
    /** The preview the kernel would give for `workerGates` (every candidate when absent). */
    function previewFor(params: unknown, packWire: PackWire): PackInstallPreviewWire {
      const kept = (params as { workerGates?: Record<string, string[]> }).workerGates?.[
        'ops-runner'
      ];
      const gates = CANDIDATES.filter((gate) => kept === undefined || kept.includes(gate.id));
      return preview({
        pack: packWire,
        targetVersion: 1,
        digest: `sha256:plan-${gates.map((gate) => gate.id).join('+') || 'none'}`,
        crossedVersions: packWire.status === 'up_to_date' ? [] : [1],
        breaking: false,
        inUse: { objects: 0, links: 0, capped: false },
        items: [
          runnerItem({
            source: gates.length > 0 ? 'install' : 'none',
            gates: gates.map(({ id, name }) => ({ id, name })),
          }),
        ],
      });
    }

    it('the review lists every gate by name, all ticked; unticking one reads the review again, and the install passes what was reviewed', async () => {
      const readiness = vi.fn();
      window.addEventListener('nexttime:execution-readiness-changed', readiness);
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [crew()] }),
        preview_pack_install: (params) => previewFor(params, crew()),
        install_pack: () => ({ pack: crew(), segmentId: NEW_SEGMENT_ID, verification: null }),
      });
      renderTab(http, 'ops-base');

      const pane = await screen.findByTestId('catalog-pack-detail');
      expect(
        within(pane).getByTestId('catalog-pack-component-worker-ops-runner-gates').textContent,
      ).toBe('要用到 docker：安装时会接上工作区里已经接好的。');
      fireEvent.click(within(pane).getByTestId('catalog-pack-install-trigger'));
      const choice = await screen.findByTestId('catalog-pack-item-1-binding-choice');
      expect(choice.textContent).toMatch(/默认全部接上，可以取消勾选/);
      const north = within(choice).getByTestId(
        'catalog-pack-item-1-binding-gate-gk-north',
      ) as HTMLInputElement;
      const south = within(choice).getByTestId(
        'catalog-pack-item-1-binding-gate-gk-south',
      ) as HTMLInputElement;
      expect([north.checked, south.checked]).toEqual([true, true]);
      expect(north.closest('label')?.textContent).toBe('north（docker）');
      expect(named(http.calls, 'preview_pack_install')[0]?.params).toEqual({ name: 'ops-base' });

      fireEvent.click(south);
      await waitFor(() =>
        expect(named(http.calls, 'preview_pack_install').at(-1)?.params).toEqual({
          name: 'ops-base',
          workerGates: { 'ops-runner': ['gk-north'] },
        }),
      );
      expect(
        (screen.getByTestId('catalog-pack-item-1-binding-gate-gk-south') as HTMLInputElement)
          .checked,
      ).toBe(false);
      // The binding widens what the Worker may act on: confirmed by itself.
      fireEvent.click(await screen.findByTestId('catalog-pack-confirm-item-1'));
      const confirm = screen.getByRole('button', { name: '安装' }) as HTMLButtonElement;
      await waitFor(() => expect(confirm.disabled).toBe(false));
      fireEvent.click(confirm);
      await waitFor(() =>
        expect(named(http.calls, 'install_pack').map((call) => call.params)).toEqual([
          {
            name: 'ops-base',
            version: 1,
            reviewedDigest: 'sha256:plan-gk-north',
            confirmedOrdinals: [1],
            workerGates: { 'ops-runner': ['gk-north'] },
          },
        ]),
      );
      // Legacy 425: the readiness hint at the top reads itself again.
      await waitFor(() => expect(readiness).toHaveBeenCalled());
      window.removeEventListener('nexttime:execution-readiness-changed', readiness);
    });

    it('unticking every gate says the Worker will act on nothing', async () => {
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [crew()] }),
        preview_pack_install: (params) => previewFor(params, crew()),
      });
      renderTab(http, 'ops-base');
      fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
      fireEvent.click(await screen.findByTestId('catalog-pack-item-1-binding-gate-gk-north'));
      fireEvent.click(screen.getByTestId('catalog-pack-item-1-binding-gate-gk-south'));
      expect(
        (await screen.findByTestId('catalog-pack-item-1-binding-none-kept')).textContent,
      ).toMatch(/一个都不接：它不能对任何系统动手。这个选择会记下来，之后不再提示接上/);
      await waitFor(() =>
        expect(named(http.calls, 'preview_pack_install').at(-1)?.params).toEqual({
          name: 'ops-base',
          workerGates: { 'ops-runner': [] },
        }),
      );
    });

    it('up to date with a Worker installed before docker was connected: the pack offers to connect it', async () => {
      const installed = crew({
        status: 'up_to_date',
        installedVersion: 1,
        components: [
          runner({
            status: 'up_to_date',
            installedVersion: 1,
            headVersion: 1,
            bindable: true,
            provenance: component().provenance,
          }),
        ],
      });
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [installed] }),
        preview_pack_install: (params) => previewFor(params, installed),
      });
      renderTab(http, 'ops-base');

      const pane = await screen.findByTestId('catalog-pack-detail');
      expect(
        within(pane).getByTestId('catalog-pack-component-worker-ops-runner-gates').textContent,
      ).toBe('还没接上任何系统。工作区现在有接好的 docker，再装一次就能接上。');
      const trigger = within(pane).getByTestId('catalog-pack-install-trigger');
      expect(trigger.textContent).toBe('把 Worker 接上系统…');
      fireEvent.click(trigger);
      await screen.findByTestId('catalog-pack-item-1-binding-choice');
      expect(screen.getByRole('button', { name: '接上' })).toBeTruthy();
      // Unticking every gate connects nothing: the install records that choice (P3-2).
      fireEvent.click(screen.getByTestId('catalog-pack-item-1-binding-gate-gk-north'));
      fireEvent.click(screen.getByTestId('catalog-pack-item-1-binding-gate-gk-south'));
      expect(await screen.findByRole('button', { name: '记下：不接' })).toBeTruthy();
    });

    it('a Worker the workspace connected to no system: says so, and is not offered to connect again', async () => {
      const none = crew({
        status: 'up_to_date',
        installedVersion: 1,
        components: [
          runner({
            status: 'up_to_date',
            installedVersion: 1,
            headVersion: 2,
            gatesKept: true,
            provenance: component().provenance,
          }),
        ],
      });
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [none] }),
      });
      renderTab(http, 'ops-base');
      const line = await screen.findByTestId('catalog-pack-component-worker-ops-runner-gates');
      expect(line.textContent).toBe(
        '不接任何系统：这是工作区为它定的，再装也会保留。在 Worker 页修改',
      );
      expect(
        within(line)
          .getByTestId('catalog-pack-component-worker-ops-runner-gates-change')
          .getAttribute('href'),
      ).toBe('#/govern/catalog/workers/def-1%402');
      expect(screen.queryByTestId('catalog-pack-install-trigger')).toBeNull();
    });

    it('a Worker already connected: its gates link to their pages, and the review keeps them and the model', async () => {
      const outdated = crew({
        status: 'outdated',
        installedVersion: 1,
        latestVersion: 1,
        components: [
          runner({
            status: 'outdated',
            installedVersion: 1,
            headVersion: 2,
            gates: [{ id: 'gk-south', name: 'south' }],
            provenance: component().provenance,
          }),
        ],
      });
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [outdated] }),
        preview_pack_install: () =>
          preview({
            pack: outdated,
            targetVersion: 1,
            breaking: false,
            inUse: { objects: 0, links: 0, capped: false },
            items: [
              runnerItem({
                source: 'workspace',
                gates: [{ id: 'gk-south', name: 'south' }],
                candidates: [],
                model: 'fake/fake-echo',
              }),
            ],
          }),
      });
      renderTab(http, 'ops-base');

      const line = await screen.findByTestId('catalog-pack-component-worker-ops-runner-gates');
      expect(line.textContent).toMatch(/^接入的系统：south在 Worker 页修改$/);
      // P3-6: changed on the Worker's own page.
      expect(
        within(line)
          .getByTestId('catalog-pack-component-worker-ops-runner-gates-change')
          .getAttribute('href'),
      ).toBe('#/govern/catalog/workers/def-1%402');
      expect(
        within(line)
          .getByTestId('catalog-pack-component-worker-ops-runner-gates-gk-south')
          .getAttribute('href'),
      ).toBe('#/govern/systems/gk-south');
      fireEvent.click(screen.getByTestId('catalog-pack-install-trigger'));
      expect((await screen.findByTestId('catalog-pack-item-1-binding-kept')).textContent).toMatch(
        /^接入的系统：沿用工作区为它选的 south$/,
      );
      expect(screen.getByTestId('catalog-pack-item-1-binding-model').textContent).toMatch(
        /^模型：沿用工作区设置的 fake\/fake-echo$/,
      );
      expect(screen.queryByTestId('catalog-pack-item-1-binding-choice')).toBeNull();
    });

    it('docker not connected yet: the review says the Worker is connected to nothing for now', async () => {
      const waiting = crew({
        requirements: [
          {
            connector: 'docker',
            state: 'can_enable',
            gatekeepers: [],
            offered: [{ gateId: 'docker-a', displayName: '容器主机甲' }],
            platformPreset: false,
          },
        ],
      });
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [waiting] }),
        preview_pack_install: () =>
          preview({
            pack: waiting,
            targetVersion: 1,
            breaking: false,
            inUse: { objects: 0, links: 0, capped: false },
            items: [runnerItem({ source: 'none', candidates: [] })],
          }),
      });
      renderTab(http, 'ops-base');
      fireEvent.click(await screen.findByTestId('catalog-pack-install-trigger'));
      expect(
        (await screen.findByTestId('catalog-pack-item-1-binding-unavailable')).textContent,
      ).toMatch(/它要用到 docker，工作区里还没有接好的，这次不接入任何系统/);
    });

    it('a system the platform offers is enabled in place; a platform administrator is linked to 集成 for one it does not', async () => {
      const offered = crew({
        requirements: [
          {
            connector: 'docker',
            state: 'can_enable',
            gatekeepers: [],
            offered: [{ gateId: 'docker-a', displayName: '容器主机甲' }],
            platformPreset: false,
          },
          {
            connector: 'ragflow',
            state: 'needs_platform',
            gatekeepers: [],
            offered: [],
            platformPreset: false,
          },
        ],
      });
      const connected = crew({
        requirements: [
          {
            connector: 'docker',
            state: 'connected',
            gatekeepers: [{ id: 'gk-new', name: '容器主机甲' }],
            offered: [],
            platformPreset: false,
          },
          {
            connector: 'ragflow',
            state: 'needs_platform',
            gatekeepers: [],
            offered: [],
            platformPreset: false,
          },
        ],
      });
      let enabled = false;
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [enabled ? connected : offered] }),
        preview_gate_instance_enable: () => ({
          gateId: 'docker-a',
          ambiguousCandidates: [],
          wouldLink: null,
          operationsToImport: [],
          operationsAlreadyPresent: [],
          manifestDigest: 'sha256:manifest',
        }),
        enable_gate_instance: () => {
          enabled = true;
          return { gatekeeperId: 'gk-new', linkedExisting: false, publishedOperationNames: [] };
        },
      });
      renderTab(http, 'ops-base', { platformAdmin: true });

      const docker = await screen.findByTestId('catalog-pack-requirements-docker');
      fireEvent.click(
        within(docker).getByTestId('catalog-pack-requirements-docker-enable-docker-a'),
      );
      fireEvent.click(await screen.findByRole('button', { name: '注册并启用' }));
      await waitFor(() =>
        expect(named(http.calls, 'enable_gate_instance').map((call) => call.params)).toEqual([
          { gateId: 'docker-a', manifestDigest: 'sha256:manifest' },
        ]),
      );
      // The pack is read again: the system is connected now, its Worker can be connected.
      await waitFor(() => expect(named(http.calls, 'list_packs').length).toBeGreaterThan(1));
      // The enable button is gone: focus lands on the system's row, whose state line announces
      // it (UX acceptance of #705, P3-1).
      const row = await screen.findByTestId('catalog-pack-requirements-docker');
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(within(row).getByRole('status').textContent).toMatch(/docker已接入/);

      const ragflow = screen.getByTestId('catalog-pack-requirements-ragflow');
      expect(
        within(ragflow)
          .getByTestId('catalog-pack-requirements-ragflow-platform')
          .getAttribute('href'),
      ).toBe('#/platform/integrations?tab=instances');
    });

    it('a system the platform ships a connector preset for sends a platform administrator to that preset, and tells anyone else (S11 P1-F)', async () => {
      const needsPreset = crew({
        requirements: [
          {
            connector: 'ragflow',
            state: 'needs_platform',
            gatekeepers: [],
            offered: [],
            platformPreset: true,
          },
        ],
      });
      const http = scriptedHttp({
        get_workspace: () => OWNER_WORKSPACE,
        list_packs: () => ({ items: [needsPreset] }),
      });
      renderTab(http, 'ops-base', { platformAdmin: true });
      const ragflow = await screen.findByTestId('catalog-pack-requirements-ragflow');
      const link = within(ragflow).getByTestId('catalog-pack-requirements-ragflow-preset');
      expect(link.getAttribute('href')).toBe(
        '#/platform/integrations?tab=instances&preset=ragflow',
      );
      expect(link.textContent).toMatch(/按它的接入预设接入（只填地址）/);
      expect(
        within(ragflow).queryByTestId('catalog-pack-requirements-ragflow-platform'),
      ).toBeNull();
      cleanup();

      renderTab(http, 'ops-base');
      const asked = await screen.findByTestId('catalog-pack-requirements-ragflow-ask-platform');
      expect(asked.textContent).toMatch(
        /平台自带它的接入预设：请平台管理员在「平台 · 集成」按预设接入/,
      );
      expect(
        within(screen.getByTestId('catalog-pack-requirements-ragflow')).queryByRole('link'),
      ).toBeNull();
    });
  });

  it("an installed Worker links to its published head version's row (the 「Worker」 tab names one version)", async () => {
    const crew = pack({
      name: 'ops-base',
      latestVersion: 1,
      versions: [
        {
          version: 1,
          summary: 'Ops crew',
          notes: 'First version',
          breaking: false,
          requiredConnectors: [],
          requiredPacks: [],
          components: [{ kind: 'worker', name: 'ops-runner', description: null, systems: [] }],
        },
      ],
      status: 'up_to_date',
      installedVersion: 1,
      components: [
        {
          kind: 'worker',
          name: 'ops-runner',
          definitionId: 'def-1',
          headVersion: 3,
          systems: [],
          gates: [],
          gatesKept: false,
          bindable: false,
          status: 'up_to_date',
          installedVersion: 1,
          provenance: component().provenance,
        },
      ],
    });
    renderTab(
      scriptedHttp({ get_workspace: () => OWNER_WORKSPACE, list_packs: () => ({ items: [crew] }) }),
      'ops-base',
    );
    const pane = await screen.findByTestId('catalog-pack-detail');
    expect(
      within(pane)
        .getByTestId('catalog-pack-component-page-worker-ops-runner')
        .getAttribute('href'),
    ).toBe('#/govern/catalog/workers/def-1%403');
  });
});
