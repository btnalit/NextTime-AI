import { describe, expect, it } from 'vitest';
import { shownAuditPayload, shownFreeText, shownFreeTextIn } from './shown-text.js';

// Synthetic, Handle-shaped: never a real credential.
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe('shownFreeText (legacy 420)', () => {
  it('replaces each secret-looking value and keeps the rest of the sentence', () => {
    expect(shownFreeText(`rejected: the script sets PGPASSWORD=${FAKE} inline`)).toBe(
      'rejected: the script sets PGPASSWORD=[redacted] inline',
    );
    expect(shownFreeText(`see https://ops:${FAKE}@db.example/x`)).not.toContain(FAKE);
  });

  it('leaves prose that only talks about credentials as it is', () => {
    const prose = 'the token expired, rotate it before retrying';
    expect(shownFreeText(prose)).toBe(prose);
  });

  it('shows unseen characters as escapes after redacting, keeping line breaks and tabs', () => {
    expect(shownFreeText('ok‮evil\nnext\tline')).toBe('ok\\u{202E}evil\nnext\tline');
  });

  it('reads null as null', () => {
    expect(shownFreeText(null)).toBeNull();
  });
});

describe('shownFreeTextIn (legacy 420)', () => {
  it('masks the strings of a kernel-shaped record and keeps its own count fields', () => {
    const rationale = {
      actionRequestId: '00000000-0000-4000-8000-000000000001',
      reason: `approved, the key is TOKEN=${FAKE}`,
      credentialReview: { suspectedSecretValues: 2, confirmed: true },
      relatedFactIds: ['00000000-0000-4000-8000-000000000002'],
      round: 3,
      note: null,
    };
    expect(shownFreeTextIn(rationale)).toEqual({
      ...rationale,
      reason: 'approved, the key is TOKEN=[redacted]',
    });
  });

  it('with secretFields replaces every value under a secret-named field', () => {
    expect(
      shownFreeTextIn(
        { db: { password: 'hunter2-plain-word' }, user: 'ops' },
        { secretFields: true },
      ),
    ).toEqual({
      db: { password: '[redacted]' },
      user: 'ops',
    });
  });

  it('keeps a "__proto__" key as a field', () => {
    const shown = shownFreeTextIn(JSON.parse('{"__proto__": {"x": "y"}}')) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(shown)).toBe(Object.prototype);
    expect(Object.keys(shown)).toEqual(['__proto__']);
  });
});

describe('shownAuditPayload (legacy 420)', () => {
  it('masks params by field name and the rest by value, keeping the kernel’s own fields', () => {
    const payload = {
      params: { name: 'x', apiKey: 'plain-looking-value' },
      redactedValues: 1,
      credentialReview: { suspectedSecretValues: 1, confirmed: true },
      before: 'old text',
      after: `call it with Authorization: Bearer ${FAKE}`,
    };
    const shown = shownAuditPayload(payload);
    expect(shown.params).toEqual({ name: 'x', apiKey: '[redacted]' });
    expect(shown.redactedValues).toBe(1);
    expect(shown.credentialReview).toEqual({ suspectedSecretValues: 1, confirmed: true });
    expect(shown.before).toBe('old text');
    expect(shown.after).not.toContain(FAKE);
    expect(Object.keys(shown)).toEqual(Object.keys(payload));
  });
});
