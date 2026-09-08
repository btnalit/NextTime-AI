import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  OperationIdentityConflictError,
  OperationNotFoundError,
  deprecateOperation,
  getOperation,
  getPublishedOperation,
  importManifest,
  proposeOperation,
  publishManifest,
  publishOperation,
} from './manifest.js';
import { registerGatekeeper } from './registry.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for the Operation manifest
 * registry (design doc §5.1.4/§5.5 draft→published→deprecated, I16/I17; docs/development-tasks.md
 * S2.4). Covers this task's own acceptance note: "draft operation never executes" is
 * `getPublishedOperation` returning `null` for a draft — the caller (request-action-handler.ts)
 * is what turns that into "never execute", exercised end-to-end in
 * application/gateway/request-action.integration.test.ts.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

function testOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    name: `test.op.${randomUUID()}`,
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

describe.runIf(DATABASE_URL !== undefined)('governance/gatekeepers/manifest (integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;
  let attackerId: string;
  let gatekeeperId: string;

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

  async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
  }

  async function newActivity(): Promise<string> {
    return inTx(async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.manifest', 'running', $2) returning id`,
        [workspaceId, ownerId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('failed to insert test activity');
      return row.id;
    });
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('gatekeeper-manifest-test-workspace');
    ownerId = await adminInsertPrincipal('owner');
    // Stands in for a *different* Principal's Handle-channel session — I16 "修改他人草稿一律拒绝" is
    // about identity, not the `principals.kind` column, so a second `human` row is enough to exercise
    // "another principal" below; its own `propose_operation` calls still record `origin: 'agent'`
    // (the caller's channel, not this row's own kind — see proposeOperationHandler's own comment).
    attackerId = await adminInsertPrincipal('attacker');
    const act = await newActivity();
    const result = await inTx((client) =>
      registerGatekeeper(client, workspaceId, {
        name: 'manifest-test-gate',
        transportKind: 'http',
        target: 'example-system',
        endpoint: 'https://gate.example.invalid',
        activityId: act,
        registeredBy: { id: ownerId, kind: 'human' },
      }),
    );
    gatekeeperId = result.gatekeeperId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('importManifest creates draft Operations invisible to getPublishedOperation', async () => {
    const op = testOperation({ name: `stock.get.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );

    const draft = await inTx((client) => getOperation(client, workspaceId, gatekeeperId, op.name));
    expect(draft?.status).toBe('draft');
    expect(draft?.operation.mode).toBe('observe');

    const published = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
    );
    expect(published).toBeNull();
  });

  it('unknown Operation name resolves to null (I17 "unclassified")', async () => {
    const published = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, 'does.not.exist'),
    );
    expect(published).toBeNull();
  });

  it('publishOperation moves draft -> published, then getPublishedOperation finds it', async () => {
    const op = testOperation({ name: `stock.list.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );

    const published = await inTx((client) =>
      publishOperation(client, workspaceId, { gatekeeperId, name: op.name }),
    );
    expect(published.status).toBe('published');

    const record = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
    );
    expect(record?.status).toBe('published');
    expect(record?.operation.name).toBe(op.name);
  });

  it('publishing an already-published Operation throws IllegalTransition', async () => {
    const op = testOperation({ name: `stock.twice.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );
    await inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: op.name }));
    await expect(
      inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: op.name })),
    ).rejects.toThrow(IllegalTransition);
  });

  it('publishing an unknown Operation throws OperationNotFoundError', async () => {
    await expect(
      inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: 'nope' })),
    ).rejects.toThrow(OperationNotFoundError);
  });

  it('deprecateOperation moves published -> deprecated; getPublishedOperation then returns null', async () => {
    const op = testOperation({ name: `stock.deprecate.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );
    await inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: op.name }));
    const deprecated = await inTx((client) =>
      deprecateOperation(client, workspaceId, { gatekeeperId, name: op.name }),
    );
    expect(deprecated.status).toBe('deprecated');

    const record = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
    );
    expect(record).toBeNull();
  });

  // Review 2026-09, P0 (docs/development-tasks.md S2.4 "实现说明补充") — the attack sequence this
  // review fixed: `propose_operation` used to upsert by `{gatekeeperId, name}` identity alone, so a
  // Handle-channel caller could demote a *published* Operation back to `draft` and rewrite its
  // `mode`/`blast_radius`/`auto_approvable` (I17 DoS), which the owner's next `publish_manifest`
  // (publishes every draft, no diff) would then silently republish. `container.restart` below stands
  // in for the kind of high-blast-radius Operation an owner would actually import and publish.
  describe('draft isolation — propose/import/publish identity conflicts', () => {
    it('import + publishManifest publishes an execute Operation (container.restart)', async () => {
      const op = testOperation({
        name: `container.restart.${randomUUID()}`,
        mode: 'execute',
        blast_radius: 'high',
        auto_approvable: false,
      });
      const act = await newActivity();
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: act,
        }),
      );

      const published = await inTx((client) =>
        publishManifest(client, workspaceId, { gatekeeperId }),
      );
      expect(published.publishedOperationNames).toContain(op.name);
      expect(published.skippedDraftOperationNames).not.toContain(op.name);

      const record = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(record?.status).toBe('published');
      expect(record?.operation.mode).toBe('execute');
      expect(record?.operation.blast_radius).toBe('high');
      expect(record?.operation.auto_approvable).toBe(false);
    });

    it('a Handle caller re-proposing a published Operation gets OperationIdentityConflictError (409/ILLEGAL_TRANSITION), row unchanged', async () => {
      const op = testOperation({
        name: `container.restart.${randomUUID()}`,
        mode: 'execute',
        blast_radius: 'high',
        auto_approvable: false,
      });
      const act = await newActivity();
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: act,
        }),
      );
      await inTx((client) => publishManifest(client, workspaceId, { gatekeeperId }));

      // The attack: a Handle-channel caller (proposedBy.kind 'agent' — see proposeOperationHandler's
      // own comment on why `kind` is derived from the channel, not the row's own `principals.kind`)
      // tries to demote the just-published Operation to `draft`, rewriting `mode` to 'observe'.
      const attackAct = await newActivity();
      await expect(
        inTx((client) =>
          proposeOperation(client, workspaceId, {
            gatekeeperId,
            operation: testOperation({ name: op.name, mode: 'observe' }),
            proposedBy: { id: attackerId, kind: 'agent' },
            activityId: attackAct,
          }),
        ),
      ).rejects.toThrow(OperationIdentityConflictError);

      // I16: the existing row is untouched — still published, still the owner's original definition.
      const record = await inTx((client) =>
        getOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(record?.status).toBe('published');
      expect(record?.operation.mode).toBe('execute');
      expect(record?.operation.blast_radius).toBe('high');
    });

    it('a proposer may revise their own draft, but another Principal proposing over it gets OperationIdentityConflictError', async () => {
      const name = `stock.propose.${randomUUID()}`;
      const act1 = await newActivity();
      const firstDraft = await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name, mode: 'observe' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: act1,
        }),
      );
      expect(firstDraft.status).toBe('draft');
      expect(firstDraft.origin).toBe('agent');

      // Own draft re-propose: same proposer, same identity — allowed, replaces the definition.
      const act2 = await newActivity();
      const revised = await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name, mode: 'execute', blast_radius: 'medium' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: act2,
        }),
      );
      expect(revised.status).toBe('draft');
      expect(revised.operation.mode).toBe('execute');

      // Another Principal proposing over that same draft identity — rejected, draft unchanged.
      const act3 = await newActivity();
      await expect(
        inTx((client) =>
          proposeOperation(client, workspaceId, {
            gatekeeperId,
            operation: testOperation({ name, mode: 'observe' }),
            proposedBy: { id: attackerId, kind: 'agent' },
            activityId: act3,
          }),
        ),
      ).rejects.toThrow(OperationIdentityConflictError);

      const record = await inTx((client) => getOperation(client, workspaceId, gatekeeperId, name));
      expect(record?.status).toBe('draft');
      expect(record?.operation.mode).toBe('execute');
      expect(record?.proposedBy?.id).toBe(ownerId);
    });

    it('publishManifest leaves an agent-origin draft as draft (skippedDraftOperationNames), and importManifest skips an already-published name', async () => {
      // An agent proposal sitting alongside the gate's own import drafts.
      const agentDraftName = `stock.agent-draft.${randomUUID()}`;
      const proposeAct = await newActivity();
      await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name: agentDraftName }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: proposeAct,
        }),
      );

      const importAct = await newActivity();
      const publishedName = `stock.import-draft.${randomUUID()}`;
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [testOperation({ name: publishedName })],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: importAct,
        }),
      );

      const publishResult = await inTx((client) =>
        publishManifest(client, workspaceId, { gatekeeperId }),
      );
      expect(publishResult.publishedOperationNames).toContain(publishedName);
      expect(publishResult.publishedOperationNames).not.toContain(agentDraftName);
      expect(publishResult.skippedDraftOperationNames).toContain(agentDraftName);

      const agentDraft = await inTx((client) =>
        getOperation(client, workspaceId, gatekeeperId, agentDraftName),
      );
      expect(agentDraft?.status).toBe('draft');

      // Now re-import over the name that was just published, with a *different* mode — importManifest
      // must not demote/rewrite it (I16: a published row is never written by an import).
      const reimportAct = await newActivity();
      const reimport = await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [testOperation({ name: publishedName, mode: 'execute' })],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: reimportAct,
        }),
      );
      expect(reimport.imported.map((r) => r.name)).not.toContain(publishedName);
      expect(reimport.skipped).toContainEqual({ name: publishedName, status: 'published' });

      const stillPublished = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, publishedName),
      );
      expect(stillPublished?.status).toBe('published');
      // testOperation()'s own default ('observe') — the reimport's 'execute' never landed.
      expect(stillPublished?.operation.mode).toBe('observe');
    });
  });
});
