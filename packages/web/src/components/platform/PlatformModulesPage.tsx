import type { ModuleWire, PlatformSettingsWire } from '@nexttime/shared';
import { useState } from 'react';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { PlatformError } from './PlatformError.js';

export interface PlatformModulesPageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/platform/PlatformModulesPage: 模块 Modules (`/platform/modules`, docs/platform-
 * admin-design.md §6.4 "模块设计" — P-B2b). `list_modules`: every module this deployment ships
 * (`ontology/modules.yaml`), its full version list (notes / breaking), and how many workspaces
 * have it installed / are behind the latest version. `set_default_modules`: which of them
 * `create_workspace` installs (each at v1) into every new workspace — a per-row checkbox that
 * saves immediately (same "toggle → save now" shape `PlatformIntegrationsPage`'s connector-mode
 * `<Select>` already uses), never a form with its own submit button.
 *
 * Installing/upgrading a module *into* a workspace is not here — design §6.4 "平台页只展示与配置...
 * 跳到工作区能力目录": that action needs a Principal (P-B2 决定 ①, owner-only), which the platform
 * plane does not have. This page only counts and configures; `components/catalog/ModulesTab.tsx`
 * (the owner's 能力目录 模块 tab) is where a workspace actually installs one.
 */
export function PlatformModulesPage({ http }: PlatformModulesPageProps) {
  const modules = useCapabilityList<ModuleWire>(http, 'list_modules', {});
  const settings = useCapability<PlatformSettingsWire>(http, 'get_platform_settings');
  const [defaultModules, setDefaultModules] = useState<readonly string[] | null>(null);
  const [savingDefault, setSavingDefault] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState<unknown | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = modules.state.status === 'ready' ? modules.state.data.items : [];
  const effectiveDefaults =
    defaultModules ?? (settings.state.status === 'ready' ? settings.state.data.defaultModules : []);

  async function toggleDefault(name: string): Promise<void> {
    if (savingDefault) return;
    const next = effectiveDefaults.includes(name)
      ? effectiveDefaults.filter((m) => m !== name)
      : [...effectiveDefaults, name];
    setSavingDefault(name);
    setDefaultError(null);
    try {
      const updated = await http.call<PlatformSettingsWire>('set_default_modules', {
        defaultModules: next,
      });
      setDefaultModules(updated.defaultModules);
      settings.mutate(() => updated);
    } catch (err) {
      setDefaultError(err);
    } finally {
      setSavingDefault(null);
    }
  }

  return (
    <div className="page" data-testid="platform-modules-page">
      <PageHeader
        title="模块 Modules"
        description="随镜像发布的版本化领域包——本部署带哪些模块、装到了几个工作区、哪些工作区有新版可用，以及新建工作区默认安装哪些。 Versioned domain packs shipped with this deployment: what's available, how many workspaces have each installed, and which install by default into a new workspace."
        breadcrumb={[{ label: '平台 Platform' }, { label: '模块 Modules' }]}
      />

      <PlatformError
        error={defaultError}
        title="无法设置默认模块 Could not set the default modules"
        testId="modules-default-error"
      />

      {modules.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading modules" testId="modules-loading" />
      ) : modules.state.status === 'error' ? (
        <ErrorBanner
          error={modules.state.error}
          title="Could not load the module index"
          onRetry={() => void modules.reload()}
          testId="modules-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title="这个部署没有模块 No modules in this deployment"
          testId="modules-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="modules-table">
            <thead>
              <tr>
                <th>名称 Name</th>
                <th>最新版本 Latest</th>
                <th>已装到 Installed in</th>
                <th>有新版 Newer available</th>
                <th>默认安装 Default</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((module) => (
                <ModuleRow
                  key={module.name}
                  module={module}
                  isDefault={effectiveDefaults.includes(module.name)}
                  savingDefault={savingDefault !== null || settings.state.status !== 'ready'}
                  onToggleDefault={() => void toggleDefault(module.name)}
                  expanded={expanded === module.name}
                  onToggleExpanded={() =>
                    setExpanded((current) => (current === module.name ? null : module.name))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ModuleRow({
  module,
  isDefault,
  savingDefault,
  onToggleDefault,
  expanded,
  onToggleExpanded,
}: {
  readonly module: ModuleWire;
  readonly isDefault: boolean;
  readonly savingDefault: boolean;
  readonly onToggleDefault: () => void;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
}) {
  const latest = module.versions[module.versions.length - 1];
  return (
    <>
      <tr data-testid={`module-row-${module.name}`}>
        <td className="mono">{module.name}</td>
        <td>
          v{latest?.version ?? '—'}
          {latest?.breaking ? (
            <span className="text-3" data-testid={`module-breaking-${module.name}`}>
              {' '}
              · breaking
            </span>
          ) : null}
        </td>
        <td className="mono">{module.installedWorkspaceCount}</td>
        <td className="mono">{module.newerAvailableCount}</td>
        <td>
          <input
            type="checkbox"
            checked={isDefault}
            disabled={savingDefault}
            onChange={onToggleDefault}
            aria-label={`${module.name} 默认安装 install by default`}
            data-testid={`module-default-${module.name}`}
          />
        </td>
        <td>
          <Button
            variant="ghost"
            size="s"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            data-testid={`module-expand-${module.name}`}
          >
            {expanded ? '收起 Collapse' : '版本 Versions'}
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={6}>
            <div className="stack-s" data-testid={`module-versions-${module.name}`}>
              {module.versions.map((version) => (
                <div key={version.version} className="row" style={{ gap: '0.5rem' }}>
                  <span className="mono">v{version.version}</span>
                  {version.breaking ? <span className="text-3">breaking</span> : null}
                  <span className="text-2">{version.notes || '—'}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
