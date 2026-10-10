import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Operation, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { requestAction } from '../../governance/approval/index.js';
import { proposeOperation, registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/credential-review.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) end-to-end coverage, through `dispatchCapability`, of decision 2026-10-09 "二次确认"
 * (governance/redaction/credential-review.ts): content carrying suspected credentials takes effect
 * only with the caller's explicit `credentialsReviewed: true`, counted on the server, recorded in
 * the audit row — on `approve` (an ActionRequest's params) and on `publish_*` (a draft; Skill and
 * Operation here, the two a Worker proposes). A request whose params carry one also never
 * auto-approves.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

interface ActionRequestWire {
  id: string;
  status: string;
  suspectedSecretValues?: number;
  suspectedSecretPaths?: string[];
}

describe.runIf(DATABASE_URL !== undefined)(
  'credential review — approve / publish_* confirm suspected credentials (integration, real Postgres)',
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

    function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
      return dispatchCapability({ pool }, owner(), name, params) as Promise<T>;
    }

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function seedPending(params: Record<string, unknown>): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into action_requests
             (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
              policy_decision, await_decision, on_behalf_of, actor_runtime, requester_can_approve,
              params)
           values ($1, $2, 'pending_approval', $3::uuid, 'cr.test.action', $3::text, 'medium',
                   'require_approval', false, $4, 'pi', true, $5::jsonb)`,
          [workspaceId, id, gatekeeperId, ownerId, JSON.stringify(params)],
        ),
      );
      return id;
    }

    /** Audit rows of `action` about `ref`: the resource id, or — for a resource whose id is not a
     *  uuid, such as an Operation's `gatekeeperId:name` — the payload's `resourceRef`. */
    async function auditPayloads(action: string, ref: string): Promise<Record<string, unknown>[]> {
      const result = await admin((client) =>
        client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
           where workspace_id = $1 and action = $2
             and (resource_id::text = $3 or payload->>'resourceRef' = $3)`,
          [workspaceId, action, ref],
        ),
      );
      return result.rows.map((row) => row.payload);
    }

    function testOperation(name: string, description: string): Operation {
      return {
        name,
        description,
        binding: { kind: 'http', method: 'POST', path: '/rotate' },
        params_schema: { type: 'object', properties: { password: { type: 'string' } } },
        mode: 'execute',
        blast_radius: 'medium',
        reversibility: false,
        auto_approvable: false,
        await_decision: false,
        reads: [],
        writes: [],
      };
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
            'credential-review-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      gatekeeperId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.register_gatekeeper',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: 'credential-review-gate',
            transportKind: 'http',
            target: 'credential-review-system',
            endpoint: 'https://gate.credential-review-test.invalid/',
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          return registered.gatekeeperId;
        },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('approve: the wire row shows the count; without the confirmation the row stays pending; with it the decision and audit record it', async () => {
      const id = await seedPending({ user: 'ops', password: FAKE, cmd: `PGPASSWORD=${FAKE} psql` });

      const pending = await call<ActionRequestWire>('get_action', { actionRequestId: id });
      expect(pending.suspectedSecretValues).toBe(2);
      expect([...(pending.suspectedSecretPaths ?? [])].sort()).toEqual(['cmd', 'password']);

      for (const credentialsReviewed of [undefined, false]) {
        await expect(
          call('approve', {
            actionRequestId: id,
            ...(credentialsReviewed === undefined ? {} : { credentialsReviewed }),
          }),
        ).rejects.toMatchObject({
          name: 'CredentialReviewRequiredError',
          code: 'credentials_review_required',
          details: { subject: 'action_request', suspectedSecretValues: 2 },
        });
      }
      const still = await call<ActionRequestWire>('get_action', { actionRequestId: id });
      expect(still.status).toBe('pending_approval');

      const approved = await call<ActionRequestWire & { approvalDecisionId: string }>('approve', {
        actionRequestId: id,
        credentialsReviewed: true,
      });
      expect(approved.status).toBe('approved');

      const [transition] = await auditPayloads('action_request.approve', id);
      expect(transition).toMatchObject({
        resultingStatus: 'approved',
        credentialReview: { suspectedSecretValues: 2, confirmed: true },
      });
      const rationale = await admin((client) =>
        client.query<{ rationale: Record<string, unknown>; decided_by: string }>(
          'select rationale, decided_by from decisions where workspace_id = $1 and id = $2',
          [workspaceId, approved.approvalDecisionId],
        ),
      );
      expect(rationale.rows[0]).toMatchObject({
        decided_by: ownerId,
        rationale: { credentialReview: { suspectedSecretValues: 2, confirmed: true } },
      });
    });

    it('approve: a row with nothing suspect has no count and needs no confirmation', async () => {
      const id = await seedPending({ host: 'db.example.invalid', max_tokens: 1024 });
      const pending = await call<ActionRequestWire>('get_action', { actionRequestId: id });
      expect(pending).not.toHaveProperty('suspectedSecretValues');
      expect(pending).not.toHaveProperty('suspectedSecretPaths');
      const approved = await call<ActionRequestWire>('approve', { actionRequestId: id });
      expect(approved.status).toBe('approved');
      const [transition] = await auditPayloads('action_request.approve', id);
      expect(transition).not.toHaveProperty('credentialReview');
    });

    it('approve / reject: a credential pasted into the reason never reaches an audit row', async () => {
      for (const [capability, action] of [
        ['approve', 'action_request.approve'],
        ['reject', 'action_request.reject'],
      ] as const) {
        const id = await seedPending({ host: 'db.example.invalid' });
        await call(capability, { actionRequestId: id, reason: `rotated, PGPASSWORD=${FAKE} now` });

        const [transition] = await auditPayloads(action, id);
        expect(transition?.reason).toBe('rotated, PGPASSWORD=[redacted] now');
        const dispatched = await admin((client) =>
          client.query<{ payload: { params: { reason?: string }; redactedValues?: number } }>(
            `select payload from audit_records
             where workspace_id = $1 and action = $2 and payload->'params'->>'actionRequestId' = $3`,
            [workspaceId, capability, id],
          ),
        );
        expect(dispatched.rows[0]?.payload.params.reason).toBe(
          'rotated, PGPASSWORD=[redacted] now',
        );
        expect(dispatched.rows[0]?.payload.redactedValues).toBe(1);
      }
    });

    it('request_action: params carrying a suspected credential never auto-approve', async () => {
      const scope: CapabilityScope = {
        capabilities: ['request_action'],
        resources: { gatekeeper: [gatekeeperId] },
      };
      const request = (params: Record<string, unknown>) =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'cr.test.auto',
            blastRadius: 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            params,
            requesterScope: scope,
          }),
        );
      expect((await request({ query: 'stock' })).status).toBe('auto_approved');
      const suspect = await request({ query: 'stock', apiKey: FAKE });
      expect(suspect.status).toBe('pending_approval');
      expect(suspect.policyDecision).toBe('require_approval');
    });

    it('publish_skill: a draft with a suspected credential publishes only once confirmed, and the audit row says so', async () => {
      const proposed = await call<{ id: string }>('propose_skill', {
        skill: {
          name: `cr-skill-${randomUUID().slice(0, 8)}`,
          description: 'Rotates the staging password.',
          markdown: `# Steps\n\nRun \`psql --password ${FAKE}\` first.`,
        },
      });
      await expect(call('publish_skill', { skillId: proposed.id })).rejects.toMatchObject({
        code: 'credentials_review_required',
        details: { subject: 'skill', suspectedSecretValues: 1, suspectedSecretPaths: ['markdown'] },
      });
      const published = await call<{ status: string }>('publish_skill', {
        skillId: proposed.id,
        credentialsReviewed: true,
      });
      expect(published.status).toBe('published');
      const [audit] = await auditPayloads('publish_skill', proposed.id);
      expect(audit).toMatchObject({
        params: { skillId: proposed.id, credentialsReviewed: true },
        credentialReview: { suspectedSecretValues: 1, confirmed: true },
      });
    });

    it('publish_operation: values in the definition count, a schema property named password does not', async () => {
      const clean = `cr.op.${randomUUID().slice(0, 8)}`;
      await call('propose_operation', {
        gatekeeperId,
        operation: testOperation(clean, 'Rotates a password.'),
      });
      const cleanPublished = await call<{ status: string }>('publish_operation', {
        gatekeeperId,
        name: clean,
      });
      expect(cleanPublished.status).toBe('published');

      const suspect = `cr.op.${randomUUID().slice(0, 8)}`;
      await call('propose_operation', {
        gatekeeperId,
        operation: testOperation(suspect, `Calls the API with X-Api-Key: ${FAKE}`),
      });
      await expect(
        call('publish_operation', { gatekeeperId, name: suspect }),
      ).rejects.toMatchObject({
        code: 'credentials_review_required',
        details: { subject: 'operation', suspectedSecretValues: 1 },
      });
      const published = await call<{ status: string }>('publish_operation', {
        gatekeeperId,
        name: suspect,
        credentialsReviewed: true,
      });
      expect(published.status).toBe('published');
      const [audit] = await auditPayloads('publish_operation', `${gatekeeperId}:${suspect}`);
      expect(audit).toMatchObject({
        credentialReview: { suspectedSecretValues: 1, confirmed: true },
      });
    });

    it('publish_operation: a proposer revising the draft in place while the publish runs cannot slip unchecked content through', async () => {
      const name = `cr.op.${randomUUID().slice(0, 8)}`;
      await call('propose_operation', { gatekeeperId, operation: testOperation(name, 'Clean.') });

      // Revision transaction: rewrites the same draft (same version) with a credential and holds
      // its row lock until released.
      let revised!: () => void;
      const revisedP = new Promise<void>((resolve) => {
        revised = resolve;
      });
      let release!: () => void;
      const releaseP = new Promise<void>((resolve) => {
        release = resolve;
      });
      const revision = withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.revise_operation',
            principalId: ownerId,
          });
          await proposeOperation(client, workspaceId, {
            gatekeeperId,
            operation: testOperation(name, `Now with X-Api-Key: ${FAKE}`),
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          });
          revised();
          await releaseP;
        },
      );
      await revisedP;

      // The publish starts while the revision is uncommitted: it must wait for that row, then see
      // (and count) the revised content — not publish it on the strength of the clean read.
      const publish = call('publish_operation', { gatekeeperId, name }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = await pool.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if ((waiting.rows[0]?.n ?? 0) > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await revision;

      const outcome = await publish;
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? null : outcome.error).toMatchObject({
        code: 'credentials_review_required',
        details: { subject: 'operation', suspectedSecretValues: 1 },
      });
      const status = await admin((client) =>
        client.query<{ status: string }>(
          `select properties ->> 'status' as status from objects
           where workspace_id = $1 and object_type = 'Operation'
             and identity_key ->> 'gatekeeperId' = $2 and identity_key ->> 'name' = $3`,
          [workspaceId, gatekeeperId, name],
        ),
      );
      expect(status.rows.map((row) => row.status)).toEqual(['draft']);
    });
  },
);
