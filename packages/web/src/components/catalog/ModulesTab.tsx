import type { WorkspaceModuleWire } from '@nexttime/shared';
import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isVersionChangedError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Confirm } from '../kit/confirm.js';
import { RouteLink } from '../kit/route-link.js';
import { DashboardCard } from '../kit/section.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { SkeletonRows } from '../ui/Skeleton.js';

export interface ModulesTabProps {
  readonly http: CapabilityCaller;
}

const STATUS_LABEL: Readonly<
  Record<WorkspaceModuleWire['status'], { readonly zh: string; readonly en: string }>
> = {
  not_installed: { zh: '未安装', en: 'Not installed' },
  up_to_date: { zh: '已是最新', en: 'Up to date' },
  outdated: { zh: '有新版', en: 'Outdated' },
  customized: { zh: '已定制', en: 'Customized' },
};

/** `install_module`/`upgrade_module` always target the module's own **latest** indexed version
 *  directly (one publish, never stepping through intermediate versions — `installOrUpgradeModule`'s
 *  own doc comment) — this is that same version, found client-side so the confirm dialog can be
 *  shown *before* the call rather than only after a 400 `module_confirm_required` comes back. */
function targetVersionOf(module: WorkspaceModuleWire) {
  return module.versions.find((v) => v.version === module.latestVersion);
}

/** Whether any indexed version strictly after the currently installed one (or from the very start,
 *  `installedVersion ?? 0`, when `customized` — nothing reliable is known about what it currently
 *  contains), up to and including the latest, is `breaking`. */
function breakingRangeCrossed(module: WorkspaceModuleWire): boolean {
  const from = module.installedVersion ?? 0;
  return module.versions.some(
    (v) => v.version > from && v.version <= module.latestVersion && v.breaking,
  );
}

/** Mirrors `installOrUpgradeModule`'s own confirm rule client-side (D3): `customized` always needs
 *  confirm; otherwise confirm is needed when `breakingRangeCrossed` — jumping straight to the
 *  latest must not silently skip past an intermediate breaking version. `not_installed` and
 *  `up_to_date` never need confirm (nothing to overwrite, or nothing to do). */
function needsConfirm(module: WorkspaceModuleWire): boolean {
  if (module.status === 'customized') return true;
  if (module.status !== 'outdated') return false;
  return breakingRangeCrossed(module);
}

/** S11 P1-B: the 安装记录 column — which install record put the installed version there, linked
 *  to it in 安装历史 (`ChangesTab`). No record: installed before records were kept, or published
 *  some other way (`publish_ontology_version`); it cannot be rolled back from here. */
function ProvenanceCell({
  module,
  t,
}: {
  readonly module: WorkspaceModuleWire;
  readonly t: Translate;
}) {
  const provenance = module.provenance;
  if (provenance.status === 'not_installed') return <span className="text-3">—</span>;
  if (provenance.status === 'provenance_unknown') {
    return (
      <span className="stack-s" data-testid={`catalog-module-provenance-${module.name}`}>
        <span className="text-3">{t('没有安装记录', 'No install record')}</span>
        <span className="text-3 text-small">
          {t(
            '启用安装记录之前装的，或不是从这里装的；不能在这里撤销',
            'Installed before records were kept, or not from here; it cannot be rolled back here',
          )}
        </span>
      </span>
    );
  }
  const who =
    provenance.channel === 'platform'
      ? t('创建工作区时由平台安装', 'Installed by the platform with the workspace')
      : (provenance.appliedBy.displayName ?? shortId(provenance.appliedBy.id));
  return (
    <span className="stack-s" data-testid={`catalog-module-provenance-${module.name}`}>
      <span className="text-small">
        {who}
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
        testId={`catalog-module-provenance-link-${module.name}`}
      >
        {t('查看安装记录', 'Open install record')}
      </RouteLink>
    </span>
  );
}

/**
 * components/catalog/ModulesTab: the owner's 能力目录 模块 tab (`/govern/catalog/modules`, P-B2b —
 * docs/platform-admin-design.md §6.4 "owner 也能在自己工作区的「能力目录」里做同样的事
 * (`scope:'workspace'`)"). `list_workspace_modules` (any member); `install_module`/`upgrade_module`
 * (owner — `minRole: 'owner'` on the capability itself, `usePermissions` hides the buttons after a
 * 403 the same way every other owner-only affordance in this console already does).
 *
 * Confirmation: `needsConfirm` mirrors the kernel's own confirm rule (D3) from data this tab
 * already has, so a `customized` row or a range containing a `breaking` version opens `kit/confirm`
 * (medium, anchored to the row's own button — S8 W1-A7 — reversible: an old OntologyVersion row is
 * never deleted, §8 生效表 "运行中 Worker 用旧版直到结束") *before* the call, not only after the
 * kernel's own 400 `module_confirm_required` —
 * that 400 is still the authoritative backstop this component falls back to (rendered inline via
 * `rowError`, same as any other failed row action) if the two ever disagree (a version published
 * between page load and click).
 */
export function ModulesTab({ http }: ModulesTabProps) {
  const t = useT();
  const modules = useCapabilityList<WorkspaceModuleWire>(http, 'list_workspace_modules', {});
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, unknown>>({});

  const rows = modules.state.status === 'ready' ? modules.state.data.items : [];
  const canWrite = can('install_module') !== false && can('upgrade_module') !== false;

  function reload(): void {
    invalidateCapability(http, 'list_workspace_modules');
    void modules.reload();
  }

  async function run(name: string, confirm: boolean): Promise<void> {
    setPending(name);
    setRowError((prev) => ({ ...prev, [name]: undefined }));
    try {
      const shown = rows.find((m) => m.name === name);
      if (!shown) throw new Error(`module ${name} is not in the list shown`);
      const capability = shown.status === 'not_installed' ? 'install_module' : 'upgrade_module';
      // Legacy 300: the version this row offered — the kernel refuses 409 `version_changed` when
      // the latest indexed version is another one by now, and nothing is installed.
      await http.call(capability, {
        name,
        version: shown.latestVersion,
        ...(confirm ? { confirm: true } : {}),
      });
      permissions.markAllowed(capability);
      reload();
    } catch (err) {
      // I-P1 `ontology_namespace_conflict` (and any other mapped code) reads as its own sentence
      // (`ErrorBanner` → `lib/errors.ts` `presentError`), the kernel's text under 「技术细节」.
      setRowError((prev) => ({ ...prev, [name]: err }));
      // The inline error says it was reloaded: show the version offered now.
      if (isVersionChangedError(err)) reload();
      throw err;
    } finally {
      setPending(null);
    }
  }

  function onAction(module: WorkspaceModuleWire): void {
    if (needsConfirm(module)) {
      setConfirmFor(module.name);
      return;
    }
    // `run` already records the failure in `rowError` (rendered inline below the button) — the
    // re-thrown rejection here is only for `Confirm`'s own `onConfirm` caller; swallow it so a
    // direct (non-confirm) call never surfaces as an unhandled promise rejection.
    run(module.name, false).catch(() => {});
  }

  return (
    <div className="stack" data-testid="catalog-modules">
      {modules.state.status === 'loading' ? (
        <SkeletonRows
          count={3}
          label={t('正在加载模块…', 'Loading modules')}
          testId="catalog-modules-loading"
        />
      ) : modules.state.status === 'error' ? (
        <ErrorBanner
          error={modules.state.error}
          title={t('无法加载模块', 'Could not load modules')}
          onRetry={() => void modules.reload()}
          testId="catalog-modules-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title={t('没有可用模块', 'No modules available')}
          testId="catalog-modules-empty"
        />
      ) : (
        // S8 W4 (audit CM1 "裸表格没有卡片容器，与其他列表不一致"): same `DashboardCard`
        // (`kit/section.tsx`) every other table on this style of page already sits inside
        // (`ModelsPage`'s own `<DashboardCard><table className="data-table">`) — one bordered
        // list-container convention, not a bare table only here.
        <DashboardCard padded={false}>
          <div className="table-scroll">
            <table className="data-table data-table-cards" data-testid="catalog-modules-table">
              <thead>
                <tr>
                  <th>{t('名称', 'Name')}</th>
                  <th>{t('状态', 'Status')}</th>
                  <th>{t('已装版本', 'Installed')}</th>
                  <th>{t('最新版本', 'Latest')}</th>
                  <th>{t('安装记录', 'Install record')}</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((module) => {
                  const target = targetVersionOf(module);
                  const label =
                    module.status === 'not_installed'
                      ? t('安装', 'Install')
                      : module.status === 'up_to_date'
                        ? null
                        : target
                          ? t(`升级到 v${target.version}`, `Upgrade to v${target.version}`)
                          : null;
                  return (
                    <tr key={module.name} data-testid={`catalog-module-row-${module.name}`}>
                      <td className="mono">{module.name}</td>
                      <td data-label={t('状态', 'Status')}>
                        {t(STATUS_LABEL[module.status].zh, STATUS_LABEL[module.status].en)}
                      </td>
                      <td className="mono" data-label={t('已装版本', 'Installed')}>
                        {module.installedVersion === null ? '—' : `v${module.installedVersion}`}
                      </td>
                      <td className="mono" data-label={t('最新版本', 'Latest')}>
                        v{module.latestVersion}
                      </td>
                      <td data-label={t('安装记录', 'Install record')}>
                        <ProvenanceCell module={module} t={t} />
                      </td>
                      <td>
                        {canWrite && label ? (
                          <Confirm
                            tier="medium"
                            open={confirmFor === module.name}
                            onOpenChange={(open) => setConfirmFor(open ? module.name : null)}
                            anchor={
                              <Button
                                variant="secondary"
                                size="s"
                                disabled={pending === module.name}
                                onClick={() => onAction(module)}
                                data-testid={`catalog-module-action-${module.name}`}
                              >
                                {label}
                              </Button>
                            }
                            title={t(
                              `确认安装/升级 ${module.name}`,
                              `Confirm install/upgrade ${module.name}`,
                            )}
                            description={
                              module.status === 'customized'
                                ? t(
                                    '这个工作区的当前定义不匹配任何已知版本（已定制）；继续会替换成模块的标准内容。',
                                    'The current definition does not match any known version (customized) — continuing replaces it with the module’s standard content.',
                                  )
                                : t(
                                    '升级会直接跳到最新版本，中间跨过至少一个不兼容变更（breaking）。',
                                    'Upgrading jumps straight to the latest version, crossing at least one breaking change along the way.',
                                  )
                            }
                            target={
                              target
                                ? `v${target.version}${target.notes ? ` — ${target.notes}` : ''}`
                                : undefined
                            }
                            confirmLabel={t('确认', 'Confirm')}
                            danger={breakingRangeCrossed(module)}
                            onConfirm={() => run(module.name, true)}
                            testId={`catalog-module-confirm-${module.name}`}
                          />
                        ) : null}
                        {rowError[module.name] ? (
                          <ErrorBanner
                            error={rowError[module.name]}
                            title={t('操作失败', 'Action failed')}
                            overrides={{
                              // Legacy 406: install / upgrade take no per-item confirmation, so
                              // this page cannot offer one — say so and who to tell.
                              change_confirmation_required: t(
                                '这个模块的这一版会改变权限边界（新增、去掉或放宽动作类型），这类改动要逐项确认，模块页做不到，所以没有安装，也没有写入任何内容。请把这个情况告诉平台管理员。',
                                'This version of the module moves an authority boundary (an action type added, taken out or loosened). Such changes need confirming item by item, which this page cannot do, so nothing was installed or written. Let a platform administrator know.',
                              ),
                            }}
                            testId={`catalog-module-error-${module.name}`}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DashboardCard>
      )}
    </div>
  );
}
