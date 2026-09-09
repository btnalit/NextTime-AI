import { describe, expect, it } from 'vitest';
import {
  SecretRedactionError,
  redactCommandLine,
  sanitizeCommandLine,
  sanitizeCommandLines,
} from './redact.js';

describe('redactCommandLine', () => {
  it('redacts --token=VALUE', () => {
    expect(redactCommandLine('myapp --token=abc123')).toBe('myapp --token=***');
  });

  it('redacts password=VALUE even when the key name has a non-dash prefix (--db-password=X)', () => {
    // The key-name match itself is "password" (matched wherever it occurs, not anchored to the
    // start of the flag) — only the "password=X" tail is replaced, the "--db-" prefix survives.
    expect(redactCommandLine('myapp --db-password=hunter2')).toBe('myapp --db-password=***');
  });

  it('redacts a bare password=VALUE key exactly', () => {
    expect(redactCommandLine('myapp password=hunter2')).toBe('myapp password=***');
  });

  it('redacts key=VALUE', () => {
    expect(redactCommandLine('myapp --key=deadbeef')).toBe('myapp --key=***');
  });

  it('redacts a quoted value', () => {
    expect(redactCommandLine('myapp --token="abc def"')).toBe('myapp --token=***');
  });

  it('redacts a space-delimited value (--token abc123)', () => {
    expect(redactCommandLine('myapp --token abc123')).toBe('myapp --token ***');
  });

  it('redacts a colon-delimited value (token: abc123)', () => {
    expect(redactCommandLine('config token: abc123 end')).toBe('config token: *** end');
  });

  it('redacts a bearer string', () => {
    expect(redactCommandLine('curl -H "Authorization: Bearer abc.def.ghi"')).toBe(
      'curl -H "Authorization: Bearer ***"',
    );
  });

  it('redacts multiple secrets in one command line', () => {
    const input = 'myapp --token=abc --password=xyz --other=fine';
    expect(redactCommandLine(input)).toBe('myapp --token=*** --password=*** --other=fine');
  });

  it('is case-insensitive on the key name', () => {
    expect(redactCommandLine('myapp --TOKEN=abc123')).toBe('myapp --TOKEN=***');
  });

  it('leaves unrelated flags untouched', () => {
    expect(redactCommandLine('myapp --verbose --port=8080')).toBe('myapp --verbose --port=8080');
  });
});

describe('sanitizeCommandLine', () => {
  it('returns the redacted string for an ordinary command line with a secret', () => {
    expect(sanitizeCommandLine('myapp --token=abc123 --port=8080')).toBe(
      'myapp --token=*** --port=8080',
    );
  });

  it('returns the input unchanged when it has no secret-shaped content', () => {
    expect(sanitizeCommandLine('node dist/index.js --once')).toBe('node dist/index.js --once');
  });

  it('throws SecretRedactionError when a value still resists redaction after tier 1 (e.g. a bare JWT with no recognizable key name)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(() => sanitizeCommandLine(`myapp --forward ${jwt}`)).toThrow(SecretRedactionError);
  });

  it('throws SecretRedactionError for a long opaque token with no recognizable key name (high-entropy fallback)', () => {
    const opaqueToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    expect(() => sanitizeCommandLine(`myapp --send ${opaqueToken}`)).toThrow(SecretRedactionError);
  });

  it('acceptance fixture: --token=abc redacts to *** and does not throw', () => {
    expect(sanitizeCommandLine('myapp --token=abc')).toBe('myapp --token=***');
  });
});

describe('sanitizeCommandLines (batch)', () => {
  it('sanitizes every process entry when all are clean', () => {
    const input = [
      { id: 'p1', commandLine: 'myapp --token=abc' },
      { id: 'p2', commandLine: 'node dist/index.js' },
    ];
    const result = sanitizeCommandLines(input);
    expect(result).toEqual([
      { id: 'p1', commandLine: 'myapp --token=***' },
      { id: 'p2', commandLine: 'node dist/index.js' },
    ]);
  });

  it('drops the whole batch (throws) when any single entry resists redaction', () => {
    const opaqueToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const input = [
      { id: 'p1', commandLine: 'myapp --token=abc' }, // this one alone would be fine
      { id: 'p2', commandLine: `myapp --send ${opaqueToken}` }, // this one resists redaction
    ];
    expect(() => sanitizeCommandLines(input)).toThrow(SecretRedactionError);
  });

  it('never returns a partial result when a later entry fails', () => {
    const opaqueToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const input = [
      { id: 'p1', commandLine: 'myapp --token=abc' },
      { id: 'p2', commandLine: `myapp --send ${opaqueToken}` },
    ];
    let threw = false;
    let result: unknown;
    try {
      result = sanitizeCommandLines(input);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });
});
