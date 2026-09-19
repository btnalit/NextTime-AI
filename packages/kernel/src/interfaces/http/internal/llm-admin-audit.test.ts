import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolLike } from '../../../adapters/db/pool.js';
import type { LlmAdminAuditEvent } from './llm-admin-audit.js';
import { registerLlmAdminAuditRoutes } from './llm-admin-audit.js';

/**
 * interfaces/http/internal/llm-admin-audit.test: route-shape tests only (`deps.writeLlmAdminAudit`
 * faked). The real platform audit row, the internal-token guard and the unknown-actor refusal are
 * covered by application/gateway/llm-admin.integration.test.ts (DB-gated).
 */

function fakePool(): PoolLike {
  const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  return { connect: vi.fn(async () => client as unknown as PoolClient) };
}

function event(overrides: Partial<LlmAdminAuditEvent> = {}): LlmAdminAuditEvent {
  return {
    action: 'provider_updated',
    providerId: 'acme',
    actorUserId: randomUUID(),
    tokenJti: randomUUID(),
    details: { changed: ['enabled'] },
    ...overrides,
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /internal/llm-admin-audit', () => {
  it('validates the event, hands it to the writer and returns the audit id', async () => {
    app = Fastify();
    const writer = vi.fn(async () => ({ auditId: 'audit-1' }));
    await registerLlmAdminAuditRoutes(app, { pool: fakePool(), writeLlmAdminAudit: writer });
    const body = event();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-admin-audit',
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { auditId: 'audit-1' } });
    expect(writer).toHaveBeenCalledWith(body);
  });

  it('400s an unknown action, a non-slug provider id, a non-uuid actor, an unknown field, or oversized details', async () => {
    app = Fastify();
    const writer = vi.fn(async () => ({ auditId: 'audit-1' }));
    await registerLlmAdminAuditRoutes(app, { pool: fakePool(), writeLlmAdminAudit: writer });
    const bad: Record<string, unknown>[] = [
      { ...event(), action: 'provider_secret_written' },
      { ...event(), providerId: 'Not A Slug' },
      { ...event(), actorUserId: 'admin' },
      { ...event(), apiKey: 'sk-never' },
      { ...event(), details: { blob: 'x'.repeat(5000) } },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/internal/llm-admin-audit', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'invalid_body' } });
    }
    expect(writer).not.toHaveBeenCalled();
  });

  it('maps a foreign-key violation on the actor to 400 unknown_actor and anything else to 500', async () => {
    app = Fastify();
    await registerLlmAdminAuditRoutes(app, {
      pool: fakePool(),
      writeLlmAdminAudit: async (e) => {
        if (e.action === 'provider_deleted')
          throw Object.assign(new Error('fk'), { code: '23503' });
        throw new Error('boom');
      },
    });
    const fk = await app.inject({
      method: 'POST',
      url: '/internal/llm-admin-audit',
      payload: event({ action: 'provider_deleted' }),
    });
    expect(fk.statusCode).toBe(400);
    expect(fk.json()).toMatchObject({ ok: false, error: { code: 'unknown_actor' } });
    const other = await app.inject({
      method: 'POST',
      url: '/internal/llm-admin-audit',
      payload: event(),
    });
    expect(other.statusCode).toBe(500);
  });
});
