import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ScopeValidationError, assertValidScope } from '../../governance/capability/index.js';
import {
  getPublishedOperation,
  importManifest,
  lockOperationRevision,
  operationContentDigest,
  proposeOperation,
  publishImportedDrafts,
  publishOperation,
  publishOperationRevision,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/absent-answers-review.integration.test (S11 「门确认不存在」 B-a): an observe
 * Operation declaring answers that mean "does not exist" is published only with a person's
 * confirmation that the gate's credentials can see what it looks up
 * (governance/gatekeepers/absent-answers-review.ts) — `publish_operation`'s
 * `absentAnswersReviewed`, recorded on the published version with who confirmed and when, and in
 * the audit row. Nothing an agent writes carries one: `publish_operation` is never a Handle's, a
 * proposal or manifest cannot smuggle the bookkeeping keys in, and the bulk paths that publish
 * without a person leave such a draft unpublished. A ChangePlan revision, which keeps the
 * definition, carries its live version's confirmation (or its lack).
 *
 * DB-gated (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

interface OperationRow {
  name: string;
  status: string;
  draftDigest?: string;
  absentAnswers?: unknown;
  absentAnswersReview?: { reviewedBy: string; reviewedAt: string };
}

interface PublishResult {
  status: string;
  version: number;
  absentAnswersReview: { reviewedBy: string; reviewedAt: string } | null;
}

function lookup(name: string, absentStatuses?: (404 | 410)[]): Operation {
  return {
    name,
    description: 'Looks up one record by its id.',
    binding: {
      kind: 'http',
      method: 'GET',
      path: '/records/{id}',
      ...(absentStatuses !== undefined ? { absent_statuses: absentStatuses } : {}),
    },
    params_schema: {
      type: 'object',
      properties: { id: { type: 'string', 'x-in': 'path' } },
      required: ['id'],
    },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: ['Record'],
    writes: [],
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'absent answers review — publishing a declaration of "does not exist" takes a person (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;

    function owner(): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId,
          id: ownerId,
          kind: 'human',
          role: 'owner' satisfies Role,
          displayName: null,
        },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: ownerId,
          kind: 'web',
          onBehalfOf: ownerId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    let serviceId: string;

    /** A `kind:'service'` owner's API key: it authenticates on the human channel too. */
    function service(): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId,
          id: serviceId,
          kind: 'service',
          role: 'owner' satisfies Role,
          displayName: 'aar-automation',
        },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: serviceId,
          kind: 'web',
          onBehalfOf: serviceId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    /** An agent's Handle acting for the owner, with `capabilities` in its scope. */
    function handle(capabilities: readonly string[]): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          scope: { capabilities: [...capabilities], resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
      return dispatchCapability({ pool }, owner(), name, params) as Promise<T>;
    }

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    /** The current row of `name`: its draft, else its published version. */
    async function row(name: string): Promise<OperationRow | undefined> {
      const listed = await call<{ items: OperationRow[] }>('list_operations', { gatekeeperId });
      const rows = listed.items.filter((item) => item.name === name);
      return (
        rows.find((item) => item.status === 'draft') ??
        rows.find((item) => item.status === 'published')
      );
    }

    async function storedProperties(name: string): Promise<Record<string, unknown>[]> {
      const result = await admin((client) =>
        client.query<{ properties: Record<string, unknown> }>(
          `select properties from objects
           where workspace_id = $1 and object_type = 'Operation'
             and identity_key ->> 'gatekeeperId' = $2 and identity_key ->> 'name' = $3
           order by (properties ->> 'version')::int`,
          [workspaceId, gatekeeperId, name],
        ),
      );
      return result.rows.map((entry) => entry.properties);
    }

    async function auditPayloads(name: string): Promise<Record<string, unknown>[]> {
      const result = await admin((client) =>
        client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
           where workspace_id = $1 and action = 'publish_operation'
             and payload->>'resourceRef' = $2`,
          [workspaceId, `${gatekeeperId}:${name}`],
        ),
      );
      return result.rows.map((entry) => entry.payload);
    }

    async function importDrafts(operations: readonly Operation[]) {
      return admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.import_manifest',
          principalId: ownerId,
        });
        return importManifest(client, workspaceId, {
          gatekeeperId,
          operations,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'absent-answers-review-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
          serviceId = randomUUID();
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'service', 'owner', 'aar-automation')`,
            [workspaceId, serviceId],
          );
        },
        { skipRoleSwitch: true },
      );
      gatekeeperId = await admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'absent-answers-review-gate',
          transportKind: 'http',
          target: 'absent-answers-review-system',
          endpoint: 'https://gate.absent-answers-review-test.invalid/',
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('publish_operation: a declaring draft needs absentAnswersReviewed; the published version and the audit row record who confirmed', async () => {
      const name = `aar.get.${randomUUID().slice(0, 8)}`;
      const { draftDigest } = await call<{ draftDigest: string }>('propose_operation', {
        gatekeeperId,
        operation: lookup(name, [404, 410]),
      });

      for (const absentAnswersReviewed of [undefined, false]) {
        await expect(
          call('publish_operation', {
            gatekeeperId,
            name,
            draftDigest,
            ...(absentAnswersReviewed === undefined ? {} : { absentAnswersReviewed }),
          }),
        ).rejects.toMatchObject({
          name: 'AbsentAnswersReviewRequiredError',
          code: 'absent_answers_review_required',
          details: { absentAnswers: { statuses: [404, 410] } },
        });
      }
      expect((await row(name))?.status).toBe('draft');

      const before = Date.now();
      const published = await call<PublishResult>('publish_operation', {
        gatekeeperId,
        name,
        draftDigest,
        absentAnswersReviewed: true,
      });
      expect(published.status).toBe('published');
      expect(published.absentAnswersReview?.reviewedBy).toBe(ownerId);
      const reviewedAt = Date.parse(published.absentAnswersReview?.reviewedAt ?? '');
      expect(reviewedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(reviewedAt).toBeLessThanOrEqual(Date.now() + 1000);

      const listed = await row(name);
      expect(listed).toMatchObject({
        status: 'published',
        absentAnswers: { statuses: [404, 410] },
        absentAnswersReview: published.absentAnswersReview,
      });
      // Bookkeeping beside the definition, never part of it (agents read the definition).
      const [stored] = await storedProperties(name);
      expect(stored).toMatchObject({
        absentAnswersReviewedBy: ownerId,
        absentAnswersReviewedAt: published.absentAnswersReview?.reviewedAt,
      });
      const live = await admin((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, name),
      );
      expect(live?.operation).not.toHaveProperty('absentAnswersReviewedBy');
      expect(live?.absentAnswersReview).toEqual(published.absentAnswersReview);

      const audits = await auditPayloads(name);
      const confirmed = audits.find((payload) => 'absentAnswersReview' in payload);
      expect(confirmed).toMatchObject({
        params: { absentAnswersReviewed: true },
        absentAnswersReview: { absentAnswers: { statuses: [404, 410] }, confirmed: true },
      });
    });

    it('publish_operation: an Operation declaring nothing needs no confirmation and records none', async () => {
      const name = `aar.plain.${randomUUID().slice(0, 8)}`;
      const { draftDigest } = await call<{ draftDigest: string }>('propose_operation', {
        gatekeeperId,
        operation: lookup(name),
      });
      const published = await call<PublishResult>('publish_operation', {
        gatekeeperId,
        name,
        draftDigest,
      });
      expect(published.status).toBe('published');
      expect(published.absentAnswersReview).toBeNull();
      expect(await row(name)).not.toHaveProperty('absentAnswersReview');
      const [audit] = await auditPayloads(name);
      expect(audit).not.toHaveProperty('absentAnswersReview');
    });

    it('an agent Handle never reaches the confirmation: publish_operation is refused on the Handle channel and can never be in a Handle scope', async () => {
      const name = `aar.handle.${randomUUID().slice(0, 8)}`;
      const { draftDigest } = await call<{ draftDigest: string }>('propose_operation', {
        gatekeeperId,
        operation: lookup(name, [404]),
      });
      await expect(
        dispatchCapability({ pool }, handle(['publish_operation']), 'publish_operation', {
          gatekeeperId,
          name,
          draftDigest,
          absentAnswersReviewed: true,
        }),
      ).rejects.toThrow(/human-channel-only/);
      expect(() =>
        assertValidScope({ capabilities: ['publish_operation'], resources: {} }),
      ).toThrow(ScopeValidationError);
      expect((await row(name))?.status).toBe('draft');
      const [stored] = await storedProperties(name);
      expect(stored).not.toHaveProperty('absentAnswersReviewedBy');
    });

    it('a service Principal’s API key on the human channel cannot confirm either: a service is not a person', async () => {
      const name = `aar.service.${randomUUID().slice(0, 8)}`;
      const { draftDigest } = await call<{ draftDigest: string }>('propose_operation', {
        gatekeeperId,
        operation: lookup(name, [404]),
      });
      await expect(
        dispatchCapability({ pool }, service(), 'publish_operation', {
          gatekeeperId,
          name,
          draftDigest,
          absentAnswersReviewed: true,
        }),
      ).rejects.toThrow(/only a person/);
      expect((await row(name))?.status).toBe('draft');
      const [stored] = await storedProperties(name);
      expect(stored).not.toHaveProperty('absentAnswersReviewedBy');
      // The same service still publishes an Operation that asks for no confirmation.
      const plain = `aar.service-plain.${randomUUID().slice(0, 8)}`;
      const proposed = await call<{ draftDigest: string }>('propose_operation', {
        gatekeeperId,
        operation: lookup(plain),
      });
      const published = await dispatchCapability({ pool }, service(), 'publish_operation', {
        gatekeeperId,
        name: plain,
        draftDigest: proposed.draftDigest,
      });
      expect(published).toMatchObject({ status: 'published', absentAnswersReview: null });
    });

    it('a proposal or a manifest cannot carry a confirmation in: the bookkeeping keys never reach a draft', async () => {
      const smuggled = {
        absentAnswersReviewedBy: ownerId,
        absentAnswersReviewedAt: new Date().toISOString(),
      };
      // The capability parses the Operation; the governance function is called directly too, as
      // a Worker's report reaches it, with the keys still on the object.
      const viaCapability = `aar.smuggle.cap.${randomUUID().slice(0, 8)}`;
      await call('propose_operation', {
        gatekeeperId,
        operation: { ...lookup(viaCapability, [404]), ...smuggled },
      });
      const viaGovernance = `aar.smuggle.gov.${randomUUID().slice(0, 8)}`;
      await admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.propose_operation',
          principalId: ownerId,
        });
        await proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: { ...lookup(viaGovernance, [404]), ...smuggled } as Operation,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
      });
      const viaManifest = `aar.smuggle.man.${randomUUID().slice(0, 8)}`;
      await importDrafts([{ ...lookup(viaManifest, [404]), ...smuggled } as Operation]);

      for (const name of [viaCapability, viaGovernance, viaManifest]) {
        const [stored] = await storedProperties(name);
        expect(stored).toMatchObject({ status: 'draft' });
        expect(stored).not.toHaveProperty('absentAnswersReviewedBy');
        expect(stored).not.toHaveProperty('absentAnswersReviewedAt');
        // Still a declaration nobody confirmed: an internal publish (no person) refuses it.
        await expect(
          admin((client) => publishOperation(client, workspaceId, { gatekeeperId, name })),
        ).rejects.toMatchObject({ code: 'absent_answers_review_required' });
        const listed = await row(name);
        expect(listed?.status).toBe('draft');
        await expect(
          call('publish_operation', { gatekeeperId, name, draftDigest: listed?.draftDigest }),
        ).rejects.toMatchObject({ code: 'absent_answers_review_required' });
      }
    });

    it('publish_manifest and enable-time publishing leave a declaring draft for a person, and publish the rest', async () => {
      const declaring = `aar.bulk.get.${randomUUID().slice(0, 8)}`;
      const plain = `aar.bulk.list.${randomUUID().slice(0, 8)}`;
      await importDrafts([lookup(declaring, [404]), lookup(plain)]);
      const listed = await call<{ items: OperationRow[] }>('list_operations', { gatekeeperId });
      const drafts = listed.items
        .filter((item) => item.status === 'draft' && [declaring, plain].includes(item.name))
        .map((item) => ({ name: item.name, draftDigest: item.draftDigest }));
      expect(drafts).toHaveLength(2);

      const published = await call<{
        publishedOperationNames: string[];
        absentAnswerDrafts: { name: string; absentAnswers: unknown }[];
      }>('publish_manifest', { gatekeeperId, drafts });
      expect(published.publishedOperationNames).toContain(plain);
      expect(published.publishedOperationNames).not.toContain(declaring);
      // (Also the earlier test's manifest draft, still held: every declaring import draft is.)
      expect(published.absentAnswerDrafts).toContainEqual({
        name: declaring,
        absentAnswers: { statuses: [404] },
      });
      expect(published.absentAnswerDrafts.map((draft) => draft.name)).not.toContain(plain);
      expect((await row(declaring))?.status).toBe('draft');

      // The landing's path (`enable_gate_instance`): the same hold.
      const landed = `aar.land.get.${randomUUID().slice(0, 8)}`;
      const landedPlain = `aar.land.list.${randomUUID().slice(0, 8)}`;
      const imported = await importDrafts([lookup(landed, [410]), lookup(landedPlain)]);
      const held = await admin((client) =>
        publishImportedDrafts(client, workspaceId, gatekeeperId, imported.imported),
      );
      expect(held.publishedOperationNames).toEqual([landedPlain]);
      expect(held.absentAnswerDrafts).toEqual([
        { name: landed, absentAnswers: { statuses: [410] } },
      ]);

      // A person then publishes the held draft, confirming.
      const heldRow = await row(declaring);
      const confirmed = await call<PublishResult>('publish_operation', {
        gatekeeperId,
        name: declaring,
        draftDigest: heldRow?.draftDigest,
        absentAnswersReviewed: true,
      });
      expect(confirmed.absentAnswersReview?.reviewedBy).toBe(ownerId);
    });

    it('a ChangePlan revision keeps the definition and so carries its live version’s confirmation — or its lack', async () => {
      const name = `aar.rev.${randomUUID().slice(0, 8)}`;
      const { draftDigest } = await call<{ draftDigest: string }>('propose_operation', {
        gatekeeperId,
        operation: lookup(name, [404]),
      });
      const first = await call<PublishResult>('publish_operation', {
        gatekeeperId,
        name,
        draftDigest,
        absentAnswersReviewed: true,
      });

      const revise = (blastRadius: Operation['blast_radius']) =>
        admin(async (client) => {
          await lockOperationRevision(client, workspaceId);
          const live = await getPublishedOperation(client, workspaceId, gatekeeperId, name);
          if (!live) throw new Error('no live version');
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.change_plan_apply',
            principalId: ownerId,
          });
          return publishOperationRevision(client, workspaceId, {
            gatekeeperId,
            name,
            replaces: {
              version: live.version,
              contentDigest: operationContentDigest(live.operation),
            },
            operation: { ...live.operation, blast_radius: blastRadius },
            publishedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          });
        });

      const second = await revise('medium');
      expect(second.version).toBe(first.version + 1);
      expect(second.absentAnswersReview).toEqual(first.absentAnswersReview);
      expect((await row(name))?.absentAnswersReview).toEqual(first.absentAnswersReview);

      // A live version published before the confirmation existed has none to carry: the revision
      // goes ahead (its definition is unchanged) and records none.
      await admin((client) =>
        client.query(
          `update objects
           set properties = properties - 'absentAnswersReviewedBy' - 'absentAnswersReviewedAt'
           where workspace_id = $1 and object_type = 'Operation'
             and identity_key ->> 'gatekeeperId' = $2 and identity_key ->> 'name' = $3
             and properties ->> 'status' = 'published'`,
          [workspaceId, gatekeeperId, name],
        ),
      );
      const third = await revise('low');
      expect(third.status).toBe('published');
      expect(third).not.toHaveProperty('absentAnswersReview');
      expect(await row(name)).not.toHaveProperty('absentAnswersReview');
    });
  },
);
