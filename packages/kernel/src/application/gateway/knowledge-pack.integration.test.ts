import { randomUUID } from 'node:crypto';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer as createHttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  HttpTransport,
  InMemoryIdempotencyStore,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
import type {
  ChangeVerificationWire,
  EnableGateInstanceResultWire,
  HandleClaims,
  Operation,
  PackInstallPreviewWire,
  PackInstallResultWire,
} from '@nexttime/shared';
import { internalAuthorizationHeader } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HttpGatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { createOutboundTargetGuard } from '../../adapters/outbound-target/index.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { ApprovalDrainer } from '../../governance/approval/index.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { deriveInternalCredential } from '../../interfaces/internal-auth/index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { PackDependencyUnmetError, derivePackComponentId } from '../packs/index.js';
import { invokeWorker, readWorkerRunRow } from '../task/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { loadPublishedWorkerDefinitionHead } from '../worker/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { setGatekeeperReadHandlerDeps } from './gatekeeper-read-handlers.js';
import { setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/knowledge-pack.integration.test: the acceptance of the knowledge pack v1
 * (S11 P1-F2) end to end, against a fake RAGFlow — every step a person takes, through the same
 * capabilities the console calls:
 *   1. a platform administrator creates a gate-host instance from the RAGFlow connector preset
 *      (address only) and enables it; the host builds it from the preset's Operations (here a
 *      real `GatekeeperBase` with the http transport and the preset's own Operations, holding the
 *      RAGFlow API key the way the host does) and announces it;
 *   2. the workspace owner connects it;
 *   3. installing the knowledge pack is refused while the pack it builds on (ops-assets v2: the
 *      KnowledgeBase / Document types) is missing; once ops-assets is installed, the knowledge
 *      pack installs, its Worker bound to the RAGFlow gate, and the install verifies;
 *   4. the pack's Worker, invoked like any Worker, lists the knowledge bases, their documents and
 *      searches them through `observe_operation` — the RAGFlow answers come back, the knowledge
 *      bases land in the graph as the ontology's KnowledgeBase objects, and the key reaches RAGFlow
 *      from the gate only;
 *   5. it cannot parse a document: an execute-class Operation never runs through
 *      `observe_operation`, and the Worker holds no tool that runs one.
 * Private database (the connector catalog is platform-wide, and this file creates `ragflow` in
 * it), same scaffolding as connector-presets.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');
const INTERNAL_TOKEN = 'p1f2-knowledge-internal-token-0123456789abcdef0123456789';
const GATE_TOKEN = 'p1f2-knowledge-gate-token-0123456789abcdef0123456789abcd';
const PASSWORD = 'correct horse battery staple';
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const RAGFLOW_KEY = 'ragflow-abcdefghijklmnopqrstuvwxyz0123';
const GATE_ID = 'kb-main';

interface RagflowCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A RAGFlow of one knowledge base and one document: the three read endpoints the preset's
 *  observe Operations bind, in RAGFlow's `{code, data}` envelope, behind its API key. */
function fakeRagflow(): { server: Server; calls: RagflowCall[] } {
  const calls: RagflowCall[] = [];
  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      calls.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization,
        body: text.length > 0 ? JSON.parse(text) : undefined,
      });
      if (req.headers.authorization !== `Bearer ${RAGFLOW_KEY}`) {
        answer(res, 401, { code: 109, message: 'Authentication error: API key is invalid!' });
        return;
      }
      const route = `${req.method} ${url.split('?')[0]}`;
      if (route === 'GET /api/v1/datasets') {
        answer(res, 200, {
          code: 0,
          data: [
            {
              id: 'ds-runbooks',
              name: '运维手册',
              chunk_count: 12,
              document_count: 1,
              embedding_model: 'bge-m3',
              chunk_method: 'naive',
            },
          ],
        });
        return;
      }
      if (route === 'GET /api/v1/datasets/ds-runbooks/documents') {
        answer(res, 200, {
          code: 0,
          data: {
            total: 1,
            docs: [
              { id: 'doc-backup', name: 'backup.md', size: 2048, run: 'DONE', chunk_count: 12 },
            ],
          },
        });
        return;
      }
      if (route === 'POST /api/v1/retrieval') {
        answer(res, 200, {
          code: 0,
          data: {
            total: 1,
            chunks: [
              {
                id: 'chunk-1',
                content: '数据库每天 02:00 全量备份，保留 14 天。',
                document_id: 'doc-backup',
                document_keyword: 'backup.md',
                dataset_id: 'ds-runbooks',
                similarity: 0.91,
              },
            ],
          },
        });
        return;
      }
      answer(res, 404, { code: 102, message: `no route ${route}` });
    });
  });
  return { server, calls };
}

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.13',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.13' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    return this.statuses.delete(workerRunId);
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }
}

async function waitForNoConnections(cluster: Pool, name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await cluster.query<{ n: string }>(
      'select count(*)::text as n from pg_stat_activity where datname = $1',
      [name],
    );
    if (rows[0]?.n === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createIsolatedDatabase(): Promise<{ pool: Pool; drop: () => Promise<void> }> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  const name = `nexttime_knowledge_pack_${randomUUID().replace(/-/g, '')}`;
  try {
    await cluster.query(`create database "${name}"`);
  } catch (err) {
    await cluster.end();
    throw err;
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString() });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await waitForNoConnections(cluster, name);
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });

describe.runIf(DATABASE_URL !== undefined)(
  'S11 P1-F2 knowledge pack v1 against a fake RAGFlow (integration, real Postgres)',
  () => {
    let pool: Pool;
    let dropDatabase: (() => Promise<void>) | undefined;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let admin: UserRow;
    let ownerPrincipalId: string;
    let workspaceId: string;
    let ragflow: ReturnType<typeof fakeRagflow>;
    let gateApp: FastifyInstance | undefined;
    const supervisorClient = new FakeTaskSupervisorClient();

    function app() {
      return createServer(
        {
          pool,
          loadHandlePublicKey: async () => publicKey,
          loadHandlePrivateKey: async () => privateKey,
        },
        { internalAuth: { token: INTERNAL_TOKEN } },
      );
    }

    function platformCaller(): ResolvedCaller {
      return {
        channel: 'platform',
        user: {
          id: admin.id,
          login: admin.login,
          displayName: admin.displayName,
          platformRole: 'admin',
          mustChangePassword: false,
          consoleSessionId: randomUUID(),
        },
      };
    }

    function ownerCaller(): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId,
          id: ownerPrincipalId,
          kind: 'human',
          role: 'owner',
          displayName: null,
        },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: ownerPrincipalId,
          kind: 'web',
          onBehalfOf: ownerPrincipalId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    const asAdmin = <T>(name: string, params: Record<string, unknown> = {}) =>
      dispatchCapability({ pool }, platformCaller(), name, params) as Promise<T>;
    const asOwner = <T>(name: string, params: Record<string, unknown> = {}) =>
      dispatchCapability({ pool }, ownerCaller(), name, params) as Promise<T>;

    async function internal(
      method: 'GET' | 'POST',
      url: string,
      caller: Parameters<typeof deriveInternalCredential>[1],
      payload?: unknown,
    ) {
      return app().inject({
        method,
        url,
        headers: {
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          authorization: internalAuthorizationHeader(
            deriveInternalCredential(INTERNAL_TOKEN, caller),
          ),
        },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
    }

    /** What the console does: preview, then install what was reviewed, every widening item
     *  confirmed by the owner. */
    async function installPackAsOwner(name: string) {
      const preview = await asOwner<PackInstallPreviewWire>('preview_pack_install', { name });
      const result = await asOwner<PackInstallResultWire>('install_pack', {
        name,
        version: preview.targetVersion,
        reviewedDigest: preview.digest,
        confirmedOrdinals: preview.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      });
      return { preview, result };
    }

    async function workerRunClaims(sessionId: string): Promise<HandleClaims> {
      const row = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerPrincipalId },
        async (client) => {
          const result = await client.query<{
            jti: string;
            on_behalf_of: string;
            scope: HandleClaims['scope'];
            expires_at: Date;
          }>(
            'select jti, on_behalf_of, scope, expires_at from capability_handles where workspace_id = $1 and session_id = $2',
            [workspaceId, sessionId],
          );
          return result.rows[0];
        },
      );
      if (!row) throw new Error(`no capability_handles row for session ${sessionId}`);
      return {
        ws: workspaceId,
        sid: sessionId,
        obo: row.on_behalf_of,
        scope: row.scope,
        jti: row.jti,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
      };
    }

    /** The kernel's gate clients as production builds them, presenting the platform's gate token
     *  (the fake gate's own) — every `createServer` (the internal routes above) wires its own from
     *  the environment, so this runs after the last of those. The health probe the install's
     *  verification makes is one of them. */
    function useGateClients(): void {
      const gatekeeperClient = new HttpGatekeeperClient({
        token: GATE_TOKEN,
        outboundTargetGuard: createOutboundTargetGuard({
          policy: { platformSubnets: [], allowHosts: ['127.0.0.1'] },
        }),
      });
      setGatekeeperReadHandlerDeps({ gatekeeperClient });
      const adminWithTransaction = createAdminWithTransaction(pool);
      setRequestActionDeps({
        gatekeeperClient,
        drainer: new ApprovalDrainer({
          executor: createGatekeeperActionExecutor({
            gatekeeperClient,
            withTransaction: adminWithTransaction,
          }),
          withTransaction: adminWithTransaction,
        }),
        awaitDecisionTimeoutMs: 800,
      });
    }

    beforeAll(async () => {
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      configureTaskRuntime({ pool, privateKey, supervisorClient });
      admin = await createPlatformAdmin(pool, {
        login: `knowledge-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Knowledge Admin',
        password: PASSWORD,
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: 'knowledge-pack-test-workspace',
        owner: { userId: admin.id, displayName: 'Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      workspaceId = created.workspaceId;
      ownerPrincipalId = created.ownerPrincipalId;

      ragflow = fakeRagflow();
      await listen(ragflow.server);
    }, 180_000);

    afterAll(async () => {
      resetTaskRuntimeForTests();
      setGatekeeperReadHandlerDeps({});
      await gateApp?.close();
      await new Promise((resolve) => ragflow.server.close(resolve));
      await dropDatabase?.();
    }, 60_000);

    it('a RAGFlow from the preset, the knowledge pack on top of ops-assets, and its Worker searching the knowledge base', async () => {
      const ragflowAddress = `http://127.0.0.1:${(ragflow.server.address() as AddressInfo).port}`;

      // 1. The administrator creates the instance from the preset — the address only.
      await asAdmin('create_gate_instance', {
        gateId: GATE_ID,
        displayName: 'RAGFlow',
        preset: 'ragflow',
        target: ragflowAddress,
      });
      const pulled = await internal('GET', '/internal/gate-host/instances', 'gate-host');
      expect(pulled.statusCode).toBe(200);
      const hosted = (
        pulled.json().result.items as Array<{ gateId: string; operations?: Operation[] }>
      ).find((item) => item.gateId === GATE_ID);
      const operations = hosted?.operations ?? [];
      expect(operations.map((operation) => operation.name)).toEqual([
        'kb.list',
        'kb.documents',
        'retrieve',
        'document.parse',
      ]);

      // The host builds the instance from those Operations — never from the target — with the key
      // the administrator entered on it, and announces it.
      const gate = new GatekeeperBase({
        manifest: operations,
        transport: new HttpTransport({ baseUrl: ragflowAddress }),
        credentialResolver: { resolve: async () => ({ token: RAGFLOW_KEY }) },
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      gateApp = createGatekeeperServer({ gate, token: GATE_TOKEN });
      await gateApp.listen({ port: 0, host: '127.0.0.1' });
      const endpoint = `http://127.0.0.1:${(gateApp.server.address() as AddressInfo).port}`;
      const announced = await internal('POST', '/internal/gates/announce', 'gate-host', {
        gateId: GATE_ID,
        connector: 'ragflow',
        transportKind: 'http',
        target: ragflowAddress,
        endpoint,
        operations,
      });
      expect(announced.statusCode).toBe(200);
      useGateClients();
      await asAdmin('update_gate_instance', { gateId: GATE_ID, status: 'enabled' });

      // 2. The owner connects it.
      const linked = await asOwner<EnableGateInstanceResultWire>('enable_gate_instance', {
        gateId: GATE_ID,
      });
      expect([...linked.publishedOperationNames].sort()).toEqual([
        'document.parse',
        'kb.documents',
        'kb.list',
        'retrieve',
      ]);
      const gatekeeperId = linked.gatekeeperId;

      // 3. The knowledge pack waits for ops-assets v2 — the dry run says so, the install refuses.
      const early = await asOwner<PackInstallPreviewWire>('preview_pack_install', {
        name: 'knowledge',
      });
      expect(early.pack.dependencies).toEqual([
        {
          name: 'ops-assets',
          minVersion: 2,
          status: 'not_installed',
          installedVersion: null,
          met: false,
        },
      ]);
      expect(early.pack.requirements).toMatchObject([{ connector: 'ragflow', state: 'connected' }]);
      const refused = await asOwner('install_pack', {
        name: 'knowledge',
        version: early.targetVersion,
        reviewedDigest: early.digest,
        confirmedOrdinals: early.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      }).then(
        () => {
          throw new Error('expected install_pack to refuse the knowledge pack');
        },
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(PackDependencyUnmetError);
      expect((refused as PackDependencyUnmetError).details.unmet).toEqual([
        { name: 'ops-assets', minVersion: 2, status: 'not_installed', installedVersion: null },
      ]);

      const assets = await installPackAsOwner('ops-assets');
      expect(assets.result.pack.status).toBe('up_to_date');
      expect(assets.result.pack.installedVersion).toBe(2);

      const knowledge = await installPackAsOwner('knowledge');
      const researcher = knowledge.preview.items.find(
        (item) => item.kind === 'worker_definition_version',
      );
      expect(researcher?.kind === 'worker_definition_version' && researcher.binding).toMatchObject({
        systems: ['ragflow'],
        source: 'install',
        gates: [{ id: gatekeeperId }],
      });
      expect(knowledge.result.pack.status).toBe('up_to_date');
      const verification = knowledge.result.verification as ChangeVerificationWire;
      expect(verification.passed).toBe(true);
      expect(verification.requirements).toMatchObject([
        { connector: 'ragflow', state: 'connected', gates: [{ id: gatekeeperId, health: 'ok' }] },
      ]);
      expect(verification.dependencies).toEqual([
        { name: 'ops-assets', minVersion: 2, status: 'up_to_date', installedVersion: 2, met: true },
      ]);

      // 4. The pack's Worker, invoked like any Worker, searches the knowledge base.
      const definitionId = derivePackComponentId('knowledge', 'worker', 'knowledge-researcher');
      const head = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerPrincipalId },
        (client) => loadPublishedWorkerDefinitionHead(client, workspaceId, definitionId),
      );
      expect(head?.definition.gates).toEqual([gatekeeperId]);
      const invoked = await invokeWorker(
        workspaceId,
        { principalId: ownerPrincipalId, channel: 'human' },
        {
          definitionId,
          version: head?.version ?? 0,
          input: { question: '数据库多久备份一次？' },
          wait: false,
        },
        { pool, privateKey, supervisorClient },
      );
      const workerRun = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerPrincipalId },
        (client) => readWorkerRunRow(client, workspaceId, invoked.workerRunId),
      );
      if (!workerRun?.sessionId) throw new Error('the knowledge Worker run has no session');
      const worker: ResolvedCaller = {
        channel: 'handle',
        claims: await workerRunClaims(workerRun.sessionId),
      };
      const observe = (operation: string, params: Record<string, unknown> = {}) =>
        dispatchCapability({ pool }, worker, 'observe_operation', {
          gatekeeperId,
          operation,
          params,
        }) as Promise<{ status: 'ok'; data: unknown; observedFactCount: number }>;

      const bases = await observe('kb.list');
      expect(bases.data).toMatchObject({
        code: 0,
        data: [{ id: 'ds-runbooks', name: '运维手册' }],
      });
      expect(bases.observedFactCount).toBe(1);
      const documents = await observe('kb.documents', { dataset_id: 'ds-runbooks' });
      expect(documents.data).toMatchObject({ data: { docs: [{ id: 'doc-backup' }] } });
      expect(documents.observedFactCount).toBe(1);
      const found = await observe('retrieve', {
        question: '数据库多久备份一次？',
        dataset_ids: ['ds-runbooks'],
      });
      expect(found.data).toMatchObject({
        data: { chunks: [{ document_keyword: 'backup.md', dataset_id: 'ds-runbooks' }] },
      });

      // The knowledge base and its document are the ontology's types now, in the graph.
      const objects = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerPrincipalId },
        async (client) =>
          (
            await client.query<{ object_type: string; identity_key: unknown; properties: unknown }>(
              `select object_type, identity_key, properties from objects
                where workspace_id = $1 and object_type in ('KnowledgeBase', 'Document')
                order by object_type`,
              [workspaceId],
            )
          ).rows,
      );
      expect(objects).toMatchObject([
        { object_type: 'Document', identity_key: { id: 'doc-backup' } },
        {
          object_type: 'KnowledgeBase',
          identity_key: { id: 'ds-runbooks' },
          properties: { name: '运维手册', documentCount: 1 },
        },
      ]);

      // RAGFlow saw the gate's key on every call, and what the Worker asked.
      expect(ragflow.calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
        'GET /api/v1/datasets',
        'GET /api/v1/datasets/ds-runbooks/documents',
        'POST /api/v1/retrieval',
      ]);
      expect(ragflow.calls.every((call) => call.authorization === `Bearer ${RAGFLOW_KEY}`)).toBe(
        true,
      );
      expect(ragflow.calls[2]?.body).toEqual({
        question: '数据库多久备份一次？',
        dataset_ids: ['ds-runbooks'],
      });

      // 5. It only reads: parsing a document is execute-class, never run through
      //    observe_operation, and the Worker holds no tool that would ask for it.
      await expect(
        observe('document.parse', { dataset_id: 'ds-runbooks', document_ids: ['doc-backup'] }),
      ).rejects.toThrow(/is execute-class/);
      await expect(
        dispatchCapability({ pool }, worker, 'request_action', {
          gatekeeperId,
          operation: 'document.parse',
          params: { dataset_id: 'ds-runbooks', document_ids: ['doc-backup'] },
        }),
      ).rejects.toThrow(/"request_action" is not in the calling handle's scope/);
      expect(ragflow.calls).toHaveLength(3);
    });
  },
);
