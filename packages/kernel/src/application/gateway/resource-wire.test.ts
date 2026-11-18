import { ConnectionRequestWireSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { ConnectionRequestRow } from '../../governance/connections/index.js';
import { toWireConnectionRequest } from './resource-wire.js';

/** Synthetic, not a credential: long enough that the value patterns read it as one. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

function request(target: string): ConnectionRequestRow {
  return {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    id: '00000000-0000-4000-8000-000000000002',
    status: 'requested',
    kind: 'http',
    target,
    requestedBy: '00000000-0000-4000-8000-000000000003',
    gatekeeperId: null,
    completedBy: null,
    requestedAt: new Date('2026-11-18T00:00:00Z'),
    completedAt: null,
    adminAgentSessionId: null,
  };
}

describe('toWireConnectionRequest — targetRedacted (legacy 247)', () => {
  it('an address that carries nothing is shown as stored and not marked', () => {
    for (const target of [
      'https://gate.example.invalid/api',
      // A user name alone is kept in a target: it is who to log in as, not a credential.
      'ssh://ops@gate.example.invalid',
      'ops@gate.example.invalid',
    ]) {
      const wire = toWireConnectionRequest(request(target));
      expect(wire.target).toBe(target);
      expect(wire).not.toHaveProperty('targetRedacted');
      expect(ConnectionRequestWireSchema.safeParse(wire).success).toBe(true);
    }
  });

  it('an address cut without any [redacted] left in it is marked', () => {
    for (const [target, shown] of [
      [`https://ops:${FAKE}@gate.example.invalid/api`, 'https://gate.example.invalid/api'],
      [`https://gate.example.invalid/api?token=${FAKE}`, 'https://gate.example.invalid/api'],
      [`https://gate.example.invalid/api?sig=${FAKE}#x`, 'https://gate.example.invalid/api'],
    ] as const) {
      const wire = toWireConnectionRequest(request(target));
      expect(wire.target).toBe(shown);
      expect(wire.targetRedacted).toBe(true);
      expect(ConnectionRequestWireSchema.safeParse(wire).success).toBe(true);
    }
  });

  it('an address with a secret masked in place is marked too, URL or not', () => {
    for (const [target, shown] of [
      [
        `https://gate.example.invalid/hook/ghp_${FAKE}abcdefgh/x`,
        'https://gate.example.invalid/hook/[redacted]/x',
      ],
      [`gate.example.invalid password=${FAKE}`, 'gate.example.invalid password=[redacted]'],
    ] as const) {
      const wire = toWireConnectionRequest(request(target));
      expect(wire.target).toBe(shown);
      expect(wire.targetRedacted).toBe(true);
      expect(ConnectionRequestWireSchema.safeParse(wire).success).toBe(true);
    }
  });
});
