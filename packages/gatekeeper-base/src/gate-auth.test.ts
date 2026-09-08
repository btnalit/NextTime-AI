import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createGateAuthGuard,
  loadGateKernelToken,
  resolveGateKernelTokenFile,
} from './gate-auth.js';
import { GateTokenError } from './gate-token.js';

const dir = mkdtempSync(join(tmpdir(), 'gate-auth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveGateKernelTokenFile', () => {
  it('defaults to /run/secrets/gate_token', () => {
    expect(resolveGateKernelTokenFile({})).toBe('/run/secrets/gate_token');
  });

  it('honours GATE_KERNEL_TOKEN_FILE when set', () => {
    expect(resolveGateKernelTokenFile({ GATE_KERNEL_TOKEN_FILE: '/x/token' })).toBe('/x/token');
  });
});

describe('loadGateKernelToken', () => {
  it('reads, trims, and validates the token file', () => {
    const file = join(dir, 'good.token');
    writeFileSync(file, `${'a'.repeat(40)}\n`);
    expect(loadGateKernelToken({ GATE_KERNEL_TOKEN_FILE: file })).toBe('a'.repeat(40));
  });

  it('throws GateTokenError when the file is missing (this gate refuses to start)', () => {
    expect(() =>
      loadGateKernelToken({ GATE_KERNEL_TOKEN_FILE: join(dir, 'missing.token') }),
    ).toThrow(GateTokenError);
  });

  it('throws GateTokenError for a too-short token', () => {
    const file = join(dir, 'short.token');
    writeFileSync(file, 'too-short\n');
    expect(() => loadGateKernelToken({ GATE_KERNEL_TOKEN_FILE: file })).toThrow(GateTokenError);
  });
});

describe('createGateAuthGuard', () => {
  const guard = createGateAuthGuard('a'.repeat(40));

  function req(authorization: string | undefined) {
    return { headers: { authorization } } as unknown as Parameters<typeof guard.evaluate>[0];
  }

  it('allows the exact Bearer token', () => {
    expect(guard.evaluate(req(`Bearer ${'a'.repeat(40)}`))).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(guard.evaluate(req(undefined))).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(guard.evaluate(req(`Bearer ${'b'.repeat(40)}`))).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(guard.evaluate(req(`Basic ${'a'.repeat(40)}`))).toBe(false);
  });

  it('rejects a token of different length without throwing', () => {
    expect(guard.evaluate(req('Bearer short'))).toBe(false);
  });
});
