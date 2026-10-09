import { describe, expect, it } from 'vitest';
import { ownEntry } from './own.js';

describe('ownEntry', () => {
  const table: Readonly<Record<string, string>> = { forbidden: 'Not permitted' };

  it('returns a key the table defines', () => {
    expect(ownEntry(table, 'forbidden')).toBe('Not permitted');
  });

  it('never returns Object.prototype members for inherited names', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope']) {
      expect(ownEntry(table, key)).toBeUndefined();
    }
  });
});
