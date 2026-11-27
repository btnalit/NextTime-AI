import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REDACTED, scrubSecretValues } from './secret-values-v0.70.0.js';

/** `git show v0.70.0:packages/kernel/src/substrate/redaction/secret-values.ts | sha256sum`. */
const V0_70_0_SHA256 = 'f30aaf2326b368aa6bcf1bbd45f968799487ab29037170a4c5f1b22c4bf73f8f';
const BANNER_END = '// ---- v0.70.0 ----\n';
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
const R = REDACTED;

describe('secret-values-v0.70.0 — the floor, frozen (legacy 939)', () => {
  it('is secret-values.ts as v0.70.0 released it, byte for byte, below its banner', () => {
    const text = readFileSync(new URL('./secret-values-v0.70.0.ts', import.meta.url), 'utf8');
    const at = text.indexOf(BANNER_END);
    expect(at).toBeGreaterThan(0);
    const released = text.slice(at + BANNER_END.length);
    expect(createHash('sha256').update(released).digest('hex')).toBe(V0_70_0_SHA256);
  });

  // It reads the name rules of `@nexttime/shared` as they are now, not as a copy: these are what
  // v0.70.0 wrote, so a change there that hides less under the floor fails here. JSON keys only
  // that rule names, and three texts v0.70.0 hid more of than the rules after it.
  it.each([
    [`{"clientSecret": "${FAKE}"}`, `{"clientSecret": "${R}"}`, 1],
    [`{"refreshToken":"${FAKE}","maxTokens":"7"}`, `{"refreshToken":"${R}","maxTokens":"7"}`, 1],
    [`{\\"privateKey\\": \\"${FAKE}\\"}`, `{\\"privateKey\\": \\"${R}\\"}`, 1],
    [`token:token:"password:k"\t:"a''${FAKE}"`, `token:${R}"password:${R}"\t:"${R}"`, 3],
    [
      String.raw`.--token=\" : .'token' = '\\"x${FAKE}"}password=',${FAKE}"|`,
      String.raw`.--token=\"${R}"|`,
      2,
    ],
    ['token=x,password: "note": ', `token=${R} "note": `, 1],
  ])('still reads %j as v0.70.0 did', (text, value, redactedValues) => {
    expect(scrubSecretValues(text)).toEqual({ value, redactedValues });
  });
});
