import type { WorkspaceModuleWire } from '@nexttime/shared';
import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { Confirm } from '../kit/confirm.js';
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
  const [pending, setPending] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, unknown>>({});

  const rows = modules.state.status === 'ready' ? modules.state.data.items : [];
  const canWrite =
    !permissions.isDenied('install_module') && !permissions.isDenied('upgrade_module');

  function reload(): void {
    invalidateCapability(http, 'list_workspace_modules');
    void modules.reload();
  }

  async function run(name: string, confirm: boolean): Promise<void> {
    setPending(name);
    setRowError((prev) => ({ ...prev, [name]: undefined }));
    try {
      const capability =
        rows.find((m) => m.name === name)?.status === 'not_installed'
          ? 'install_module'
          : 'upgrade_module';
      await http.call(capability, confirm ? { name, confirm: true } : { name });
      permissions.markAllowed(capability);
      reload();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [name]: err }));
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
        <div className="table-scroll">
          <table className="data-table" data-testid="catalog-modules-table">
            <thead>
              <tr>
                <th>{t('名称', 'Name')}</th>
                <th>{t('状态', 'Status')}</th>
                <th>{t('已装版本', 'Installed')}</th>
                <th>{t('最新版本', 'Latest')}</th>
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
                    <td>{t(STATUS_LABEL[module.status].zh, STATUS_LABEL[module.status].en)}</td>
                    <td className="mono">
                      {module.installedVersion === null ? '—' : `v${module.installedVersion}`}
                    </td>
                    <td className="mono">v{module.latestVersion}</td>
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
      )}
    </div>
  );
}
