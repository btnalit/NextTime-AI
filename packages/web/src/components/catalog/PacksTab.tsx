import {
  CHANGE_ROLLBACK_IN_USE_CAP,
  type PackComponentStateWire,
  type PackComponentWire,
  type PackInstallItemWire,
  type PackInstallPreviewWire,
  type PackInstallResultWire,
  type PackWire,
} from '@nexttime/shared';
import { useEffect, useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { actionLabel as capabilityLabel } from '../../lib/capability-labels.js';
import { workerItemId } from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue } from '../kit/key-value.js';
import { List, ListRow } from '../kit/list-row.js';
import { MasterDetail } from '../kit/master-detail.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { StillNeeded } from '../kit/still-needed.js';
import { announceReadinessChange } from '../readiness/useExecutionReadiness.js';
import { PackRequirementList } from './ChangeVerification.js';
import { changeSubjectText, contentFieldText, typeNamesText, wideningText } from './ChangesTab.js';
import { MarkdownPreview } from './MarkdownPreview.js';

export interface PacksTabProps {
  readonly http: CapabilityCaller;
  /** The selected pack's name (`#/govern/catalog/packs/<name>`). */
  readonly itemId: string | undefined;
  readonly onSelectItem: (itemId: string | null) => void;
  /** `session.user?.platformRole === 'admin'`: a system the platform has not set up links to
   *  平台 · 集成. */
  readonly platformAdmin?: boolean;
}

/** 「已装 v1 · 最新 v2」 — a list row's second line. */
function versionLine(pack: PackWire, t: Translate): string {
  const latest = t(`最新 v${pack.latestVersion}`, `v${pack.latestVersion} latest`);
  const v = pack.installedVersion;
  if (v === null || v === pack.latestVersion) return latest;
  return `${t(`已装 v${v}`, `v${v} installed`)} · ${latest}`;
}

/** The 已装版本 value: a version, or why there is none. */
function installedText(pack: PackWire, t: Translate): string {
  if (pack.installedVersion !== null) return `v${pack.installedVersion}`;
  return pack.status === 'customized'
    ? t('对不上任何一个版本（已定制）', 'Matches no version (customized)')
    : t('未安装', 'Not installed');
}

/** A Worker of the pack that installing again would connect to its systems (P1-E2): installed
 *  before any gate of them was connected here. */
function bindableWorkers(pack: PackWire): readonly string[] {
  return pack.components.flatMap((component) =>
    component.kind === 'worker' && component.bindable ? [component.name] : [],
  );
}

/** The install control's label, or `null` when there is nothing to install. Up to date with a
 *  Worker to connect, installing again only connects it. */
function actionLabel(pack: PackWire, t: Translate): string | null {
  const v = pack.latestVersion;
  switch (pack.status) {
    case 'not_installed':
      return t(`安装 v${v}`, `Install v${v}`);
    case 'outdated':
      return t(`升级到 v${v}`, `Upgrade to v${v}`);
    case 'customized':
      return t(`换成 v${v} 的标准内容`, `Replace with v${v}`);
    case 'up_to_date':
      return bindableWorkers(pack).length > 0
        ? t('把 Worker 接上系统', 'Connect the Worker to its systems')
        : null;
  }
}

/**
 * components/catalog/PacksTab: 能力目录 · 能力包 (`#/govern/catalog/packs`, S11 P1-C / P1-D). A
 * **能力包** is a versioned set of components this deployment ships (Pack Contract v1, `packs/
 * <name>/<version>/pack.yaml`: ontology families, Skills, Workers) — a module is one with a single
 * ontology part, so this tab replaces the 模块 tab. Members read every pack, its versions, and
 * what this workspace has of it, per component and with the install record that put it there
 * (`list_packs`). The owner installs or upgrades one after reviewing it (`preview_pack_install`
 * inside the confirm: what each part changes, the versions it moves through, each
 * authority-widening change ticked, how much data uses a type it takes out), then `install_pack`
 * with the reviewed digest — a change since the review installs nothing and the review reloads.
 * Each install is one 安装记录 in 安装历史 (`ChangesTab`), where it can be rolled back. A pack that
 * names the systems it needs (S11 P1-E) shows where each stands, here and in the review; the
 * install does not wait for them, and is verified once right after (the result says how it went).
 */
export function PacksTab({ http, itemId, onSelectItem, platformAdmin = false }: PacksTabProps) {
  const t = useT();
  const packs = useCapabilityList<PackWire>(http, 'list_packs', {});

  // `list_packs` is reloaded in place, never dropped from the cache first: the selected pack's
  // pane is drawn from the list, and an emptied cache would unmount it (and what it just said).
  function refresh(): void {
    invalidateCapability(http, 'list_change_segments');
    invalidateCapability(http, 'get_change_segment');
    void packs.reload();
  }

  const rows = packs.state.status === 'ready' ? packs.state.data.items : [];
  const list =
    packs.state.status === 'loading' ? (
      <SkeletonRows count={3} label={t('正在加载能力包…', 'Loading packs')} />
    ) : packs.state.status === 'error' ? (
      <ErrorBanner
        error={packs.state.error}
        title={t('无法加载能力包', 'Could not load packs')}
        onRetry={() => void packs.reload()}
        testId="catalog-packs-error"
      />
    ) : (
      <div className="stack-s" data-testid="catalog-packs">
        <p className="text-3 text-small">
          {t(
            '能力包是随平台部署附带、按版本发布的一组能力：本体（对象、关系和动作类型）、Skill（Worker 读的做事方法）和 Worker（可以被委派任务的执行者）。安装或升级之前先看它会改动什么；每次安装留下一条安装记录，可以在「安装历史」里撤销。',
            'A pack is a versioned set of capabilities shipped with the platform: ontology (object, link and action types), Skills (ways of working a Worker reads) and Workers (agents tasks are delegated to). Review what it changes before installing or upgrading; each install leaves an install record you can roll back under Install history.',
          )}
        </p>
        {rows.length === 0 ? (
          <EmptyState
            title={t('这个部署没有附带能力包', 'This deployment ships no packs')}
            testId="catalog-packs-empty"
          />
        ) : (
          <List ariaLabel={t('能力包', 'Packs')} testId="catalog-packs-list">
            {rows.map((pack) => (
              <ListRow
                key={pack.name}
                testId={`catalog-pack-row-${pack.name}`}
                selected={pack.name === itemId}
                onSelect={() => onSelectItem(pack.name)}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="mono truncate">{pack.name}</span>
                  <StatusChip machine="packInstall" status={pack.status} size="s" />
                </span>
                <span className="truncate text-3">{versionLine(pack, t)}</span>
              </ListRow>
            ))}
          </List>
        )}
      </div>
    );

  const selected = itemId !== undefined ? rows.find((pack) => pack.name === itemId) : undefined;
  const detail =
    itemId === undefined ? (
      rows.length > 0 ? (
        <EmptyState
          title={t(
            '选择左侧一个能力包，查看它包含什么',
            'Select a pack on the left to see what it holds',
          )}
          testId="catalog-detail-empty"
        />
      ) : null
    ) : packs.state.status === 'loading' ? (
      <SkeletonRows count={3} label={t('正在加载能力包…', 'Loading pack')} />
    ) : selected ? (
      <PackDetail
        key={selected.name}
        http={http}
        pack={selected}
        platformAdmin={platformAdmin}
        onChanged={refresh}
      />
    ) : packs.state.status === 'ready' ? (
      <EmptyState
        title={t('这个部署里没有这个能力包', 'This deployment has no such pack')}
        body={t('从左侧列表重新选择。', 'Pick one from the list on the left.')}
        testId="catalog-pack-not-found"
      />
    ) : null;

  return (
    <MasterDetail
      list={list}
      detail={detail}
      open={itemId !== undefined}
      onClose={() => onSelectItem(null)}
      sheetTitle={t('能力包', 'Pack')}
      detailTestId="catalog-detail"
    />
  );
}

function PackDetail({
  http,
  pack,
  platformAdmin,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly pack: PackWire;
  readonly platformAdmin: boolean;
  readonly onChanged: () => void;
}) {
  const t = useT();
  // What this pane just installed: says so where the install control was (its trigger is gone).
  const [installed, setInstalled] = useState<PackInstallResultWire | null>(null);
  const versions = [...pack.versions].sort((a, b) => b.version - a.version);
  const latestComponents =
    pack.versions.find((version) => version.version === pack.latestVersion)?.components ?? [];

  return (
    <div className="stack" data-testid="catalog-pack-detail">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <h2 className="catalog-detail-title mono wrap-anywhere" data-testid="catalog-pack-title">
          {pack.name}
        </h2>
        <StatusChip machine="packInstall" status={pack.status} testId="catalog-pack-status" />
      </div>
      {pack.summary ? <p>{pack.summary}</p> : null}
      <KeyValue
        items={[
          { key: 'installed', label: t('已装版本', 'Installed'), value: installedText(pack, t) },
          { key: 'latest', label: t('最新版本', 'Latest'), value: `v${pack.latestVersion}` },
        ]}
      />
      {pack.status === 'customized' ? (
        <p className="text-3 text-small" data-testid="catalog-pack-customized-why">
          {t(
            '工作区里现在的内容和这个能力包的任何一个版本都对不上：可能只装了其中一部分，或者有内容是在能力包之外发布或改过的。下面每个组成部分各自说明是哪种情况。',
            'What the workspace has now matches no version of this pack: only part of it may be installed, or some content was published or changed outside the pack. Each part below says which.',
          )}
        </p>
      ) : null}

      {installed !== null ? (
        <output className="block">
          <Notice testId="catalog-pack-installed">
            {installed.segmentId !== null ? (
              <>
                {t(
                  `已装上 v${installed.pack.installedVersion ?? pack.latestVersion}。这次安装留下了一条安装记录，需要时可以在那里撤销。`,
                  `v${installed.pack.installedVersion ?? pack.latestVersion} is installed. The install left an install record, where it can be rolled back if needed.`,
                )}{' '}
                <span data-testid="catalog-pack-installed-verification">
                  {installed.verification === null
                    ? t(
                        '装完没能核验，可以在安装记录里再核验一次。',
                        'It could not be verified right after; verify it from the install record.',
                      )
                    : installed.verification.passed
                      ? t('装完已核验：通过。', 'Verified right after: passed.')
                      : t(
                          '装完已核验：没有通过，原因见安装记录。',
                          'Verified right after: it did not pass; the install record says why.',
                        )}
                </span>{' '}
                <RouteLink
                  href={hrefs.catalog('changes', installed.segmentId)}
                  testId="catalog-pack-installed-record"
                >
                  {t('查看安装记录', 'Open install record')}
                </RouteLink>
              </>
            ) : (
              t(
                '工作区里已经是这一版的内容，没有改动，也没有留下安装记录。',
                'The workspace already had this version, so nothing changed and no install record was left.',
              )
            )}
          </Notice>
        </output>
      ) : (
        <InstallPack
          http={http}
          pack={pack}
          onInstalled={(result) => {
            setInstalled(result);
            onChanged();
          }}
          onStale={onChanged}
        />
      )}

      {pack.requirements.length > 0 ? (
        <>
          <span className="section-title">{t('要用到的系统', 'Systems it needs')}</span>
          <p className="text-3 text-small">
            {t(
              `v${pack.latestVersion} 带来的内容要用到这些系统。系统由平台部署，能力包只检查它们在工作区里接好了没有；平台已经提供的，可以在这里直接启用。`,
              `What v${pack.latestVersion} brings works with these systems. The platform deploys them; the pack only checks whether the workspace has them connected, and one the platform offers can be enabled right here.`,
            )}
          </p>
          <PackRequirementList
            http={http}
            requirements={pack.requirements}
            platformAdmin={platformAdmin}
            onChanged={onChanged}
            testId="catalog-pack-requirements"
          />
        </>
      ) : null}

      <span className="section-title">{t('组成', 'Parts')}</span>
      <div className="stack-s" data-testid="catalog-pack-components">
        {pack.components.map((component) => (
          <ComponentView
            key={componentKey(component)}
            component={component}
            declared={latestComponents.find(
              (declared) => componentKey(declared) === componentKey(component),
            )}
          />
        ))}
      </div>

      <span className="section-title">{t('版本', 'Versions')}</span>
      <div className="stack-s" data-testid="catalog-pack-versions">
        {versions.map((version) => (
          <div
            className="stack-s"
            key={version.version}
            data-testid={`catalog-pack-version-${version.version}`}
          >
            <span className="row-wrap">
              <span className="mono">v{version.version}</span>
              {version.version === pack.installedVersion ? (
                <span className="chip chip-ok chip-s">{t('已装', 'Installed')}</span>
              ) : null}
              {version.breaking ? (
                <span className="chip chip-warn chip-s">{t('不兼容升级', 'Breaking')}</span>
              ) : null}
            </span>
            {version.notes ? <span className="text-3 text-small">{version.notes}</span> : null}
            {version.requiredConnectors.length > 0 ? (
              <span className="text-3 text-small">
                {t('要用到的系统：', 'Systems it needs: ')}
                <span className="mono">{version.requiredConnectors.join(t('、', ', '))}</span>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A part's key within the pack: its family, or its kind and name (`ontology` families and Skill /
 *  Worker names are separate namespaces). Also its test id. */
function componentKey(component: PackComponentWire | PackComponentStateWire): string {
  return component.kind === 'ontology' ? component.family : `${component.kind}-${component.name}`;
}

/** 「本体 ops-assets」, 「Skill docker-triage」, 「Worker ops-runner」. */
function componentTitle(
  component: PackComponentStateWire,
  t: Translate,
): { readonly noun: string; readonly name: string } {
  return component.kind === 'ontology'
    ? { noun: t('本体', 'Ontology'), name: component.family }
    : { noun: component.kind === 'skill' ? 'Skill' : 'Worker', name: component.name };
}

/** One part of the pack — an ontology family, a Skill or a Worker: its state, and the install
 *  record that put its current content there. No record: installed before records were kept, or
 *  published some other way (`publish_ontology_version`, `publish_skill`, …); it cannot be rolled
 *  back from here. An installed Skill or Worker links to its own page in the catalog. */
function ComponentView({
  component,
  declared,
}: {
  readonly component: PackComponentStateWire;
  /** The latest version's declaration of it (a Skill's or Worker's description). */
  readonly declared: PackComponentWire | undefined;
}) {
  const t = useT();
  const provenance = component.provenance;
  const key = componentKey(component);
  const { noun, name } = componentTitle(component, t);
  const description =
    declared && declared.kind !== 'ontology' ? (declared.description ?? null) : null;
  const page =
    component.status === 'not_installed'
      ? null
      : component.kind === 'skill'
        ? hrefs.catalog('skills', component.skillId)
        : component.kind === 'worker' && component.headVersion !== null
          ? hrefs.catalog(
              'workers',
              workerItemId({ id: component.definitionId, version: component.headVersion }),
            )
          : null;
  return (
    <div className="card card-padded stack-s" data-testid={`catalog-pack-component-${key}`}>
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span>
          {`${noun} `}
          <span className="mono wrap-anywhere">{name}</span>
        </span>
        <StatusChip machine="packInstall" status={component.status} size="s" />
      </div>
      {description ? <span className="text-small">{description}</span> : null}
      {component.kind === 'worker' && component.systems.length > 0 ? (
        <WorkerSystemsLine component={component} testId={`catalog-pack-component-${key}-gates`} />
      ) : null}
      {component.installedVersion !== null ? (
        <span className="text-3 text-small">
          {t(
            `内容与能力包 v${component.installedVersion} 一致`,
            `Matches pack v${component.installedVersion}`,
          )}
        </span>
      ) : component.status === 'customized' ? (
        <span className="text-3 text-small">
          {t(
            '内容和能力包的任何一个版本都对不上，可能是在能力包之外发布或改过的',
            'Its content matches no version of the pack; it was likely published or changed outside the pack',
          )}
        </span>
      ) : null}
      {provenance.status === 'recorded' ? (
        <span className="row-wrap text-small" data-testid={`catalog-pack-provenance-${key}`}>
          <span>
            {provenance.channel === 'platform'
              ? t('创建工作区时由平台安装', 'Installed by the platform with the workspace')
              : (provenance.appliedBy.displayName ?? shortId(provenance.appliedBy.id))}
            {' · '}
            <time
              className="text-3"
              dateTime={provenance.appliedAt}
              title={formatDateTime(provenance.appliedAt)}
              data-volatile=""
            >
              {formatRelative(provenance.appliedAt)}
            </time>
          </span>
          <RouteLink
            href={hrefs.catalog('changes', provenance.segmentId)}
            testId={`catalog-pack-provenance-link-${key}`}
          >
            {t('查看安装记录', 'Open install record')}
          </RouteLink>
        </span>
      ) : provenance.status === 'provenance_unknown' ? (
        <span className="text-3 text-small" data-testid={`catalog-pack-provenance-${key}`}>
          {t(
            '没有安装记录：启用安装记录之前装的，或不是从能力包装的；不能在「安装历史」里撤销',
            'No install record: installed before records were kept, or not from a pack; it cannot be rolled back under Install history',
          )}
        </span>
      ) : null}
      {page ? (
        <RouteLink href={page} testId={`catalog-pack-component-page-${key}`}>
          {component.kind === 'skill'
            ? t('在 Skill 页查看', 'Open on the Skills tab')
            : t('在 Worker 页查看', 'Open on the Workers tab')}
        </RouteLink>
      ) : null}
    </div>
  );
}

/** A pack Worker's systems and the gates it acts on here (P1-E2): the workspace's own, kept by
 *  every install; or, with none yet, whether installing (again) would connect it. */
function WorkerSystemsLine({
  component,
  testId,
}: {
  readonly component: Extract<PackComponentStateWire, { kind: 'worker' }>;
  readonly testId: string;
}) {
  const t = useT();
  const systems = component.systems.join(t('、', ', '));
  return (
    <span className="row-wrap text-3 text-small" data-testid={testId}>
      {component.gates.length > 0 ? (
        <>
          <span>{t('接入的系统：', 'Acts on: ')}</span>
          {component.gates.map((gate) => (
            <RouteLink
              key={gate.id}
              href={hrefs.gatekeeper(gate.id)}
              testId={`${testId}-${gate.id}`}
            >
              {gate.name}
            </RouteLink>
          ))}
        </>
      ) : component.status === 'not_installed' ? (
        <span>
          {t(
            `要用到 ${systems}：安装时会接上工作区里已经接好的。`,
            `Works with ${systems}: installing connects it to what the workspace has connected.`,
          )}
        </span>
      ) : component.bindable ? (
        <span>
          {t(
            `还没接上任何系统。工作区现在有接好的 ${systems}，再装一次就能接上。`,
            `Not connected to any system yet. The workspace now has ${systems} connected; installing again connects it.`,
          )}
        </span>
      ) : (
        <span>
          {t(
            `还没接上任何系统：工作区里还没有接好的 ${systems}。接好之后，回到这里再装一次就能接上。`,
            `Not connected to any system: the workspace has no ${systems} connected yet. Once it does, install again here to connect it.`,
          )}
        </span>
      )}
    </span>
  );
}

/** 「本体 ops-assets：第 1 版 → 新的一版」 — what one item does to its family. */
function itemHeadline(item: PackInstallItemWire, t: Translate): string {
  const subject = changeSubjectText(item, t);
  if (item.unchanged) {
    return t(
      `${subject}：已经是这一版的内容，不改动`,
      `${subject}: already this version, left as is`,
    );
  }
  const before =
    item.before === null
      ? t('未安装', 'not installed')
      : t(`第 ${item.before.version} 版`, `v${item.before.version}`);
  return t(`${subject}：${before} → 新的一版`, `${subject}: ${before} → a new version`);
}

/** The review's copy for a change between the review and the install: the review reloads itself,
 *  so the next step is to look again, not to refresh. */
const STALE_CODES = new Set(['version_changed', 'change_plan_changed']);

/** `workerGates`: by Worker name, the gates the person kept for a Worker the install connects. */
type WorkerGateChoice = Readonly<Record<string, readonly string[]>>;

function InstallPack({
  http,
  pack,
  onInstalled,
  onStale,
}: {
  readonly http: CapabilityCaller;
  readonly pack: PackWire;
  readonly onInstalled: (result: PackInstallResultWire) => void;
  /** The list is out of date (a newer version, or the workspace changed since it was read). */
  readonly onStale: () => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const permissions = usePermissions();
  const [open, setOpen] = useState(false);
  // Bumped to read the review again (a change since the person looked).
  const [round, setRound] = useState(0);
  const [preview, setPreview] = useState<
    | { readonly status: 'loading' }
    | {
        readonly status: 'ready';
        readonly data: PackInstallPreviewWire;
        /** The gate choice this review was read with — what the install passes back. */
        readonly choice: WorkerGateChoice;
      }
    | { readonly status: 'error'; readonly error: unknown }
  >({ status: 'loading' });
  // Reading the review again for a new gate choice: the last one stays on screen meanwhile.
  const [refreshing, setRefreshing] = useState(false);
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set());
  // P1-E2: by Worker name, the gates the person kept for a Worker the install connects; a Worker
  // not here keeps every gate offered (the default).
  const [choice, setChoice] = useState<WorkerGateChoice>({});
  const choiceKey = JSON.stringify(choice);
  // An owner-only read: run once the role is known to allow it, never on a guess.
  const canPreview = can('preview_pack_install') === true;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` and `choiceKey` only re-run the read.
  useEffect(() => {
    if (!open || !canPreview) return;
    let cancelled = false;
    const asked = choice;
    setRefreshing(true);
    setConfirmed(new Set());
    http
      .call<PackInstallPreviewWire>('preview_pack_install', {
        name: pack.name,
        ...(Object.keys(asked).length > 0 ? { workerGates: asked } : {}),
      })
      .then((data) => {
        if (!cancelled) setPreview({ status: 'ready', data, choice: asked });
      })
      .catch((error: unknown) => {
        if (isForbiddenError(error)) permissions.markDenied('preview_pack_install');
        if (!cancelled) setPreview({ status: 'error', error });
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, canPreview, http, pack.name, permissions, round, choiceKey]);

  const label = actionLabel(pack, t);
  if (label === null) return null;
  if (can('install_pack') === false) {
    return (
      <p className="text-3 text-small" data-testid="catalog-pack-owner-only">
        {t(
          '安装和升级能力包由工作区所有者操作。',
          'A workspace owner installs and upgrades packs.',
        )}
      </p>
    );
  }

  const data = preview.status === 'ready' ? preview.data : null;
  const widening = data
    ? data.items.filter((item) => !item.unchanged && item.classification === 'authority_widening')
    : [];
  const unconfirmed = widening.filter((item) => !confirmed.has(item.ordinal)).length;
  const crossed = data
    ? data.pack.versions.filter((version) => data.crossedVersions.includes(version.version))
    : [];

  async function install(): Promise<void> {
    if (data === null) return;
    let result: PackInstallResultWire;
    try {
      const reviewedChoice = preview.status === 'ready' ? preview.choice : {};
      result = await http.call<PackInstallResultWire>('install_pack', {
        name: pack.name,
        version: data.targetVersion,
        reviewedDigest: data.digest,
        ...(widening.length > 0 ? { confirmedOrdinals: widening.map((item) => item.ordinal) } : {}),
        ...(Object.keys(reviewedChoice).length > 0 ? { workerGates: reviewedChoice } : {}),
      });
    } catch (error) {
      if (isForbiddenError(error)) permissions.markDenied('install_pack');
      if (STALE_CODES.has(describeError(error).code)) {
        setRound((n) => n + 1);
        onStale();
      }
      throw error;
    }
    permissions.markAllowed('install_pack');
    // Legacy 425: a pack's Worker is what the readiness hint asks for when there is none.
    announceReadinessChange(http);
    onInstalled(result);
  }

  const inUse = data?.inUse;
  const inUseCount = (count: number) =>
    inUse?.capped && count >= CHANGE_ROLLBACK_IN_USE_CAP
      ? t(`至少 ${count}`, `at least ${count}`)
      : String(count);
  const staleText = t(
    '在你查看之后，这个能力包有了新版本，或工作区里的内容变了，所以什么也没有安装。上面已经换成现在的样子，请重新看一遍再确认。',
    'A newer version of this pack appeared, or what the workspace has changed, after you looked, so nothing was installed. The review above now shows how things are; look it over again before confirming.',
  );

  return (
    <div className="stack-s" data-testid="catalog-pack-install">
      <Confirm
        tier="medium"
        open={open}
        onOpenChange={setOpen}
        anchor={
          <Button
            variant="primary"
            onClick={() => {
              setChoice({});
              setOpen(true);
            }}
            data-testid="catalog-pack-install-trigger"
          >
            {`${label}…`}
          </Button>
        }
        title={label}
        target={`${pack.name} v${pack.latestVersion}`}
        confirmLabel={
          data?.pack.status === 'outdated'
            ? t('升级', 'Upgrade')
            : data?.pack.status === 'up_to_date'
              ? t('接上', 'Connect')
              : t('安装', 'Install')
        }
        danger={data !== null && (data.breaking || data.pack.status === 'customized')}
        confirmDisabled={data === null || data.unchanged || unconfirmed > 0 || refreshing}
        onConfirm={install}
        errorOverrides={{ version_changed: staleText, change_plan_changed: staleText }}
        testId="catalog-pack-install-confirm"
      >
        {preview.status === 'loading' ? (
          <SkeletonRows count={2} label={t('正在检查会改动什么…', 'Checking what it changes')} />
        ) : preview.status === 'error' ? (
          <ErrorBanner
            error={preview.error}
            title={t('无法检查会改动什么', 'Could not check what it changes')}
            overrides={{
              ontology_namespace_conflict: t(
                '这个能力包里有对象类型或动作类型的名字已经被工作区里另一个本体用了，装上会让两个本体重名，所以现在装不上，什么也没有改。「技术细节」里写着是哪个类型；占用它的本体是从能力包装上的话，可以在「安装历史」里撤销那条记录，否则请平台管理员处理。',
                'A type name in this pack is already used by another ontology in the workspace; installing it would give the name two owners, so it cannot be installed now and nothing changed. The technical details name the type. If the ontology holding it came from a pack, roll that record back under Install history; otherwise ask a platform administrator.',
              ),
              skill_name_conflict: t(
                '这个能力包里有一个 Skill 和工作区里另一个已发布的 Skill 同名；Worker 按名字挂载 Skill，同名会让它挂错，所以现在装不上，什么也没有改。「技术细节」里写着是哪个名字；可以在「Skill」页停用那个 Skill 后再来安装。',
                'A Skill in this pack has the same name as another published Skill in the workspace; a Worker mounts Skills by name, so two of one name would mix them up. It cannot be installed now and nothing changed. The technical details name it; deprecate that Skill on the Skills tab, then install again.',
              ),
            }}
            testId="catalog-pack-preview-error"
          />
        ) : (
          <div className="stack-s" data-testid="catalog-pack-preview">
            {preview.data.pack.status === 'customized' ? (
              <Notice tone="warn" testId="catalog-pack-preview-customized">
                {t(
                  `工作区里现在的内容和这个能力包的任何版本都对不上（已定制）。继续会把下面每一项换成 v${preview.data.targetVersion} 的标准内容，在能力包之外做的修改会被替换；原来的版本仍然保留，可以在「安装历史」里撤销这次安装。`,
                  `What the workspace has now matches no version of this pack (customized). Continuing replaces each part below with the standard content of v${preview.data.targetVersion}, so changes made outside the pack are replaced; the earlier versions are kept, and this install can be rolled back under Install history.`,
                )}
              </Notice>
            ) : null}
            {preview.data.breaking ? (
              <Notice tone="warn" testId="catalog-pack-preview-breaking">
                {t(
                  '这次会经过不兼容升级的版本：工作区里已有的对象或事实可能不再符合新的类型。它们会保留，不会被删除，但会被算作不符合本体。',
                  'This goes through a breaking version: objects or Facts the workspace already holds may no longer fit the new types. They stay, nothing is deleted, but they count as not fitting the ontology.',
                )}
              </Notice>
            ) : null}
            {crossed.length > 0 ? (
              <div className="stack-s" data-testid="catalog-pack-preview-versions">
                <span className="text-small">
                  {crossed.length > 1
                    ? t(
                        `这次会一次升到 v${preview.data.targetVersion}，经过这些版本：`,
                        `This goes straight to v${preview.data.targetVersion}, through these versions:`,
                      )
                    : t(
                        `这次会装上 v${preview.data.targetVersion}：`,
                        `This installs v${preview.data.targetVersion}:`,
                      )}
                </span>
                {crossed.map((version) => (
                  <span className="text-3 text-small" key={version.version}>
                    {`v${version.version}`}
                    {version.breaking ? t('（不兼容升级）', ' (breaking)') : ''}
                    {version.notes ? `：${version.notes}` : ''}
                  </span>
                ))}
              </div>
            ) : null}
            {preview.data.pack.requirements.length > 0 ? (
              <div className="stack-s" data-testid="catalog-pack-preview-requirements">
                <span className="text-small">
                  {t(
                    '它要用到这些系统。安装不会等它们接好；装完会马上核验一次，结果记在安装记录里。',
                    'It needs these systems. The install does not wait for them; it is verified right after, and the result is kept on the install record.',
                  )}
                </span>
                <PackRequirementList
                  http={http}
                  requirements={preview.data.pack.requirements}
                  testId="catalog-pack-preview-requirement"
                />
              </div>
            ) : null}
            {preview.data.items.map((item) => (
              <PreviewItem
                key={item.ordinal}
                item={item}
                kept={
                  item.kind === 'worker_definition_version'
                    ? (choice[item.target.name] ?? item.binding.candidates.map((gate) => gate.id))
                    : []
                }
                onKeptChange={(kept) =>
                  item.kind === 'worker_definition_version'
                    ? setChoice((prev) => ({ ...prev, [item.target.name]: kept }))
                    : undefined
                }
                checked={confirmed.has(item.ordinal)}
                onCheckedChange={(checked) =>
                  setConfirmed((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(item.ordinal);
                    else next.delete(item.ordinal);
                    return next;
                  })
                }
              />
            ))}
            {preview.data.inUse.objects + preview.data.inUse.links > 0 ? (
              <Notice testId="catalog-pack-in-use">
                {t(
                  `工作区里有 ${inUseCount(preview.data.inUse.objects)} 个对象、${inUseCount(preview.data.inUse.links)} 条有效关系用到装好后不再有的类型。它们会保留，不会被删除，但会被算作不符合本体；之后再写入用到这些类型的关系，会按工作区的本体检查设置被拒绝或记一条告警。`,
                  `${inUseCount(preview.data.inUse.objects)} objects and ${inUseCount(preview.data.inUse.links)} active links in this workspace use types the install takes out. They stay — nothing is deleted — but count as not fitting the ontology, and a new link written with those types is refused or flagged, as the workspace's ontology check is set.`,
                )}
              </Notice>
            ) : null}
            <StillNeeded
              items={
                unconfirmed > 0
                  ? [
                      t(
                        `勾选 ${unconfirmed} 项权限边界确认`,
                        `tick ${unconfirmed} authority-boundary confirmation${unconfirmed > 1 ? 's' : ''}`,
                      ),
                    ]
                  : []
              }
              reason={
                refreshing
                  ? t('正在按你的选择重新检查…', 'Checking again with your choice…')
                  : preview.data.unchanged
                    ? t(
                        '工作区里已经是这一版的内容，不需要安装',
                        'The workspace already has this version; there is nothing to install',
                      )
                    : null
              }
              testId="catalog-pack-missing"
            />
          </div>
        )}
      </Confirm>
    </div>
  );
}

function PreviewItem({
  item,
  kept,
  onKeptChange,
  checked,
  onCheckedChange,
}: {
  readonly item: PackInstallItemWire;
  /** A Worker item's gates the person keeps ticked (every one offered, by default). */
  readonly kept: readonly string[];
  readonly onKeptChange: (kept: readonly string[]) => void;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="stack-s" data-testid={`catalog-pack-item-${item.ordinal}`}>
      <span>{itemHeadline(item, t)}</span>
      {item.kind === 'worker_definition_version' ? (
        <WorkerBindingReview item={item} kept={kept} onKeptChange={onKeptChange} />
      ) : null}
      {item.unchanged ? null : (
        <>
          {item.kind === 'ontology_version' ? (
            <OntologyItemChanges item={item} />
          ) : (
            <ContentItemChanges item={item} />
          )}
          {item.classification === 'authority_widening' ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onCheckedChange(event.currentTarget.checked)}
                data-testid={`catalog-pack-confirm-item-${item.ordinal}`}
              />
              <span>
                {t('我确认这会改变权限边界：', 'I confirm this moves an authority boundary: ')}
                {item.widening.map((w) => wideningText(w, t)).join(t('；', '; '))}
              </span>
            </label>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * A Worker item's systems (P1-E2), as the install sets them. The gates it acts on and the model it
 * runs on are the workspace's own: an install keeps whatever the workspace set. A Worker with no
 * gates yet is connected to the workspace's connected gates of its systems, every one listed by
 * name and ticked by default; unticking one reads the review again (the install binds exactly what
 * was reviewed). Connecting it widens what it may act on, so the item asks for its confirmation.
 */
function WorkerBindingReview({
  item,
  kept,
  onKeptChange,
}: {
  readonly item: Extract<PackInstallItemWire, { kind: 'worker_definition_version' }>;
  readonly kept: readonly string[];
  readonly onKeptChange: (kept: readonly string[]) => void;
}) {
  const t = useT();
  const { binding } = item;
  const prefix = `catalog-pack-item-${item.ordinal}-binding`;
  if (binding.systems.length === 0 && binding.source !== 'workspace' && binding.model === null) {
    return null;
  }
  const systems = binding.systems.join(t('、', ', '));
  const keptSet = new Set(kept);
  return (
    <div className="stack-s" data-testid={prefix}>
      {binding.source === 'workspace' ? (
        <span className="text-3 text-small" data-testid={`${prefix}-kept`}>
          {binding.gates.length > 0
            ? t(
                `接入的系统：沿用工作区为它选的 ${binding.gates.map((gate) => gate.name).join('、')}`,
                `Systems: keeps the ones the workspace chose, ${binding.gates.map((gate) => gate.name).join(', ')}`,
              )
            : t(
                '接入的系统：沿用工作区的设置，不接入任何系统',
                'Systems: keeps the workspace’s setting, none',
              )}
        </span>
      ) : binding.candidates.length > 0 ? (
        <fieldset className="stack-s" data-testid={`${prefix}-choice`}>
          <legend className="text-small">
            {t(
              '安装时把它接上这些系统（默认全部接上，可以取消勾选）：',
              'Installing connects it to these systems (all of them by default; untick any):',
            )}
          </legend>
          {binding.candidates.map((gate) => (
            <label className="checkbox" key={gate.id}>
              <input
                type="checkbox"
                checked={keptSet.has(gate.id)}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  onKeptChange(
                    binding.candidates
                      .map((candidate) => candidate.id)
                      .filter((id) => (id === gate.id ? on : keptSet.has(id))),
                  );
                }}
                data-testid={`${prefix}-gate-${gate.id}`}
              />
              <span>
                {gate.name}
                <span className="text-3">{`（${gate.connector}）`}</span>
              </span>
            </label>
          ))}
          {kept.length === 0 ? (
            <span className="text-3 text-small" data-testid={`${prefix}-none-kept`}>
              {t(
                '一个都不接：装好后它不能对任何系统动手；之后可以在「Worker」页给它选。',
                'None: once installed it cannot act on any system; pick some later on the Workers tab.',
              )}
            </span>
          ) : null}
        </fieldset>
      ) : (
        <span className="text-3 text-small" data-testid={`${prefix}-unavailable`}>
          {t(
            `它要用到 ${systems}，工作区里还没有接好的，这次不接入任何系统。接好之后，回到能力包页再装一次就能接上。`,
            `It works with ${systems}, which the workspace has not connected yet, so it is connected to nothing for now. Once connected, install again from the pack’s page to connect it.`,
          )}
        </span>
      )}
      {binding.model !== null ? (
        <span className="text-3 text-small" data-testid={`${prefix}-model`}>
          {t(
            `模型：沿用工作区设置的 ${binding.model}`,
            `Model: keeps the workspace’s ${binding.model}`,
          )}
        </span>
      ) : null}
    </div>
  );
}

/** An ontology item: the type names it adds, changes and takes out. */
function OntologyItemChanges({
  item,
}: {
  readonly item: Extract<PackInstallItemWire, { kind: 'ontology_version' }>;
}) {
  const t = useT();
  const added = typeNamesText(item.types.added, t);
  const removed = typeNamesText(item.types.removed, t);
  const changed = typeNamesText(item.types.changed, t);
  return (
    <>
      {added ? (
        <span className="text-3 text-small">
          {t('新增：', 'Adds: ')}
          {added}
        </span>
      ) : null}
      {changed ? (
        <span className="text-3 text-small">
          {t('修改：', 'Changes: ')}
          {changed}
        </span>
      ) : null}
      {removed ? (
        <span className="text-3 text-small">
          {t('装好后不再有：', 'Afterwards no longer has: ')}
          {removed}
        </span>
      ) : null}
    </>
  );
}

/** A Skill or Worker item: what it installs (the text a Worker reads, what a Worker may do), and
 *  which fields differ from what the workspace has now. */
function ContentItemChanges({
  item,
}: {
  readonly item: Exclude<PackInstallItemWire, { kind: 'ontology_version' }>;
}) {
  const t = useT();
  const changed =
    item.before !== null && item.changedFields.length > 0
      ? item.changedFields.map((field) => contentFieldText(field, t)).join(t('、', ', '))
      : null;
  const prefix = `catalog-pack-item-${item.ordinal}`;
  return (
    <>
      {item.kind === 'skill_version' ? (
        <span className="text-3 text-small">{item.skill.description}</span>
      ) : item.worker.description ? (
        <span className="text-3 text-small">{item.worker.description}</span>
      ) : null}
      {changed ? (
        <span className="text-3 text-small" data-testid={`${prefix}-changed`}>
          {t('和工作区里现在的相比，改动了：', 'Differs from what the workspace has in: ')}
          {changed}
        </span>
      ) : null}
      {item.kind === 'worker_definition_version' ? (
        <>
          <span className="text-3 text-small" data-testid={`${prefix}-skills`}>
            {t('挂载的 Skill：', 'Mounted Skills: ')}
            {item.worker.skills.length > 0
              ? item.worker.skills.join(t('、', ', '))
              : t('无', 'none')}
          </span>
          <span className="text-3 text-small" data-testid={`${prefix}-capabilities`}>
            {t('能力范围：', 'Capabilities: ')}
            {item.worker.capabilities === null
              ? t(
                  '平台默认：查询台账、只读查看已接入的系统、提出建议；不能执行需要审批的操作',
                  'the platform default: read the records, read connected systems, propose; it cannot run anything that needs approval',
                )
              : item.worker.capabilities
                  .map((capability) => capabilityLabel(capability, t))
                  .join(t('、', ', '))}
          </span>
          {item.worker.egressDeny.length > 0 ? (
            <span className="text-3 text-small">
              {t('禁止访问的地址：', 'Denied hosts: ')}
              {item.worker.egressDeny.join(t('、', ', '))}
            </span>
          ) : null}
        </>
      ) : null}
      <details className="disclosure" data-testid={`${prefix}-content`}>
        <summary>
          {item.kind === 'skill_version'
            ? t('查看 Skill 正文', 'Show the Skill body')
            : t('查看系统提示词', 'Show the system prompt')}
        </summary>
        <div className="disclosure-body">
          {item.kind === 'skill_version' ? (
            <MarkdownPreview markdown={item.skill.markdown} />
          ) : (
            <pre className="code-block pre-wrap">{item.worker.systemPrompt}</pre>
          )}
        </div>
      </details>
    </>
  );
}
