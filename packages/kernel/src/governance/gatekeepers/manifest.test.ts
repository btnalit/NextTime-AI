import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
// Test files are exempt from the six-layer dependency-cruiser rule
// (`kernel-governance-may-not-depend-on-upper-layers`'s `.dependency-cruiser.cjs` exclude on
// `\.test\.tsx?$`) — this one import lets the S3.12 "publish Activity records supersedes"
// assertions exercise the real capability handler (Activity creation lives there, not in
// `publishOperation` itself) without standing up a full `dispatchCapability` fixture.
import { publishOperationHandler } from '../../application/gateway/operation-manifest-handlers.js';
import { findOperationCandidates } from '../../substrate/graph/index.js';
import {
  OperationIdentityConflictError,
  OperationNotFoundError,
  deprecateOperation,
  getOperation,
  getPublishedOperation,
  importManifest,
  listOperations,
  listPublishedOperationsForGatekeepers,
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

    it('S3.12: proposing over a published Operation opens a new revision draft (never demotes/rewrites the published row)', async () => {
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
      const published = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(published?.version).toBe(1);

      // Pre-S3.12 this exact sequence threw OperationIdentityConflictError (see
      // docs/development-tasks.md S3.12 note / docs/runbooks/web-console.md known-gap #11) — a
      // Handle-channel caller (proposedBy.kind 'agent') reclassifying the just-published Operation
      // now opens a revision draft instead, one version above the published one.
      const reviseAct = await newActivity();
      const revision = await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name: op.name, mode: 'observe' }),
          proposedBy: { id: attackerId, kind: 'agent' },
          activityId: reviseAct,
        }),
      );
      expect(revision.status).toBe('draft');
      expect(revision.version).toBe(2);
      expect(revision.draftOf).toBe(published?.id);
      expect(revision.operation.mode).toBe('observe');

      // The published row is completely untouched (I17/I16) — still v1, still published, still the
      // owner's original definition.
      const stillPublished = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(stillPublished?.id).toBe(published?.id);
      expect(stillPublished?.version).toBe(1);
      expect(stillPublished?.operation.mode).toBe('execute');
      expect(stillPublished?.operation.blast_radius).toBe('high');

      // Agent-facing reads (I17: published-only) still resolve to exactly the live v1, never the
      // pending revision draft or both at once — `find_operations`/`list_allowed_operations`'s own
      // pure-query half and gate tool resolution (`request-action-handler.ts`) all read
      // `getPublishedOperation`/this same published-only filter.
      const candidates = await inTx((client) =>
        findOperationCandidates(client, workspaceId, { need: op.name }),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.properties.mode).toBe('execute');
      const allowed = await inTx((client) =>
        listPublishedOperationsForGatekeepers(client, workspaceId, [gatekeeperId]),
      );
      expect(allowed.filter((r) => r.name === op.name)).toEqual([
        expect.objectContaining({ version: 1, status: 'published' }),
      ]);
    });

    it('S3.12: a proposer may revise their own pending revision draft in place; another proposer gets OperationIdentityConflictError naming the draft (never leaking it)', async () => {
      const op = testOperation({ name: `stock.revise.${randomUUID()}`, mode: 'execute' });
      const importAct = await newActivity();
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: importAct,
        }),
      );
      await inTx((client) => publishManifest(client, workspaceId, { gatekeeperId }));
      const published = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );

      const firstReviseAct = await newActivity();
      const firstRevision = await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name: op.name, mode: 'observe' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: firstReviseAct,
        }),
      );
      expect(firstRevision.version).toBe(2);
      expect(firstRevision.draftOf).toBe(published?.id);

      // Same proposer revises their own pending revision draft — replaced in place, same version,
      // same draftOf, not a third row.
      const secondReviseAct = await newActivity();
      const secondRevision = await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name: op.name, mode: 'observe', blast_radius: 'medium' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: secondReviseAct,
        }),
      );
      expect(secondRevision.version).toBe(2);
      expect(secondRevision.draftOf).toBe(published?.id);
      expect(secondRevision.operation.blast_radius).toBe('medium');

      // Another Principal proposing over that same identity while the revision draft is pending —
      // rejected, the error names the *draft's* status (never its content), the published row is
      // not re-consulted once a draft exists.
      const conflictAct = await newActivity();
      await expect(
        inTx((client) =>
          proposeOperation(client, workspaceId, {
            gatekeeperId,
            operation: testOperation({ name: op.name, mode: 'observe' }),
            proposedBy: { id: attackerId, kind: 'agent' },
            activityId: conflictAct,
          }),
        ),
      ).rejects.toMatchObject({
        name: 'OperationIdentityConflictError',
        existingStatus: 'draft',
      });

      const current = await inTx((client) =>
        getOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(current?.version).toBe(2);
      expect(current?.operation.blast_radius).toBe('medium');
      expect(current?.proposedBy?.id).toBe(ownerId);

      // The published v1 is still exactly what it was — never touched by any of the above.
      const stillPublished = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(stillPublished?.id).toBe(published?.id);
      expect(stillPublished?.operation.mode).toBe('execute');
    });

    it('S3.12: publish_operation on a revision draft publishes it and deprecates the superseded version in one call; only the new version is then live, history stays queryable', async () => {
      const op = testOperation({ name: `stock.publish-revision.${randomUUID()}`, mode: 'execute' });
      const importAct = await newActivity();
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: importAct,
        }),
      );
      await inTx((client) => publishManifest(client, workspaceId, { gatekeeperId }));
      const v1 = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );

      const reviseAct = await newActivity();
      await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name: op.name, mode: 'observe' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: reviseAct,
        }),
      );

      const published = await inTx((client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name: op.name }),
      );
      expect(published.status).toBe('published');
      expect(published.version).toBe(2);
      expect(published.operation.mode).toBe('observe');
      expect(published.supersedes).toBe(v1?.id);

      // Only v2 is now live/current.
      const v2 = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(v2?.version).toBe(2);
      expect(v2?.operation.mode).toBe('observe');
      const current = await inTx((client) =>
        getOperation(client, workspaceId, gatekeeperId, op.name),
      );
      expect(current?.version).toBe(2);
      expect(current?.status).toBe('published');

      // Agent-facing reads see exactly v2, never v1 or both.
      const candidates = await inTx((client) =>
        findOperationCandidates(client, workspaceId, { need: op.name }),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.properties.mode).toBe('observe');
      const allowed = await inTx((client) =>
        listPublishedOperationsForGatekeepers(client, workspaceId, [gatekeeperId]),
      );
      expect(allowed.filter((r) => r.name === op.name)).toHaveLength(1);
      expect(allowed.find((r) => r.name === op.name)?.version).toBe(2);

      // History stays queryable via the human-facing list_operations: both rows, correctly labeled.
      const history = (
        await inTx((client) => listOperations(client, workspaceId, { gatekeeperId }))
      )
        .filter((r) => r.name === op.name)
        .sort((a, b) => a.version - b.version);
      expect(history).toEqual([
        expect.objectContaining({ version: 1, status: 'deprecated', id: v1?.id }),
        expect.objectContaining({ version: 2, status: 'published' }),
      ]);
    });

    it('S3.12: publishing a revision draft whose superseded version was already deprecated directly does not throw (idempotent-safe)', async () => {
      const op = testOperation({
        name: `stock.already-deprecated.${randomUUID()}`,
        mode: 'execute',
      });
      const importAct = await newActivity();
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: importAct,
        }),
      );
      await inTx((client) => publishManifest(client, workspaceId, { gatekeeperId }));

      const reviseAct = await newActivity();
      await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name: op.name, mode: 'observe' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: reviseAct,
        }),
      );

      // deprecate_operation targets the *live published* row directly — unaffected by the pending
      // revision draft (a human must be able to retire the current version regardless).
      const deprecated = await inTx((client) =>
        deprecateOperation(client, workspaceId, { gatekeeperId, name: op.name }),
      );
      expect(deprecated.version).toBe(1);
      expect(deprecated.status).toBe('deprecated');

      // Publishing the revision must not then throw trying to deprecate an already-deprecated row.
      const published = await inTx((client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name: op.name }),
      );
      expect(published.status).toBe('published');
      expect(published.version).toBe(2);
      expect(published.supersedes).toBeUndefined();
    });

    it('S3.12: publish_operation records `supersedes` on the operation_publish Activity for audit/explain', async () => {
      const op = testOperation({ name: `stock.audit-supersedes.${randomUUID()}`, mode: 'execute' });
      const importAct = await newActivity();
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: importAct,
        }),
      );
      await inTx((client) => publishManifest(client, workspaceId, { gatekeeperId }));
      const v1 = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
      );

      const reviseAct = await newActivity();
      await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name: op.name, mode: 'observe' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: reviseAct,
        }),
      );

      const handlerResult = (await inTx((client) =>
        publishOperationHandler(
          client,
          workspaceId,
          { gatekeeperId, name: op.name },
          {
            channel: 'human',
            principalId: ownerId,
          },
        ),
      )) as { result: { supersedes: string | null } };
      expect(handlerResult.result.supersedes).toBe(v1?.id);

      const activity = await inTx((client) =>
        client.query<{ metadata: { supersedes?: string | null } }>(
          `select metadata from activities
           where workspace_id = $1 and kind = 'operation_publish'
           order by created_at desc limit 1`,
          [workspaceId],
        ),
      );
      expect(activity.rows[0]?.metadata.supersedes).toBe(v1?.id);
    });

    it('S3.12 compat: a legacy Operation row (identity_key without version) is backfilled by the 0016 migration path, then propose_operation opens v2 with draftOf — never a fresh v1 coexisting beside it', async () => {
      const name = `legacy.op.${randomUUID()}`;
      const legacyOperation = testOperation({
        name,
        mode: 'execute',
        blast_radius: 'high',
        auto_approvable: false,
      });

      // Simulate a pre-S3.12 row exactly as `registerOperationDraftObject` used to write it:
      // `identity_key` is the old two-field `{gatekeeperId, name}` — no `version` key at all —
      // and `properties` carries no `version`/`draftOf` either (those fields did not exist yet).
      const legacyRow = await inTx((client) =>
        client.query<{ id: string }>(
          `insert into objects (workspace_id, object_type, identity_key, properties)
           values ($1, 'Operation', $2::jsonb, $3::jsonb)
           returning id`,
          [
            workspaceId,
            JSON.stringify({ gatekeeperId, name }),
            JSON.stringify({
              ...legacyOperation,
              status: 'published',
              origin: 'import',
              proposedBy: ownerId,
              proposedByKind: 'human',
            }),
          ],
        ),
      );
      const legacyId = legacyRow.rows[0]?.id;
      expect(legacyId).toBeTruthy();

      // Before the backfill: reads already find it (they extract `gatekeeperId`/`name` via `->>`,
      // never match `identity_key` exactly) and `OperationRecord.version` reads `1` — but only
      // because `toOperationRecord` *defaults* an absent `properties.version` to `1`, not because
      // the stored `identity_key` actually carries that key yet.
      const beforeBackfill = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, name),
      );
      expect(beforeBackfill?.id).toBe(legacyId);
      expect(beforeBackfill?.version).toBe(1);

      // Run the exact backfill `packages/kernel/migrations/core/
      // 0016_operation_identity_version_backfill.sql` applies. `runMigrations()` in `beforeAll`
      // already ran 0016 once, before this row ever existed, so this re-issues the identical
      // statement standalone — proving the backfill logic itself against a genuinely legacy row.
      await inTx((client) =>
        client.query(
          `update objects
           set identity_key = identity_key || jsonb_build_object('version', 1)
           where object_type = 'Operation'
             and identity_key is not null
             and not (identity_key ? 'version')`,
        ),
      );

      // Same row, same id — now addressable at the identity a write actually targets,
      // {gatekeeperId, name, version: 1}.
      const afterBackfill = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, name),
      );
      expect(afterBackfill?.id).toBe(legacyId);
      expect(afterBackfill?.version).toBe(1);

      // The actual regression this backfill closes: propose_operation opens v2 with draftOf
      // pointing at the legacy row — never a "fresh v1" that would silently coexist beside it
      // (which is what happened pre-backfill: the write path's exact-identity upsert missed the
      // legacy row entirely).
      const reviseAct = await newActivity();
      const revision = await inTx((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation({ name, mode: 'observe' }),
          proposedBy: { id: ownerId, kind: 'agent' },
          activityId: reviseAct,
        }),
      );
      expect(revision.version).toBe(2);
      expect(revision.draftOf).toBe(legacyId);

      // publish_operation on that revision deprecates the *same* legacy row in place (rather than
      // inserting a phantom incomplete row beside it, which is exactly what the pre-backfill bug
      // did) — find_operations/list_allowed_operations/gate tool resolution then see exactly one
      // published row, never two.
      const published = await inTx((client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name }),
      );
      expect(published.version).toBe(2);
      expect(published.supersedes).toBe(legacyId);

      const rowCount = await inTx((client) =>
        client.query<{ count: string }>(
          `select count(*)::bigint as count from objects
           where workspace_id = $1 and object_type = 'Operation'
             and identity_key ->> 'gatekeeperId' = $2 and identity_key ->> 'name' = $3`,
          [workspaceId, gatekeeperId, name],
        ),
      );
      // The legacy row (now deprecated) + v2 (published) — never a third, phantom row.
      expect(Number(rowCount.rows[0]?.count)).toBe(2);

      const legacyRecord = await inTx((client) =>
        client.query<{ properties: { status?: string } }>(
          'select properties from objects where workspace_id = $1 and id = $2',
          [workspaceId, legacyId],
        ),
      );
      expect(legacyRecord.rows[0]?.properties.status).toBe('deprecated');

      // find_operations / list_allowed_operations / gate tool resolution dedupe by identity:
      // exactly one candidate, the new published version.
      const candidates = await inTx((client) =>
        findOperationCandidates(client, workspaceId, { need: name }),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).toBe(revision.id);
      const allowed = await inTx((client) =>
        listPublishedOperationsForGatekeepers(client, workspaceId, [gatekeeperId]),
      );
      expect(allowed.filter((r) => r.name === name)).toHaveLength(1);
      expect(allowed.find((r) => r.name === name)?.id).toBe(revision.id);
      const currentPublished = await inTx((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, name),
      );
      expect(currentPublished?.id).toBe(revision.id);

      // list_operations (human directory) still shows full, correctly-labeled history — the
      // legacy row deprecated, the revision published — never a phantom third row.
      const history = (
        await inTx((client) => listOperations(client, workspaceId, { gatekeeperId }))
      ).filter((r) => r.name === name);
      expect(history).toHaveLength(2);
      expect(history.find((r) => r.id === legacyId)?.status).toBe('deprecated');
      expect(history.find((r) => r.id === revision.id)?.status).toBe('published');
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
