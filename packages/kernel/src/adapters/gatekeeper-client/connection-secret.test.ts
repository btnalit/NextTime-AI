import { describe, expect, it } from 'vitest';
import {
  CONNECTION_SECRET_PREFIX,
  GateConnectionSecretsUnavailableError,
  connectionSecretSalt,
  createGateConnectionSecrets,
  deriveConnectionSecret,
  isConnectionSecretSalt,
} from './connection-secret.js';

const GATE_TOKEN = 'platform-gate-token-for-tests-0123456789';
const WORKSPACE_A = '11111111-2222-4333-8444-555555555555';
const WORKSPACE_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

describe('connection secrets (R-01 / D-01)', () => {
  it('mints a secret that carries its salt and verifies only in its own workspace', () => {
    const secrets = createGateConnectionSecrets(GATE_TOKEN);
    const { secret, salt } = secrets.mint(WORKSPACE_A);
    expect(secret.startsWith(`${CONNECTION_SECRET_PREFIX}_${salt}_`)).toBe(true);
    expect(isConnectionSecretSalt(salt)).toBe(true);
    expect(secrets.saltOf(WORKSPACE_A, secret)).toBe(salt);
    expect(secrets.saltOf(WORKSPACE_A, `${secret}\n`)).toBe(salt);
    expect(secrets.saltOf(WORKSPACE_B, secret)).toBeNull();
    expect(secrets.mint(WORKSPACE_A).salt).not.toBe(salt);
  });

  it('is re-derivable from (gate token, workspace, salt) and domain-separated from the gate token', () => {
    const salt = 'b'.repeat(32);
    const secret = deriveConnectionSecret(GATE_TOKEN, WORKSPACE_A, salt);
    expect(deriveConnectionSecret(GATE_TOKEN, WORKSPACE_A, salt)).toBe(secret);
    expect(secret).not.toContain(GATE_TOKEN);
    expect(deriveConnectionSecret(GATE_TOKEN, WORKSPACE_B, salt)).not.toBe(secret);
    expect(deriveConnectionSecret(`${GATE_TOKEN}x`, WORKSPACE_A, salt)).not.toBe(secret);
    // Long enough for gatekeeper-base's own token floor (GATE_TOKEN_MIN_LENGTH = 32), no whitespace.
    expect(secret.length).toBeGreaterThan(32);
    expect(/\s/.test(secret)).toBe(false);
  });

  it('refuses a tampered, foreign or malformed secret', () => {
    const salt = 'c'.repeat(32);
    const secret = deriveConnectionSecret(GATE_TOKEN, WORKSPACE_A, salt);
    const tampered = `${secret.slice(0, -1)}${secret.endsWith('0') ? '1' : '0'}`;
    expect(connectionSecretSalt(GATE_TOKEN, WORKSPACE_A, tampered)).toBeNull();
    expect(connectionSecretSalt(`${GATE_TOKEN}-rotated`, WORKSPACE_A, secret)).toBeNull();
    expect(connectionSecretSalt(GATE_TOKEN, WORKSPACE_A, GATE_TOKEN)).toBeNull();
    expect(connectionSecretSalt(GATE_TOKEN, WORKSPACE_A, '')).toBeNull();
  });

  it('is unavailable without a gate token', () => {
    const secrets = createGateConnectionSecrets(undefined);
    expect(() => secrets.mint(WORKSPACE_A)).toThrow(GateConnectionSecretsUnavailableError);
    expect(() => secrets.saltOf(WORKSPACE_A, 'x')).toThrow(GateConnectionSecretsUnavailableError);
  });
});
