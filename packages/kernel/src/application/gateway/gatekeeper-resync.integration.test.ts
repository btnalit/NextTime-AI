import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  HttpTransport,
  InMemoryIdempotencyStore,
  SharedEnvCredentialResolver,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
import type {
  Operation,
  PreviewGatekeeperResyncResultWire,
  RefreshOperationGovernanceResultWire,
  Role,
} from '@nexttime/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  GatekeeperClientError,
  HttpGatekeeperClient,
  createGateConnectionSecrets,
} from '../../adapters/gatekeeper-client/index.js';
import { createOutboundTargetGuard } from '../../adapters/outbound-target/index.js';
import {
  getOperation,
  getPublishedOperation,
  operationRecordDigest,
  publishOperation,
} from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { insertGateLink, upsertAnnouncement } from '../gates/index.js';
import { setConnectionHandlerDeps } from './connection-handlers.js';
import { dispatchCapability } from './dispatch.js';
import { GateInstanceNotAvailableError } from './gate-instance-handlers.js';
import { resolveGateTarget } from './gate-target.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/gatekeeper-resync.integration.test (legacy 214): a gate the workspace
 * connected itself is rebuilt with another definition — the kernel's calls under the published one
 * are refused (409 `operation_definition_mismatch`, legacy K) — and the workspace re-syncs it in
 * the product: `preview_gatekeeper_resync` re-describes the gate and shows the diff,
 * `refresh_operation_governance` opens the revision (and imports what is new), and once the
 * revision is published the same call runs again. Real Postgres, a real
 * `@nexttime/gatekeeper-base` gate on loopback holding the connection secret (as
 * connection-flow.integration.test.ts), restarted on the same port to stand for the rebuild.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const GATE_TEST_TOKEN = 'gate-resync-test-token-0123456789abcdef';
const CONNECTION_SECRETS = createGateConnectionSecrets(GATE_TEST_TOKEN);

function stockOperation(name: string, pathName: string, overrides: Partial<Operation> = {}) {
  return {
    name,
    description: `Lists stock (${pathName}).`,
    binding: { kind: 'http', method: 'GET', path: pathName },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  } as Operation;
}

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 214: self-connected gate resync (integration, real Postgres + real gate)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let target: FastifyInstance;
    let targetEndpoint: string;
    let gateApp: FastifyInstance | undefined;
    let gatePort: number;
    let gateEndpoint: string;
    let connectionSecret: string;
    let client: HttpGatekeeperClient;

    function owner(): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: ownerId, kind: 'human', role: 'owner', displayName: null },
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

    async function inTx<T>(fn: Parameters<typeof withWorkspace<T>>[2]): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function adminInsert(sql: string, values: unknown[], asWorkspace: string) {
      await withWorkspace(
        pool,
        { workspaceId: asWorkspace, principalId: randomUUID() },
        (c) => c.query(sql, values),
        { skipRoleSwitch: true },
      );
    }

    /** (Re)starts the gate on the same port with `manifest` — the rebuilt gate keeps its address
     *  and its connection secret, only what it runs changes. */
    async function startGate(manifest: readonly Operation[]): Promise<void> {
      if (gateApp) await gateApp.close();
      const gate = new GatekeeperBase({
        manifest,
        transport: new HttpTransport({ baseUrl: targetEndpoint }),
        credentialResolver: new SharedEnvCredentialResolver({
          env: { GATE_CREDENTIAL_DEFAULT: 'target-credential' },
        }),
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      gateApp = createGatekeeperServer({ gate, token: connectionSecret });
      await gateApp.listen({ port: gatePort, host: '127.0.0.1' });
      gatePort = (gateApp.server.address() as AddressInfo).port;
      gateEndpoint = `http://127.0.0.1:${gatePort}`;
    }

    /** What the kernel sends for a published Operation: its approved definition's digest. */
    async function observePublished(gatekeeperId: string, name: string) {
      const published = await inTx((c) =>
        getPublishedOperation(c, workspaceId, gatekeeperId, name),
      );
      if (!published) throw new Error(`${name} is not published`);
      const gatekeeper = await inTx((c) =>
        c.query<{ properties: { endpoint: string; connectionSecretSalt?: string } }>(
          "select properties from objects where workspace_id = $1 and id = $2 and object_type = 'Gatekeeper'",
          [workspaceId, gatekeeperId],
        ),
      );
      const props = gatekeeper.rows[0]?.properties;
      if (!props) throw new Error('gatekeeper row missing');
      const gateTarget = await inTx((c) =>
        resolveGateTarget(c, workspaceId, {
          endpoint: props.endpoint,
          connectionSecretSalt: props.connectionSecretSalt,
        }),
      );
      return client.observe(gateTarget, {
        operation: name,
        params: {},
        operationDigest: operationRecordDigest(published),
      });
    }

    /** A new self-connected gate: its own connection secret (one per connection, R-01). */
    async function startNewGate(manifest: readonly Operation[]): Promise<void> {
      connectionSecret = CONNECTION_SECRETS.mint(workspaceId).secret;
      await startGate(manifest);
    }

    async function connect(): Promise<string> {
      const result = await call<{ gatekeeperId: string; importedOperationNames: string[] }>(
        'create_connection',
        {
          kind: 'http',
          target: `stock-system-${randomUUID().slice(0, 8)}`,
          endpoint: gateEndpoint,
          connectionSecret,
          credentialKind: 'shared',
        },
      );
      for (const name of result.importedOperationNames) {
        await inTx((c) =>
          publishOperation(c, workspaceId, { gatekeeperId: result.gatekeeperId, name }),
        );
      }
      return result.gatekeeperId;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await adminInsert(
        'insert into workspaces (id, name) values ($1, $2)',
        [workspaceId, 'gatekeeper-resync-test'],
        workspaceId,
      );
      await adminInsert(
        'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
        [workspaceId, ownerId, 'human', 'owner' satisfies Role, 'owner'],
        workspaceId,
      );

      target = Fastify({ logger: false });
      target.get('/stocks', async () => ({ items: [{ sku: 'v1' }] }));
      target.get('/v2/stocks', async () => ({ items: [{ sku: 'v2' }] }));
      target.get('/count', async () => ({ count: 1 }));
      await target.listen({ port: 0, host: '127.0.0.1' });
      targetEndpoint = `http://127.0.0.1:${(target.server.address() as AddressInfo).port}`;

      gatePort = 0;
      const outboundTargetGuard = createOutboundTargetGuard({
        policy: { platformSubnets: [], allowHosts: ['127.0.0.1'] },
      });
      client = new HttpGatekeeperClient({ token: GATE_TEST_TOKEN, outboundTargetGuard });
      setConnectionHandlerDeps({
        gatekeeperClient: client,
        connectionSecrets: CONNECTION_SECRETS,
        outboundTargetGuard,
      });
    });

    afterAll(async () => {
      await gateApp?.close();
      await target.close();
      await pool.end();
    });

    it('a rebuilt gate is re-synced in the product: preview → open revisions → publish → calls run again', async () => {
      const listName = `stock.list.${randomUUID().slice(0, 8)}`;
      const countName = `stock.count.${randomUUID().slice(0, 8)}`;
      const goneName = `stock.gone.${randomUUID().slice(0, 8)}`;
      await startNewGate([
        stockOperation(listName, '/stocks'),
        stockOperation(goneName, '/stocks'),
      ]);
      const gatekeeperId = await connect();
      expect((await observePublished(gatekeeperId, listName)).data).toEqual({
        items: [{ sku: 'v1' }],
      });

      // Rebuilt: another path for one Operation, a new one, and one dropped.
      await startGate([
        stockOperation(listName, '/v2/stocks'),
        stockOperation(countName, '/count'),
      ]);
      const refused = await observePublished(gatekeeperId, listName).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(GatekeeperClientError);
      expect((refused as GatekeeperClientError).code).toBe('operation_definition_mismatch');

      const preview = await call<PreviewGatekeeperResyncResultWire>('preview_gatekeeper_resync', {
        gatekeeperId,
      });
      expect(preview.operationsAlreadyPresent).toEqual([
        expect.objectContaining({ name: listName, definitionDiffers: true, differs: false }),
      ]);
      expect(preview.operationsToImport).toEqual([
        expect.objectContaining({ name: countName, mode: 'observe' }),
      ]);
      expect(preview.operationsToImport[0]?.pendingDraft).toBeUndefined();
      expect(preview.notDescribed).toEqual([goneName]);

      // Nothing written by the preview.
      expect(await inTx((c) => getOperation(c, workspaceId, gatekeeperId, countName))).toBeNull();

      const result = await call<RefreshOperationGovernanceResultWire>(
        'refresh_operation_governance',
        {
          gatekeeperId,
          operationNames: [listName, countName],
          manifestDigest: preview.manifestDigest,
        },
      );
      expect(result.refreshed).toEqual([]);
      expect(result.revisionDrafts).toEqual(
        expect.arrayContaining([
          { name: listName, version: 2 },
          { name: countName, version: 1 },
        ]),
      );
      expect(result.revisionDrafts).toHaveLength(2);

      // Still refused until the owner publishes — the drafts are not live.
      await expect(observePublished(gatekeeperId, listName)).rejects.toBeInstanceOf(
        GatekeeperClientError,
      );
      const audit = await inTx((c) =>
        queryAudit(c, workspaceId, { action: 'operation.revision_drafted' }),
      );
      const reasons = audit
        .filter((row) => (row.payload as { gatekeeperId?: string }).gatekeeperId === gatekeeperId)
        .map((row) => [
          (row.payload as { name: string }).name,
          (row.payload as { reason: string }).reason,
        ]);
      expect(reasons).toEqual(
        expect.arrayContaining([
          [listName, 'definition_changed'],
          [countName, 'new_on_gate'],
        ]),
      );

      await inTx((c) => publishOperation(c, workspaceId, { gatekeeperId, name: listName }));
      await inTx((c) => publishOperation(c, workspaceId, { gatekeeperId, name: countName }));
      expect((await observePublished(gatekeeperId, listName)).data).toEqual({
        items: [{ sku: 'v2' }],
      });
      expect((await observePublished(gatekeeperId, countName)).data).toEqual({ count: 1 });

      // In step with the gate now: nothing left to open.
      const after = await call<PreviewGatekeeperResyncResultWire>('preview_gatekeeper_resync', {
        gatekeeperId,
      });
      expect(
        after.operationsAlreadyPresent.every((op) => !op.definitionDiffers && !op.differs),
      ).toBe(true);
      expect(after.operationsToImport).toEqual([]);
    });

    // Review #493 on #612 (M1): nobody reviewed a self-connected gate's own description, so what it
    // loosens never lands on the published Operation in place — the resync opens a revision, and
    // only the owner's publish of it changes who may call what. One case per loosened field.
    const strict = { mode: 'execute', blast_radius: 'high', auto_approvable: false } as const;
    it.each([
      {
        field: 'mode execute → observe',
        before: strict,
        after: { ...strict, mode: 'observe' },
        direction: 'loosened',
        // `mode` is part of the definition the gate checks (legacy K).
        reason: 'definition_changed',
      },
      {
        field: 'blast_radius high → low',
        before: strict,
        after: { ...strict, blast_radius: 'low' },
        direction: 'loosened',
        reason: 'governance_loosened',
      },
      {
        field: 'auto_approvable false → true',
        before: strict,
        after: { ...strict, auto_approvable: true },
        direction: 'loosened',
        reason: 'governance_loosened',
      },
      {
        field: 'mixed (blast_radius low → high, auto_approvable false → true)',
        before: { ...strict, blast_radius: 'low' },
        after: { ...strict, blast_radius: 'high', auto_approvable: true },
        direction: 'mixed',
        reason: 'governance_loosened',
      },
    ] as const)(
      'a loosened $field opens a revision; the published Operation keeps its fields until the owner publishes it',
      async ({ before, after, direction, reason }) => {
        const name = `stock.loosen.${randomUUID().slice(0, 8)}`;
        await startNewGate([stockOperation(name, '/stocks', before)]);
        const gatekeeperId = await connect();
        await startGate([stockOperation(name, '/stocks', after)]);

        const preview = await call<PreviewGatekeeperResyncResultWire>('preview_gatekeeper_resync', {
          gatekeeperId,
        });
        expect(preview.operationsAlreadyPresent).toEqual([
          expect.objectContaining({ name, differs: true, direction, governanceByRevision: true }),
        ]);

        const result = await call<RefreshOperationGovernanceResultWire>(
          'refresh_operation_governance',
          { gatekeeperId, manifestDigest: preview.manifestDigest },
        );
        expect(result.refreshed).toEqual([]);
        expect(result.revisionDrafts).toEqual([{ name, version: 2 }]);

        const live = await inTx((c) => getPublishedOperation(c, workspaceId, gatekeeperId, name));
        expect(live?.version).toBe(1);
        expect(live?.operation.mode).toBe(before.mode);
        expect(live?.operation.blast_radius).toBe(before.blast_radius);
        expect(live?.operation.auto_approvable).toBe(before.auto_approvable);
        const audit = await inTx((c) =>
          queryAudit(c, workspaceId, { action: 'operation.revision_drafted' }),
        );
        expect(
          audit
            .map((row) => row.payload as { name?: string })
            .filter((payload) => payload.name === name),
        ).toEqual([expect.objectContaining({ reason, governanceDirection: direction })]);
        const refreshedAudit = await inTx((c) =>
          queryAudit(c, workspaceId, { action: 'operation.governance_refreshed' }),
        );
        expect(refreshedAudit.some((row) => (row.payload as { name?: string }).name === name)).toBe(
          false,
        );

        await inTx((c) => publishOperation(c, workspaceId, { gatekeeperId, name }));
        const published = await inTx((c) =>
          getPublishedOperation(c, workspaceId, gatekeeperId, name),
        );
        expect(published?.version).toBe(2);
        expect(published?.operation.mode).toBe(after.mode);
        expect(published?.operation.blast_radius).toBe(after.blast_radius);
        expect(published?.operation.auto_approvable).toBe(after.auto_approvable);
      },
    );

    it('a tightening the gate describes is still applied in place — no revision, no new version', async () => {
      const name = `stock.tighten.${randomUUID().slice(0, 8)}`;
      await startNewGate([stockOperation(name, '/stocks')]);
      const gatekeeperId = await connect();
      await startGate([
        stockOperation(name, '/stocks', { blast_radius: 'medium', auto_approvable: false }),
      ]);

      const preview = await call<PreviewGatekeeperResyncResultWire>('preview_gatekeeper_resync', {
        gatekeeperId,
      });
      const row = preview.operationsAlreadyPresent[0];
      expect(row).toEqual(expect.objectContaining({ name, differs: true, direction: 'tightened' }));
      expect(row?.governanceByRevision).toBeUndefined();

      const result = await call<RefreshOperationGovernanceResultWire>(
        'refresh_operation_governance',
        { gatekeeperId, manifestDigest: preview.manifestDigest },
      );
      expect(result.revisionDrafts).toEqual([]);
      expect(result.refreshed).toEqual([expect.objectContaining({ name, direction: 'tightened' })]);
      const live = await inTx((c) => getPublishedOperation(c, workspaceId, gatekeeperId, name));
      expect(live?.version).toBe(1);
      expect(live?.operation.blast_radius).toBe('medium');
      expect(live?.operation.auto_approvable).toBe(false);
    });

    it('the gate describing another manifest between preview and confirm refuses manifest_changed and writes nothing', async () => {
      const name = `stock.race.${randomUUID().slice(0, 8)}`;
      await startNewGate([stockOperation(name, '/stocks')]);
      const gatekeeperId = await connect();
      await startGate([stockOperation(name, '/v2/stocks')]);
      const preview = await call<PreviewGatekeeperResyncResultWire>('preview_gatekeeper_resync', {
        gatekeeperId,
      });
      await startGate([stockOperation(name, '/count')]);

      const thrown = await call('refresh_operation_governance', {
        gatekeeperId,
        manifestDigest: preview.manifestDigest,
      }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(GateInstanceNotAvailableError);
      expect((thrown as GateInstanceNotAvailableError).code).toBe('manifest_changed');
      const current = await inTx((c) => getOperation(c, workspaceId, gatekeeperId, name));
      expect(current?.status).toBe('published');
      expect(current?.version).toBe(1);
    });

    it('a Gatekeeper enabled from a platform gate instance is refused gatekeeper_linked — it aligns to the adopted manifest', async () => {
      const name = `stock.linked.${randomUUID().slice(0, 8)}`;
      await startNewGate([stockOperation(name, '/stocks')]);
      const gatekeeperId = await connect();
      const gateId = `resync-linked-${randomUUID().slice(0, 8)}`;
      await withWorkspace(
        pool,
        {
          workspaceId: '00000000-0000-0000-0000-000000000000',
          principalId: '00000000-0000-0000-0000-000000000000',
        },
        (c) =>
          upsertAnnouncement(
            c,
            {
              gateId,
              connector: 'http',
              transportKind: 'http',
              endpoint: `https://gate-${randomUUID()}.example.invalid`,
              operations: [stockOperation(name, '/stocks')],
            },
            'gate',
          ),
        { skipRoleSwitch: true },
      );
      await inTx((c) =>
        insertGateLink(c, {
          workspaceId,
          gateId,
          gatekeeperObjectId: gatekeeperId,
          enabledBy: ownerId,
        }),
      );

      const thrown = await call('preview_gatekeeper_resync', { gatekeeperId }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(GateInstanceNotAvailableError);
      expect((thrown as GateInstanceNotAvailableError).code).toBe('gatekeeper_linked');
    });
  },
);
