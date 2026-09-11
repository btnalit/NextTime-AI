import type { PoolLike } from '../../adapters/db/pool.js';
import { withAdminClient } from '../gateway/auth.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { readPlatformSettings, updatePlatformSettings } from './settings.js';

/**
 * application/platform/default-workspace: P-A1's "登录即对话" startup step (docs/platform-admin-
 * design.md §2 / §4). Right after `ensureInitialAdmin`:
 *
 *   * a fresh install (no workspace at all) gets one — named after the site, owned by the
 *     earliest active administrator (`admin`), seeded like any CLI-created workspace but with no
 *     API key — and it becomes `platform_settings.defaultWorkspaceId`, the workspace every
 *     page-created user joins;
 *   * an upgraded install (workspaces exist, no default recorded yet) adopts its only active
 *     workspace as the default; with several, the administrator picks one in platform settings.
 *
 * Idempotent, never fatal to the caller (index.ts logs and continues), superuser path like the
 * rest of bootstrap — nothing exists yet for RLS to scope against.
 */

export interface EnsureDefaultWorkspaceOptions {
  readonly log?: (line: string) => void;
  readonly ontologyDir?: string;
}

export type EnsureDefaultWorkspaceOutcome =
  | { readonly kind: 'created'; readonly workspaceId: string }
  | { readonly kind: 'adopted'; readonly workspaceId: string }
  | { readonly kind: 'unchanged'; readonly workspaceId: string | null };

export async function ensureDefaultWorkspace(
  pool: PoolLike,
  options: EnsureDefaultWorkspaceOptions = {},
): Promise<EnsureDefaultWorkspaceOutcome> {
  const log = options.log ?? (() => {});
  const state = await withAdminClient(pool, async (client) => {
    const settings = await readPlatformSettings(client);
    const workspaces = await client.query<{ id: string; status: string }>(
      'select id, status from workspaces order by created_at',
    );
    const admin = await client.query<{ id: string; display_name: string }>(
      `select id, display_name from users
        where platform_role = 'admin' and status = 'active'
        order by created_at limit 1`,
    );
    return { settings, workspaces: workspaces.rows, admin: admin.rows[0] };
  });

  if (state.workspaces.length === 0) {
    if (!state.admin) return { kind: 'unchanged', workspaceId: null };
    const created = await createWorkspaceWithOwner(pool, {
      name: state.settings.settings.siteName,
      owner: { userId: state.admin.id, displayName: state.admin.display_name },
      entryModel: state.settings.settings.defaultEntryModel ?? undefined,
      ...(options.ontologyDir ? { ontologyDir: options.ontologyDir } : {}),
    });
    await withAdminClient(pool, (client) =>
      updatePlatformSettings(client, { defaultWorkspaceId: created.workspaceId }, null),
    );
    log(
      JSON.stringify({
        level: 'info',
        msg: 'no workspace existed: the default workspace was created with the administrator as owner',
        workspaceId: created.workspaceId,
      }),
    );
    return { kind: 'created', workspaceId: created.workspaceId };
  }

  const current = state.settings.settings.defaultWorkspaceId;
  if (current && state.workspaces.some((w) => w.id === current)) {
    return { kind: 'unchanged', workspaceId: current };
  }
  const active = state.workspaces.filter((w) => w.status === 'active');
  if (active.length === 1 && active[0]) {
    const workspaceId = active[0].id;
    await withAdminClient(pool, (client) =>
      updatePlatformSettings(client, { defaultWorkspaceId: workspaceId }, null),
    );
    log(
      JSON.stringify({
        level: 'info',
        msg: 'adopted the only active workspace as the platform default workspace',
        workspaceId,
      }),
    );
    return { kind: 'adopted', workspaceId };
  }
  return { kind: 'unchanged', workspaceId: current ?? null };
}
