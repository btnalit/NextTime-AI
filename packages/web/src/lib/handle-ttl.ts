import type { Translate } from './i18n.js';

/**
 * Legacy 168 ②: how long a Handle lives is picked from presets, never typed — the shortest is the
 * default, so a credential outlives its purpose only by choice. A self-issued Handle offers
 * 1 / 7 / 30 days; a service Handle adds 90 / 365. Each list is cut to the kernel's own ceiling
 * (the capability schema's `ttlSeconds` max), so a preset the kernel would refuse is never shown.
 */
export const SECONDS_PER_DAY = 86400;
export const OWN_HANDLE_TTL_PRESET_DAYS: readonly number[] = [1, 7, 30];
export const SERVICE_HANDLE_TTL_PRESET_DAYS: readonly number[] = [1, 7, 30, 90, 365];

/** The presets that fit under `maxSeconds`; the ceiling itself (whole days, at least 1) when none
 *  does, so the list is never empty. */
export function ttlPresetDaysWithin(presets: readonly number[], maxSeconds: number): number[] {
  const maxDays = Math.max(1, Math.floor(maxSeconds / SECONDS_PER_DAY));
  const fitting = presets.filter((days) => days <= maxDays);
  return fitting.length > 0 ? fitting : [maxDays];
}

export function ttlDaysLabel(days: number, t: Translate): string {
  return days === 1 ? t('1 天', '1 day') : t(`${days} 天`, `${days} days`);
}
