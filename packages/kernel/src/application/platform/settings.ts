import type { PlatformSettingsWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { envAdminLogins } from '../identity/users.js';

/**
 * application/platform/settings: the platform settings document (docs/platform-admin-design.md
 * §6.6; migration 0021 `platform_settings`). One JSONB row; compiled-in defaults are projected
 * for every key the row does not carry, so a fresh deployment reads sensible values before an
 * administrator has ever saved anything. Every write bumps `version` and copies the previous
 * document into `platform_settings_history` (rollback material — not exposed as a capability in
 * P-A1). `envAdmins` is not stored: it mirrors `NEXTTIME_PLATFORM_ADMINS` at read time.
 */

export interface PlatformSettings {
  readonly siteName: string;
  readonly announcement: string;
  readonly instanceInstructions: string;
  readonly defaultWorkspaceId: string | null;
  readonly defaultEntryModel: string | null;
  readonly defaultDailyCallLimit: number | null;
  readonly defaultMonthlyTokenBudget: number | null;
  readonly defaultPlatformRole: 'admin' | 'user';
  readonly passwordMinLength: number;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  siteName: 'NextTime AI',
  announcement: '',
  instanceInstructions: '',
  defaultWorkspaceId: null,
  defaultEntryModel: null,
  defaultDailyCallLimit: 100,
  defaultMonthlyTokenBudget: null,
  defaultPlatformRole: 'user',
  passwordMinLength: 8,
};

export interface PlatformSettingsRow {
  readonly settings: PlatformSettings;
  readonly version: number;
  readonly updatedAt: Date | null;
}

interface DbRow {
  settings: Record<string, unknown>;
  version: number;
  updated_at: Date | null;
}

// `envAdminLogins` lives in the identity module (users.ts) so `mapUser` can apply it; re-exported
// here for the settings wire (`envAdmins`).
export { envAdminLogins } from '../identity/users.js';

function project(raw: Record<string, unknown>): PlatformSettings {
  const pick = <K extends keyof PlatformSettings>(key: K): PlatformSettings[K] => {
    const value = raw[key];
    return (value === undefined ? DEFAULT_PLATFORM_SETTINGS[key] : value) as PlatformSettings[K];
  };
  return {
    siteName: pick('siteName'),
    announcement: pick('announcement'),
    instanceInstructions: pick('instanceInstructions'),
    defaultWorkspaceId: pick('defaultWorkspaceId'),
    defaultEntryModel: pick('defaultEntryModel'),
    defaultDailyCallLimit: pick('defaultDailyCallLimit'),
    defaultMonthlyTokenBudget: pick('defaultMonthlyTokenBudget'),
    defaultPlatformRole: pick('defaultPlatformRole'),
    passwordMinLength: pick('passwordMinLength'),
  };
}

/** Reads the settings row on any client that may see `platform_settings` (a platform
 *  transaction, or the identity module's admin client at startup). */
export async function readPlatformSettings(client: PoolClient): Promise<PlatformSettingsRow> {
  const result = await client.query<DbRow>(
    'select settings, version, updated_at from platform_settings where singleton',
  );
  const row = result.rows[0];
  if (!row) return { settings: DEFAULT_PLATFORM_SETTINGS, version: 0, updatedAt: null };
  return { settings: project(row.settings), version: row.version, updatedAt: row.updated_at };
}

/** Partial update: merges `patch` over the stored document, archives the previous version. */
export async function updatePlatformSettings(
  client: PoolClient,
  patch: Partial<PlatformSettings>,
  updatedBy: string | null,
): Promise<PlatformSettingsRow> {
  const current = await client.query<DbRow>(
    'select settings, version, updated_at from platform_settings where singleton for update',
  );
  const row = current.rows[0];
  if (!row) throw new Error('platform_settings row missing (migration 0021 not applied)');
  if (row.version > 0) {
    await client.query(
      `insert into platform_settings_history (version, settings, updated_at, updated_by)
       values ($1, $2::jsonb, coalesce($3, now()), $4)
       on conflict (version) do nothing`,
      [row.version, JSON.stringify(row.settings), row.updated_at, updatedBy],
    );
  }
  const merged: Record<string, unknown> = { ...row.settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  const updated = await client.query<DbRow>(
    `update platform_settings
        set settings = $1::jsonb, version = version + 1, updated_at = now(), updated_by = $2
      where singleton
      returning settings, version, updated_at`,
    [JSON.stringify(merged), updatedBy],
  );
  const next = updated.rows[0];
  if (!next) throw new Error('platform_settings update returned no row');
  return { settings: project(next.settings), version: next.version, updatedAt: next.updated_at };
}

export function toWirePlatformSettings(
  row: PlatformSettingsRow,
  env: NodeJS.ProcessEnv = process.env,
): PlatformSettingsWire {
  return {
    ...row.settings,
    envAdmins: [...envAdminLogins(env)],
    version: row.version,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}
