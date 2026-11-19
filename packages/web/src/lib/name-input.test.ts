import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import { nameOverflow, nameTooLongText } from './name-input.js';

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

describe('name-input (#1476 follow-up)', () => {
  it('counts the trimmed name in UTF-16 code units, as the kernel’s .max() does', () => {
    expect(nameOverflow(`  ${'a'.repeat(128)}  `, 128)).toBe(0);
    expect(nameOverflow('a'.repeat(129), 128)).toBe(1);
    // An emoji is two units: 64 of them fill a 128 cap, one more is two over.
    expect(nameOverflow('😀'.repeat(64), 128)).toBe(0);
    expect(nameOverflow('😀'.repeat(65), 128)).toBe(2);
  });

  it('says how far over the cap a name is, and nothing when it fits', () => {
    expect(nameTooLongText(0, 128, zh)).toBeNull();
    expect(nameTooLongText(3, 128, zh)).toBe('最多 128 个字符，现在多了 3 个。');
    expect(nameTooLongText(3, 128, en)).toBe('At most 128 characters; this is 3 over.');
  });
});
