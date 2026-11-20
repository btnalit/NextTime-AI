import { describe, expect, it } from 'vitest';
import { HANDLE_NOTE_MAX_LENGTH, getCapability, sessionShortId } from './index.js';

/**
 * Legacy 168: how a person tells two Handle sessions apart — the short id derived from the session
 * id, and the note the issuance takes.
 */
describe('sessionShortId (legacy 168)', () => {
  it('is the first 8 hex digits of the session id, lowercase', () => {
    expect(sessionShortId('0f3a9c21-7b4e-4d6a-9e10-5c2b8a7d6e4f')).toBe('0f3a9c21');
    expect(sessionShortId('0F3A9C21-7B4E-4D6A-9E10-5C2B8A7D6E4F')).toBe('0f3a9c21');
  });

  it('two ids that differ only after the eighth digit share it — it is not unique', () => {
    expect(sessionShortId('0f3a9c21-0000-4000-8000-000000000001')).toBe(
      sessionShortId('0f3a9c21-ffff-4fff-bfff-ffffffffffff'),
    );
  });
});

describe('issue_handle / issue_service_handle note (legacy 168)', () => {
  for (const name of ['issue_handle', 'issue_service_handle'] as const) {
    it(`${name} takes an optional note of at most ${HANDLE_NOTE_MAX_LENGTH} characters`, () => {
      const schema = getCapability(name)?.paramsSchema;
      if (!schema) throw new Error(`${name} is not registered`);
      const base =
        name === 'issue_handle'
          ? { sessionKind: 'interactive' }
          : { principalId: '0f3a9c21-7b4e-4d6a-9e10-5c2b8a7d6e4f', scope: ['search'] };
      expect(schema.safeParse(base).success).toBe(true);
      expect(schema.safeParse({ ...base, note: '备份采集器' }).success).toBe(true);
      expect(schema.safeParse({ ...base, note: 'x'.repeat(HANDLE_NOTE_MAX_LENGTH) }).success).toBe(
        true,
      );
      expect(
        schema.safeParse({ ...base, note: 'x'.repeat(HANDLE_NOTE_MAX_LENGTH + 1) }).success,
      ).toBe(false);
    });
  }
});
