import { describe, expect, it } from 'vitest';
import { suggestLoginFromDisplayName } from './login-input.js';

describe('suggestLoginFromDisplayName (audit P1-12)', () => {
  it('turns a Latin display name into a valid login', () => {
    expect(suggestLoginFromDisplayName('Ada Lovelace')).toBe('ada.lovelace');
    expect(suggestLoginFromDisplayName('  José  Núñez ')).toBe('jose.nunez');
    expect(suggestLoginFromDisplayName('ops-bot_2')).toBe('ops-bot_2');
  });

  it('suggests nothing when the name has too little Latin text for a valid login', () => {
    expect(suggestLoginFromDisplayName('张三')).toBe('');
    expect(suggestLoginFromDisplayName('Al')).toBe('');
    expect(suggestLoginFromDisplayName('')).toBe('');
  });

  it('keeps the result within 64 characters', () => {
    expect(suggestLoginFromDisplayName('a'.repeat(80)).length).toBe(64);
  });
});
