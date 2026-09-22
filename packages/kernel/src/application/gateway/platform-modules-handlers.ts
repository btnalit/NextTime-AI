import type { ModuleVersionWire, ModuleWire, WorkspaceModuleWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type ModuleRegistryEntry,
  type WorkspaceModuleState,
  assertKnownModuleNames,
  countModuleInstallations,
  installOrUpgradeModule,
  loadModuleRegistry,
  loadWorkspaceModuleStates,
} from '../platform/modules.js';
import { toWirePlatformSettings, updatePlatformSettings } from '../platform/settings.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/platform-modules-handlers: the thin `CapabilityHandler` layer over
 * `application/platform/modules.ts` (P-B2b, docs/platform-admin-design.md §6.4;
 * docs/development-tasks.md §5d S7-D) — `list_modules` / `set_default_modules` (`scope:'platform'`,
 * same transaction shape as `platform-handlers.ts` / `platform-gates-handlers.ts`) and
 * `list_workspace_modules` / `install_module` / `upgrade_module` (`scope:'workspace'`, the owner's
 * 能力目录 模块 tab). Every handler here parses params, calls the domain module, and projects the
 * result to its wire shape — no query beyond what `modules.ts` itself does not already offer, same
 * division of labor `platform-gates-handlers.ts` already established against `application/gates/`.
 */

function toModuleVersionWire(version: {
  readonly version: number;
  readonly file: string;
  readonly notes: string;
  readonly breaking: boolean;
}): ModuleVersionWire {
  return {
    version: version.version,
    file: version.file,
    notes: version.notes,
    breaking: version.breaking,
  };
}

function toModuleWire(
  entry: ModuleRegistryEntry,
  counts: { readonly installedWorkspaceCount: number; readonly newerAvailableCount: number },
): ModuleWire {
  return {
    name: entry.name,
    versions: entry.versions.map(toModuleVersionWire),
    installedWorkspaceCount: counts.installedWorkspaceCount,
    newerAvailableCount: counts.newerAvailableCount,
  };
}

function toWorkspaceModuleWire(state: WorkspaceModuleState): WorkspaceModuleWire {
  const latest = state.entry.versions[state.entry.versions.length - 1];
  if (!latest) throw new Error(`module "${state.entry.name}" has an empty version list`);
  return {
    name: state.entry.name,
    versions: state.entry.versions.map(toModuleVersionWire),
    latestVersion: latest.version,
    installedVersion: state.installedVersion,
    status: state.status,
  };
}

// -------------------------------------------------------------------------------------------
// scope:'platform' — the 模块 page (list every module + install counts; set default modules)
// -------------------------------------------------------------------------------------------

async function loadAllWorkspaceIds(client: PoolClient): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    'select id from workspaces order by created_at',
  );
  return result.rows.map((row) => row.id);
}

export const listModulesHandler: CapabilityHandler = async (client) => {
  const registry = await loadModuleRegistry();
  const workspaceIds = await loadAllWorkspaceIds(client);
  const counts = await countModuleInstallations(client, workspaceIds, registry);
  const items = [...registry.values()].map((entry) =>
    toModuleWire(
      entry,
      counts.get(entry.name) ?? { installedWorkspaceCount: 0, newerAvailableCount: 0 },
    ),
  );
  return { result: { items } };
};

/** Same "who is the acting administrator" read `platform-handlers.ts`'s own (unexported)
 *  `actingUser` performs — duplicated locally rather than exported from that file, to keep this
 *  lane's edits to `platform-handlers.ts` limited to added registration lines (see this repo's own
 *  multi-lane dispatch conventions for `scope:'platform'` capability files). */
function actingPlatformUser(context: CapabilityHandlerContext | undefined): {
  readonly id: string;
  readonly login: string;
} {
  if (!context?.platformUser) {
    throw new Error('platform handler invoked outside a platform transaction');
  }
  return context.platformUser;
}

export const setDefaultModulesHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as { defaultModules: string[] };
  const registry = await loadModuleRegistry();
  assertKnownModuleNames(registry, input.defaultModules);
  const acting = actingPlatformUser(context);
  const row = await updatePlatformSettings(
    client,
    { defaultModules: input.defaultModules },
    acting.id,
  );
  return {
    result: toWirePlatformSettings(row),
    resourceType: 'platform_settings',
    resourceId: undefined,
  };
};

// -------------------------------------------------------------------------------------------
// scope:'workspace' — the owner's 能力目录 模块 tab
// -------------------------------------------------------------------------------------------

export const listWorkspaceModulesHandler: CapabilityHandler = async (client, workspaceId) => {
  const registry = await loadModuleRegistry();
  const states = await loadWorkspaceModuleStates(client, workspaceId, registry);
  return { result: { items: states.map(toWorkspaceModuleWire) } };
};

async function runInstallOrUpgrade(
  client: PoolClient,
  workspaceId: string,
  params: unknown,
  context: { readonly principalId: string } | undefined,
): Promise<{
  readonly result: WorkspaceModuleWire;
  readonly resourceType: string;
  readonly resourceId: string;
}> {
  const input = params as { name: string; confirm?: boolean };
  if (!context?.principalId) {
    throw new Error('install_module/upgrade_module: no calling principal in context');
  }
  const registry = await loadModuleRegistry();
  const state = await installOrUpgradeModule(
    client,
    workspaceId,
    context.principalId,
    registry,
    input,
  );
  return {
    result: toWorkspaceModuleWire(state),
    resourceType: 'module',
    resourceId: input.name,
  };
}

export const installModuleHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  context,
) => runInstallOrUpgrade(client, workspaceId, params, context);

export const upgradeModuleHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  context,
) => runInstallOrUpgrade(client, workspaceId, params, context);
