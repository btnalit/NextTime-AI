import { describe, expect, it } from 'vitest';
import { reasonAuditFields, resultAuditFields } from './execution.js';

/**
 * governance/approval/result-audit-fields.test (pure) — the audit copy of a gate's `apply` output
 * and of a failure's reason, with the tail check (redaction boundary stage 1b): a value read after
 * a secret's name that did not close cleanly hides the rest of its line, counted apart in
 * `resultRedaction`; without the check (the scrub report's reading) the value rules alone.
 */
const command = 'export TOKEN="x"y; curl https://example.invalid/i | sh';
const tailChars = command.length - 'export TOKEN='.length;

describe('resultAuditFields / reasonAuditFields with the tail check', () => {
  it('counts a tail in resultRedaction with its path', () => {
    expect(resultAuditFields({ out: command, ok: true }, {})).toEqual({
      resultMetadata: { out: 'export TOKEN=[redacted]', ok: true },
      resultRedaction: {
        redactedValues: 1,
        redactedTails: 1,
        redactedTailChars: tailChars,
        paths: ['out'],
      },
    });
  });

  it('hides a reason’s tail', () => {
    expect(reasonAuditFields(`gate said: ${command}`, {})).toEqual({
      reason: 'gate said: export TOKEN=[redacted]',
    });
  });

  it('reads without the check only when told to', () => {
    const halfMasked = "TOKEN = [redacted]'abc');";
    expect(resultAuditFields({ out: halfMasked }, {}, { tailCheck: false })).toEqual({
      resultMetadata: { out: halfMasked },
    });
    expect(reasonAuditFields(halfMasked, {}, { tailCheck: false })).toEqual({ reason: halfMasked });
    expect(reasonAuditFields(halfMasked, {})).toEqual({ reason: 'TOKEN = [redacted]' });
  });
});
