import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * adapters/gatekeeper-client/connection-secret: the credential the kernel presents to a
 * **self-connected** gate (R-01, maintainer decision D-01, 2026-10-02 review). The platform
 * `gate_token` goes only to gates the kernel provisioned (a `gate_instances` row: a packaged gate
 * on the compose network or a gate-host instance); a gate a workspace owner connected with
 * `create_connection` gets its own secret instead, which the owner copies into the gate's
 * `GATE_KERNEL_TOKEN_FILE` once. Before this, the kernel sent `gate_token` to whatever endpoint an
 * owner typed, and with it the owner could call any packaged gate or gate-host instance directly —
 * no ActionRequest, no approval, no kernel audit.
 *
 * Construction — re-derivable, never stored (the kernel keeps only a non-secret salt on the
 * Gatekeeper Object, `connectionSecretSalt`):
 *
 *     key    = HMAC-SHA256(key = "nexttime-gate-connection", msg = gate_token)
 *     mac    = HMAC-SHA256(key = key, msg = "<workspaceId>:<salt>"), hex
 *     secret = "ntgc1_<salt>_<mac>"          (salt = 16 random bytes, hex)
 *
 * The first step is the same HKDF-Extract-with-a-public-label construction R-03 uses for the
 * internal-plane credentials (`interfaces/internal-auth`'s `deriveInternalCredential`), with its
 * own label, so a connection secret is domain-separated from `gate_token` itself and reveals
 * nothing about it or any other connection's secret. Binding the workspace id means a secret minted
 * in one workspace is refused in every other. The secret carries its own salt, so the kernel can
 * verify a presented secret (`saltOf`) without storing anything: `mint_connection_secret` hands a
 * fresh one to the owner (shown once — the gate must hold it before `create_connection` first calls
 * the gate), `create_connection` verifies it and records only the salt, and
 * `rotate_connection_secret` replaces the salt (the old secret stops working at once).
 *
 * Rotating `gate_token` itself (docs/runbooks/key-rotation.md §3) therefore changes every
 * connection secret too; each owner re-issues theirs.
 */

/** Public label of the connection-secret key (see the module doc comment). */
export const CONNECTION_SECRET_LABEL = 'nexttime-gate-connection' as const;

/** Version prefix of every connection secret — also what makes one recognizable in a config file
 *  or a secret scanner. */
export const CONNECTION_SECRET_PREFIX = 'ntgc1' as const;

const CONNECTION_SECRET_PATTERN = /^ntgc1_([0-9a-f]{32})_([0-9a-f]{64})$/;
const SALT_PATTERN = /^[0-9a-f]{32}$/;

/** A fresh, random, non-secret salt (16 bytes, hex). */
export function newConnectionSecretSalt(): string {
  return randomBytes(16).toString('hex');
}

/** Whether `value` has the shape of a stored salt (`newConnectionSecretSalt`'s output). */
export function isConnectionSecretSalt(value: unknown): value is string {
  return typeof value === 'string' && SALT_PATTERN.test(value);
}

/** The connection secret for `(workspaceId, salt)` under `gateToken`. */
export function deriveConnectionSecret(
  gateToken: string,
  workspaceId: string,
  salt: string,
): string {
  const key = createHmac('sha256', CONNECTION_SECRET_LABEL).update(gateToken, 'utf8').digest();
  const mac = createHmac('sha256', key).update(`${workspaceId}:${salt}`, 'utf8').digest('hex');
  return `${CONNECTION_SECRET_PREFIX}_${salt}_${mac}`;
}

/** The salt `presented` was minted with for `workspaceId` under `gateToken`, or `null` when it was
 *  not (wrong shape, another workspace, another `gate_token`, tampered). Constant-time compare. */
export function connectionSecretSalt(
  gateToken: string,
  workspaceId: string,
  presented: string,
): string | null {
  const candidate = presented.trim();
  const match = CONNECTION_SECRET_PATTERN.exec(candidate);
  const salt = match?.[1];
  if (salt === undefined) return null;
  const expected = Buffer.from(deriveConnectionSecret(gateToken, workspaceId, salt), 'utf8');
  const actual = Buffer.from(candidate, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? salt : null;
}

/** Thrown when the kernel has no readable `gate_token` (`NEXTTIME_GATE_TOKEN_FILE`), so it can
 *  neither issue nor verify a connection secret. Mapped to 503 by the interfaces. */
export class GateConnectionSecretsUnavailableError extends Error {
  constructor() {
    super(
      'connection secrets are unavailable: the kernel has no readable gate token (NEXTTIME_GATE_TOKEN_FILE, compose secret gate_token)',
    );
    this.name = 'GateConnectionSecretsUnavailableError';
  }
}

/** Issuing and verifying connection secrets — the application layer's port onto the gate token,
 *  which never leaves this adapter. */
export interface GateConnectionSecrets {
  /** A fresh secret (and its salt) for a connection about to be made in `workspaceId`. Stores
   *  nothing. */
  mint(workspaceId: string): { readonly secret: string; readonly salt: string };
  /** The salt `presented` was minted with for `workspaceId`, or `null` (see `connectionSecretSalt`). */
  saltOf(workspaceId: string, presented: string): string | null;
}

/** `GateConnectionSecrets` over `gateToken`; every call throws
 *  `GateConnectionSecretsUnavailableError` when it is `undefined`. */
export function createGateConnectionSecrets(gateToken: string | undefined): GateConnectionSecrets {
  function requireToken(): string {
    if (gateToken === undefined) throw new GateConnectionSecretsUnavailableError();
    return gateToken;
  }
  return {
    mint(workspaceId) {
      const salt = newConnectionSecretSalt();
      return { salt, secret: deriveConnectionSecret(requireToken(), workspaceId, salt) };
    },
    saltOf(workspaceId, presented) {
      return connectionSecretSalt(requireToken(), workspaceId, presented);
    },
  };
}
