import { describe, expect, it } from 'vitest';
import {
  OWN_HANDLE_TTL_PRESET_DAYS,
  SERVICE_HANDLE_TTL_PRESET_DAYS,
  ttlDaysLabel,
  ttlPresetDaysWithin,
} from './handle-ttl.js';
import type { Translate } from './i18n.js';

const t: Translate = (zh) => zh;

describe('handle TTL presets (legacy 168 ②)', () => {
  it('keeps only the presets under the kernel ceiling, shortest first', () => {
    expect(ttlPresetDaysWithin(OWN_HANDLE_TTL_PRESET_DAYS, 30 * 86400)).toEqual([1, 7, 30]);
    expect(ttlPresetDaysWithin(SERVICE_HANDLE_TTL_PRESET_DAYS, 365 * 86400)).toEqual([
      1, 7, 30, 90, 365,
    ]);
    expect(ttlPresetDaysWithin(SERVICE_HANDLE_TTL_PRESET_DAYS, 60 * 86400)).toEqual([1, 7, 30]);
  });

  it('falls back to the ceiling itself when no preset fits', () => {
    expect(ttlPresetDaysWithin([7, 30], 3 * 86400)).toEqual([3]);
    expect(ttlPresetDaysWithin([7], 3600)).toEqual([1]);
  });

  it('labels days', () => {
    expect(ttlDaysLabel(1, t)).toBe('1 天');
    expect(ttlDaysLabel(30, t)).toBe('30 天');
  });
});
