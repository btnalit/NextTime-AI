import { describe, expect, it } from 'vitest';
import { adminAgentEnabled } from './identity.js';

/**
 * `ADMIN_AGENT_ENABLED` (S11 AA1, plan §5.7 "停止开关放在环境变量"): the kernel reads it once at
 * start (index.ts), so a value that is neither on nor off must stop it there rather than leave the
 * admin agent silently off — or on.
 */
describe('adminAgentEnabled', () => {
  it('is off when unset or empty', () => {
    expect(adminAgentEnabled(undefined)).toBe(false);
    expect(adminAgentEnabled('')).toBe(false);
    expect(adminAgentEnabled('   ')).toBe(false);
  });

  it('reads 1/true as on and 0/false as off, in any case and with surrounding blanks', () => {
    for (const raw of ['1', 'true', 'TRUE', ' True '])
      expect(adminAgentEnabled(raw), raw).toBe(true);
    for (const raw of ['0', 'false', 'FALSE', ' False ']) {
      expect(adminAgentEnabled(raw), raw).toBe(false);
    }
  });

  it('throws on anything else, naming the variable', () => {
    for (const raw of ['yes', 'on', 'off', '2', 'enabled', 'tru e']) {
      expect(() => adminAgentEnabled(raw), raw).toThrow(/ADMIN_AGENT_ENABLED/);
    }
  });
});
