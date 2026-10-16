import { describe, expect, it } from 'vitest';
import {
  SHOWN_REASON_MAX,
  shownAuditReason,
  shownAuditReasonWithTruncation,
} from './shown-reason.js';

/** Synthetic: an alphabet-spelled key. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe('shownAuditReason (legacy 338)', () => {
  it('is null for no reason: not a string, empty or blank', () => {
    expect(shownAuditReason(undefined)).toBeNull();
    expect(shownAuditReason(null)).toBeNull();
    expect(shownAuditReason(42)).toBeNull();
    expect(shownAuditReason({ reason: 'x' })).toBeNull();
    expect(shownAuditReason('')).toBeNull();
    expect(shownAuditReason(' \n\t')).toBeNull();
  });

  it('redacts a reason written before the audit copy was redacted', () => {
    expect(shownAuditReason(`mysql: PGPASSWORD=${FAKE} rejected`)).toBe(
      'mysql: PGPASSWORD=[redacted] rejected',
    );
  });

  it('shows unseen characters as \\u{XXXX}, keeps line breaks and drops the CR of a CRLF', () => {
    expect(shownAuditReason('gate said no‮: on​ce\r\nthen\ttab\rcr')).toBe(
      'gate said no\\u{202E}: on\\u{200B}ce\nthen\\u{9}tab\\u{D}cr',
    );
  });

  it('redacts before clipping: a secret across the cut leaves none of its characters', () => {
    const lead = 'x'.repeat(SHOWN_REASON_MAX - 15);
    const shown = shownAuditReason(`${lead} PGPASSWORD=${FAKE}`) ?? '';
    expect(shown.startsWith(`${lead} PGPASSWORD=`)).toBe(true);
    expect(shown).not.toContain(FAKE.slice(0, 3));
    expect([...shown]).toHaveLength(SHOWN_REASON_MAX + 1);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('clips to SHOWN_REASON_MAX code points before escaping, so an escape is never cut', () => {
    const lead = 'x'.repeat(SHOWN_REASON_MAX - 1);
    expect(shownAuditReason(`${lead}‮tail`)).toBe(`${lead}\\u{202E}…`);
    // A surrogate pair at the cut stays whole.
    expect(shownAuditReason(`${lead}😀tail`)).toBe(`${lead}😀…`);
    // Short enough: unchanged, no ellipsis.
    expect(shownAuditReason(`${lead}y`)).toBe(`${lead}y`);
  });

  it('legacy 339: says it was clipped exactly when the shown text is clipped, measured after redacting', () => {
    const lead = 'x'.repeat(SHOWN_REASON_MAX - 1);
    expect(shownAuditReasonWithTruncation(undefined)).toBeNull();
    expect(shownAuditReasonWithTruncation(`${lead}y`)).toEqual({
      text: `${lead}y`,
      truncated: false,
    });
    const clipped = shownAuditReasonWithTruncation(`${lead}yz`);
    expect(clipped?.truncated).toBe(true);
    expect(clipped?.text).toBe(shownAuditReason(`${lead}yz`));
    // Longer than the cap as given, but not once the secret is masked: not clipped, and the text
    // carries no ellipsis either.
    const masked = shownAuditReasonWithTruncation(
      `${'x'.repeat(SHOWN_REASON_MAX - 30)} PGPASSWORD=${FAKE}${'k'.repeat(40)}`,
    );
    expect(masked?.truncated).toBe(false);
    expect(masked?.text.endsWith('PGPASSWORD=[redacted]')).toBe(true);
  });
});
