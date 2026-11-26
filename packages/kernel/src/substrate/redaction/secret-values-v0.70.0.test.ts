import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** `git show v0.70.0:packages/kernel/src/substrate/redaction/secret-values.ts | sha256sum`. */
const V0_70_0_SHA256 = 'f30aaf2326b368aa6bcf1bbd45f968799487ab29037170a4c5f1b22c4bf73f8f';
const BANNER_END = '// ---- v0.70.0 ----\n';

describe('secret-values-v0.70.0 — the floor, frozen (legacy 939)', () => {
  it('is secret-values.ts as v0.70.0 released it, byte for byte, below its banner', () => {
    const text = readFileSync(new URL('./secret-values-v0.70.0.ts', import.meta.url), 'utf8');
    const at = text.indexOf(BANNER_END);
    expect(at).toBeGreaterThan(0);
    const released = text.slice(at + BANNER_END.length);
    expect(createHash('sha256').update(released).digest('hex')).toBe(V0_70_0_SHA256);
  });
});
