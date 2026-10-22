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
    components: [{ kind: 'ontology', family: 'ops-assets', domainPack: 'ops-assets-v1.yaml' }],
  },
  {
    version: 2,
    summary: 'Hosts and the services on them',
    notes: '新增 Disk 与 restart 动作',
    breaking: true,
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

function Harness({ http, initialItemId }: { http: CapabilityCaller; initialItemId?: string }) {
  const [itemId, setItemId] = useState<string | undefined>(initialItemId);
  return <PacksTab http={http} itemId={itemId} onSelectItem={(id) => setItemId(id ?? undefined)} />;
}

function renderTab(http: CapabilityCaller, initialItemId?: string) {
  return render(
    <PermissionsProvider>
      <Harness http={http} initialItemId={initialItemId} />
    </PermissionsProvider>,
  );
}

const named = (calls: readonly { readonly name: string }[], name: string) =>
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
        components: [
          { kind: 'skill', name: 'docker-triage', description: '排查容器问题' },
          { kind: 'worker', name: 'ops-runner', description: '通用运维执行者' },
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
              changedFields: ['description', 'name', 'skills', 'systemPrompt'],
            },
          ],
        }),
      install_pack: () => ({ pack: crew, segmentId: NEW_SEGMENT_ID }),
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
});
