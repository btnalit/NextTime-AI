import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  findOperationCandidates,
  findProcedureCandidates,
  findWorkerDefinitionCandidates,
} from './find-means.js';
import { SqlGraphStore } from './sql-store.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for `find-means.ts`'s
 * end-to-end tokenised keyword matching/ranking behaviour (S8 W2-K1, leftover 71, audit B3) —
 * `find-means.test.ts` covers the pure `tokenizeNeed`/`buildFindMeansQuery` builders directly;
 * this file proves the same behaviour through the public `find*Candidates` functions against a
 * real database (B4/B5 "tests verify behaviour through public interfaces"). Seeds `objects` rows
 * directly via `SqlGraphStore.upsertObject` rather than the full propose/publish pipeline — this
 * file's concern is find-means.ts's own query, not WorkerDefinition/Operation/Procedure lifecycle
 * (already covered elsewhere).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('find-means (integration, real Postgres)', () => {
  let pool: Pool;
  const store = new SqlGraphStore();
  let workspaceId: string;
  let ownerId: string;

  async function adminInsertWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId: id, principalId: randomUUID() },
      async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function adminInsertPrincipal(displayName: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', $3)",
          [workspaceId, id, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('find-means-test-workspace');
    ownerId = await adminInsertPrincipal('owner');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('blank need returns every candidate, bounded by limit', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const a = await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'blank-a', kind: 'worker' },
      });
      const b = await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'blank-b', kind: 'worker' },
      });
      const candidates = await findWorkerDefinitionCandidates(client, workspaceId, { need: '' });
      const ids = candidates.map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    });
  });

  it('no-hit: a keyword matching nothing returns an empty list', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'ops-runner', description: 'general purpose worker' },
      });
      const candidates = await findWorkerDefinitionCandidates(client, workspaceId, {
        need: 'zzz-nonexistent-keyword-xyz',
      });
      expect(candidates).toEqual([]);
    });
  });

  it('English need: a multi-word need matches on any keyword, not the whole phrase', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const wd = await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'backup-runner', description: 'restarts a container on demand' },
      });
      const candidates = await findWorkerDefinitionCandidates(client, workspaceId, {
        need: 'please restart my thing',
      });
      expect(candidates.map((c) => c.id)).toContain(wd.id);
    });
  });

  it('Chinese need: a bigram from a multi-char CJK need hits a description that does not contain the whole run', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const wd = await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'container-ops', description: '重启一个已注册的容器' },
      });
      // "重启容器" never appears verbatim in the description above — only via the "重启"/"容器"
      // bigrams this fix adds (this file's own module doc comment: the exact B3 regression shape).
      const candidates = await findWorkerDefinitionCandidates(client, workspaceId, {
        need: '重启容器',
      });
      expect(candidates.map((c) => c.id)).toContain(wd.id);
    });
  });

  it('mixed English/Chinese need matches a candidate on either script', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const wd = await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'docker-container', description: '管理容器' },
      });
      const candidates = await findWorkerDefinitionCandidates(client, workspaceId, {
        need: 'docker 容器',
      });
      expect(candidates.map((c) => c.id)).toContain(wd.id);
    });
  });

  it('ranking order: a candidate matching more distinct tokens ranks above one matching fewer', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const both = await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'restart-container-runner', description: 'restart a container' },
      });
      const one = await store.upsertObject(client, workspaceId, {
        objectType: 'WorkerDefinition',
        properties: { name: 'restart-only-runner', description: 'restart something' },
      });
      const candidates = await findWorkerDefinitionCandidates(client, workspaceId, {
        need: 'restart container',
      });
      const bothIndex = candidates.findIndex((c) => c.id === both.id);
      const oneIndex = candidates.findIndex((c) => c.id === one.id);
      expect(bothIndex).toBeGreaterThanOrEqual(0);
      expect(oneIndex).toBeGreaterThanOrEqual(0);
      expect(bothIndex).toBeLessThan(oneIndex);
    });
  });

  it('find_operations: a token also matches the Operation\'s own Gatekeeper name ("operation kind/gate name where available")', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const gk = await store.upsertObject(client, workspaceId, {
        objectType: 'Gatekeeper',
        properties: { name: 'docker', transportKind: 'cli', target: 'docker', endpoint: 'local' },
      });
      const op = await store.upsertObject(client, workspaceId, {
        objectType: 'Operation',
        identity: { gatekeeperId: gk.id, name: 'container.restart', version: 1 },
        properties: {
          name: 'container.restart',
          description: 'restarts one container',
          mode: 'execute',
          status: 'published',
        },
      });
      const candidates = await findOperationCandidates(client, workspaceId, { need: 'docker' });
      expect(candidates.map((c) => c.id)).toContain(op.id);
    });
  });

  it('find_operations: an unpublished (draft) Operation never matches (I16/I17)', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const gk = await store.upsertObject(client, workspaceId, {
        objectType: 'Gatekeeper',
        properties: { name: 'draft-gate', transportKind: 'cli', target: 'x', endpoint: 'local' },
      });
      const op = await store.upsertObject(client, workspaceId, {
        objectType: 'Operation',
        identity: { gatekeeperId: gk.id, name: 'draft.op', version: 1 },
        properties: { name: 'draft.op', description: 'a draft operation', status: 'draft' },
      });
      const candidates = await findOperationCandidates(client, workspaceId, { need: 'draft' });
      expect(candidates.map((c) => c.id)).not.toContain(op.id);
    });
  });

  it('find_procedures candidates are matched the same way (no status filter, S2.14 shape)', async () => {
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const proc = await store.upsertObject(client, workspaceId, {
        objectType: 'Procedure',
        identity: { procedureId: randomUUID(), version: 1 },
        properties: { name: 'nightly-backup', description: '每晚备份数据库' },
      });
      const candidates = await findProcedureCandidates(client, workspaceId, { need: '备份' });
      expect(candidates.map((c) => c.id)).toContain(proc.id);
    });
  });
});
