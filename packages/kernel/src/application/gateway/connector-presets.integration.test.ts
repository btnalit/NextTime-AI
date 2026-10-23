import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConnectorPresetWire,
  ConnectorWire,
  GateInstanceWire,
  Operation,
} from '@nexttime/shared';
import { internalAuthorizationHeader } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { ConnectionParamsCarryCredentialsError } from '../../governance/connections/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY, evaluate } from '../../governance/policy/index.js';
import { createServer } from '../../index.js';
import { deriveInternalCredential } from '../../interfaces/internal-auth/index.js';
import { loadConnectorPresets } from '../gates/index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import { PlatformAdminError } from './platform-handlers.js';
import type { PlatformErrorCode } from './platform-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/connector-presets.integration.test: DB-gated coverage of connector presets
 * (S11 P1-F) — `list_connector_presets`, `create_gate_instance` with `preset`, the preset's
 * Operations in the gate host's pull, and the rule that an upgrade changing a preset's Operations
 * never takes effect before an administrator confirms it (R-18 `pendingManifest`). Private
 * database, same scaffolding as platform-gate-host.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');
const PRESETS_DIR = path.join(REPO_ROOT, 'connectors');
const INTERNAL_TOKEN = 'p1f-presets-internal-token-0123456789abcdef0123456789ab';
const PASSWORD = 'correct horse battery staple';
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
const RAGFLOW_TARGET = 'https://ragflow.example.invalid';

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
  const name = `nexttime_connector_presets_${randomUUID().replace(/-/g, '')}`;
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

describe.runIf(DATABASE_URL !== undefined)(
  'S11 P1-F connector presets (integration, real Postgres)',
  () => {
    let pool: Pool;
    let dropDatabase: (() => Promise<void>) | undefined;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let admin: UserRow;
    let ownerPrincipalId: string;
    let workspaceId: string;
    let presetsOverride: string | undefined;

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

    function platformCaller(user: UserRow): ResolvedCaller {
      return {
        channel: 'platform',
        user: {
          id: user.id,
          login: user.login,
          displayName: user.displayName,
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

    function callAsAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      return dispatchCapability({ pool }, platformCaller(admin), name, params) as Promise<T>;
    }

    async function rejection(call: () => Promise<unknown>): Promise<unknown> {
      return call().then(
        () => {
          throw new Error('expected the call to be refused, but it resolved');
        },
        (err: unknown) => err,
      );
    }

    async function expectPlatformError(call: () => Promise<unknown>, code: PlatformErrorCode) {
      const thrown = await rejection(call);
      expect(thrown).toBeInstanceOf(PlatformAdminError);
      expect((thrown as PlatformAdminError).code).toBe(code);
    }

    async function pull(): Promise<
      Array<{ gateId: string; definition: Record<string, unknown>; operations?: Operation[] }>
    > {
      const response = await app().inject({
        method: 'GET',
        url: '/internal/gate-host/instances',
        headers: {
          authorization: internalAuthorizationHeader(
            deriveInternalCredential(INTERNAL_TOKEN, 'gate-host'),
          ),
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json().result.items;
    }

    /** Announces as the gate host does for an instance it built (`'gate'`: a packaged gate). */
    async function announce(
      body: Record<string, unknown>,
      caller: 'gate' | 'gate-host' = 'gate-host',
    ) {
      return app().inject({
        method: 'POST',
        url: '/internal/gates/announce',
        headers: {
          'content-type': 'application/json',
          authorization: internalAuthorizationHeader(
            deriveInternalCredential(INTERNAL_TOKEN, caller),
          ),
        },
        payload: body,
      });
    }

    function presetAnnounceBody(gateId: string, operations: readonly Operation[]) {
      return {
        gateId,
        connector: 'ragflow',
        transportKind: 'http',
        target: RAGFLOW_TARGET,
        endpoint: `http://gate-host:8083/i/${gateId}`,
        operations,
      };
    }

    /** A copy of the repository's presets in a directory the kernel reads instead
     *  (`CONNECTOR_PRESETS_DIR`), changed by `edit` — an upgrade's presets, or a fixture preset. */
    async function overridePresets(edit: (dir: string) => Promise<void>): Promise<string> {
      presetsOverride = await mkdtemp(path.join(tmpdir(), 'p1f-presets-'));
      await cp(PRESETS_DIR, presetsOverride, { recursive: true });
      await edit(presetsOverride);
      process.env.CONNECTOR_PRESETS_DIR = presetsOverride;
      return presetsOverride;
    }

    beforeAll(async () => {
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      configureTaskRuntime({
        pool,
        privateKey,
        supervisorClient: {
          spawn: async () => {
            throw new Error('not used');
          },
          terminate: async () => false,
          status: async () => undefined,
        },
      });
      admin = await createPlatformAdmin(pool, {
        login: `presets-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Presets Admin',
        password: PASSWORD,
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: 'connector-presets-test-workspace',
        owner: { userId: admin.id, displayName: 'Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      workspaceId = created.workspaceId;
      ownerPrincipalId = created.ownerPrincipalId;
    }, 180_000);

    afterEach(async () => {
      Reflect.deleteProperty(process.env, 'CONNECTOR_PRESETS_DIR');
      if (presetsOverride) await rm(presetsOverride, { recursive: true, force: true });
      presetsOverride = undefined;
    });

    afterAll(async () => {
      resetTaskRuntimeForTests();
      await dropDatabase?.();
    }, 60_000);

    it('a. list_connector_presets lists the RAGFlow preset with its Operations and an empty connector', async () => {
      const { items } = await callAsAdmin<{ items: ConnectorPresetWire[] }>(
        'list_connector_presets',
      );
      const ragflow = items.find((preset) => preset.name === 'ragflow');
      expect(ragflow).toMatchObject({
        displayName: 'RAGFlow',
        transportKind: 'http',
        credentialMode: 'shared',
        packagedConnector: false,
        instanceCount: 0,
      });
      expect(ragflow?.operations.map((operation) => [operation.name, operation.mode])).toEqual([
        ['kb.list', 'observe'],
        ['kb.documents', 'observe'],
        ['retrieve', 'observe'],
        ['document.parse', 'execute'],
      ]);
    });

    it('b. create_gate_instance with a preset takes the address only; the instance joins the preset connector', async () => {
      const created = await callAsAdmin<GateInstanceWire>('create_gate_instance', {
        gateId: 'kb-main',
        displayName: 'Knowledge base',
        preset: 'ragflow',
        target: RAGFLOW_TARGET,
      });
      expect(created).toMatchObject({
        gateId: 'kb-main',
        connector: 'ragflow',
        transportKind: 'http',
        hosted: true,
        status: 'discovered',
        operationCount: 0,
      });
      expect(created.definition).toEqual({
        transportKind: 'http',
        target: RAGFLOW_TARGET,
        credentialMode: 'shared',
        manifestSource: null,
        preset: 'ragflow',
      });

      const { items: connectors } = await callAsAdmin<{ items: ConnectorWire[] }>(
        'list_connectors',
      );
      expect(connectors.find((connector) => connector.name === 'ragflow')).toMatchObject({
        kind: 'http',
        packaged: false,
        mode: 'platform_preset',
      });
      const audits = await pool.query<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where action = 'connector.created' and payload ->> 'resourceRef' = 'ragflow'`,
      );
      expect(audits.rows).toEqual([
        {
          payload: {
            resourceRef: 'ragflow',
            kind: 'http',
            mode: 'platform_preset',
            gateId: 'kb-main',
            preset: 'ragflow',
          },
        },
      ]);

      // A second instance of the same system joins the connector the first one created.
      await callAsAdmin('create_gate_instance', {
        gateId: 'kb-second',
        preset: 'ragflow',
        target: 'https://ragflow-2.example.invalid',
      });
      const { items } = await callAsAdmin<{ items: ConnectorPresetWire[] }>(
        'list_connector_presets',
      );
      expect(items.find((preset) => preset.name === 'ragflow')?.instanceCount).toBe(2);
      await callAsAdmin('delete_gate_instance', { gateId: 'kb-second' });
    });

    it('c. refuses a preset call that also says what the preset fixes, a plain call missing them, an unknown preset, and a credential in the address', async () => {
      for (const extra of [
        { transportKind: 'http' },
        { credentialMode: 'connected_account' },
        { manifestSource: 'https://ragflow.example.invalid/openapi.json' },
        { connector: 'knowledge' },
      ]) {
        expect(
          await rejection(() =>
            callAsAdmin('create_gate_instance', {
              gateId: 'kb-refused',
              preset: 'ragflow',
              target: RAGFLOW_TARGET,
              ...extra,
            }),
          ),
        ).toBeInstanceOf(InvalidCapabilityParamsError);
      }
      expect(
        await rejection(() =>
          callAsAdmin('create_gate_instance', { gateId: 'kb-refused', target: RAGFLOW_TARGET }),
        ),
      ).toBeInstanceOf(InvalidCapabilityParamsError);
      await expectPlatformError(
        () =>
          callAsAdmin('create_gate_instance', {
            gateId: 'kb-refused',
            preset: 'confluence',
            target: RAGFLOW_TARGET,
          }),
        'connector_preset_not_found',
      );
      const credential = await rejection(() =>
        callAsAdmin('create_gate_instance', {
          gateId: 'kb-refused',
          preset: 'ragflow',
          target: `https://ops:${FAKE}@ragflow.example.invalid`,
        }),
      );
      expect(credential).toBeInstanceOf(ConnectionParamsCarryCredentialsError);
      await expectPlatformError(
        () => callAsAdmin('get_gate_instance', { gateId: 'kb-refused' }),
        'gate_not_found',
      );
    });

    it("d. the gate host's pull hands a preset instance the preset's Operations, and no other instance any", async () => {
      await callAsAdmin('create_gate_instance', {
        gateId: 'plain-http',
        transportKind: 'http',
        target: 'https://billing.example.invalid',
        credentialMode: 'shared',
        manifestSource: 'https://billing.example.invalid/openapi.json',
      });
      const items = await pull();
      const ragflow = (await loadConnectorPresets()).find((preset) => preset.name === 'ragflow');
      expect(items.find((item) => item.gateId === 'kb-main')?.operations).toEqual(
        ragflow?.operations,
      );
      expect(items.find((item) => item.gateId === 'plain-http')).not.toHaveProperty('operations');
    });

    it('e. an upgrade that changes the preset Operations is held for the administrator, never in effect before they confirm', async () => {
      // Taken over: the host announces the preset's Operations; the administrator enables it and a
      // workspace publishes them.
      const [taken] = (await pull()).filter((item) => item.gateId === 'kb-main');
      expect(
        (await announce(presetAnnounceBody('kb-main', taken?.operations ?? []))).statusCode,
      ).toBe(200);
      await callAsAdmin('update_gate_instance', { gateId: 'kb-main', status: 'enabled' });
      const enabled = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'kb-main',
      });
      expect(enabled.operationCount).toBe(4);
      expect(enabled.pendingManifest).toBeNull();
      const linked = await dispatchCapability({ pool }, ownerCaller(), 'enable_gate_instance', {
        gateId: 'kb-main',
      });
      expect(
        (linked as { publishedOperationNames: string[] }).publishedOperationNames.sort(),
      ).toEqual(['document.parse', 'kb.documents', 'kb.list', 'retrieve']);

      // The next platform version ships `retrieve` with another parameter.
      await overridePresets(async (dir) => {
        const file = path.join(dir, 'ragflow', 'operations.json');
        const operations = JSON.parse(await readFile(file, 'utf8')) as Array<
          Operation & { params_schema: { properties: Record<string, unknown> } }
        >;
        const retrieve = operations.find((operation) => operation.name === 'retrieve');
        if (!retrieve) throw new Error('the RAGFlow preset has no retrieve');
        retrieve.params_schema.properties.top_k = { type: 'integer' };
        await writeFile(file, JSON.stringify(operations, null, 2));
      });
      const [upgraded] = (await pull()).filter((item) => item.gateId === 'kb-main');
      const upgradedRetrieve = upgraded?.operations?.find(
        (operation) => operation.name === 'retrieve',
      );
      expect(upgradedRetrieve?.params_schema).toMatchObject({
        properties: { top_k: { type: 'integer' } },
      });

      // The host rebuilds and re-announces; the kernel holds it.
      expect(
        (await announce(presetAnnounceBody('kb-main', upgraded?.operations ?? []))).statusCode,
      ).toBe(200);
      const held = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'kb-main',
      });
      expect(held.pendingManifest?.changed.map((change) => change.name)).toEqual(['retrieve']);
      expect(held.pendingManifest?.changed[0]?.otherChangedFields).toContain('params_schema');
      expect(held.pendingManifest?.refusedOperations).toEqual(['retrieve']);
      const inEffect = await pool.query<{ operations: Operation[] }>(
        "select operations from gate_instances where gate_id = 'kb-main'",
      );
      const retrieveInEffect = inEffect.rows[0]?.operations.find(
        (operation) => operation.name === 'retrieve',
      );
      expect(retrieveInEffect).toBeDefined();
      expect(
        Object.keys(
          (retrieveInEffect?.params_schema as { properties: Record<string, unknown> }).properties,
        ),
      ).not.toContain('top_k');

      // Confirmed: the upgrade's Operations are now the ones in effect.
      const confirmed = await callAsAdmin<GateInstanceWire>('confirm_gate_manifest', {
        gateId: 'kb-main',
        digest: held.pendingManifest?.digest,
      });
      expect(confirmed.pendingManifest).toBeNull();
      const adopted = await pool.query<{ operations: Operation[] }>(
        "select operations from gate_instances where gate_id = 'kb-main'",
      );
      expect(
        adopted.rows[0]?.operations.find((operation) => operation.name === 'retrieve')
          ?.params_schema,
      ).toMatchObject({ properties: { top_k: { type: 'integer' } } });
    });

    it('f. a preset whose connector a packaged gate holds is marked so, and no preset instance joins it', async () => {
      await overridePresets(async (dir) => {
        await cp(path.join(dir, 'ragflow'), path.join(dir, 'fixture-kb'), { recursive: true });
        const file = path.join(dir, 'fixture-kb', 'preset.yaml');
        await writeFile(
          file,
          (await readFile(file, 'utf8')).replace('name: ragflow', 'name: fixture-kb'),
        );
      });
      const packaged = await announce(
        {
          gateId: 'fixture-kb-packaged',
          connector: 'fixture-kb',
          transportKind: 'http',
          target: 'http://fixture-kb:9000',
          endpoint: 'http://127.0.0.1:1',
          displayName: 'Fixture KB',
          operations: [],
        },
        'gate',
      );
      expect(packaged.statusCode).toBe(200);

      const { items } = await callAsAdmin<{ items: ConnectorPresetWire[] }>(
        'list_connector_presets',
      );
      expect(items.find((preset) => preset.name === 'fixture-kb')).toMatchObject({
        packagedConnector: true,
        instanceCount: 1,
      });
      expect(items.find((preset) => preset.name === 'ragflow')?.packagedConnector).toBe(false);
      await expectPlatformError(
        () =>
          callAsAdmin('create_gate_instance', {
            gateId: 'fixture-kb-hosted',
            preset: 'fixture-kb',
            target: 'https://fixture-kb.example.invalid',
          }),
        'connector_packaged',
      );
    });

    it('g. document.parse ships medium and never auto-approvable; an instance decided under the earlier low classification holds it, and the owner tightens it in place', async () => {
      // Re-parsing makes RAGFlow delete the document's chunks, hand-made ones included
      // (gatekeepers/ragflow/README.md), so no workspace rule may approve it on its own.
      const shipped = (await loadConnectorPresets({ presetsDir: PRESETS_DIR }))
        .find((preset) => preset.name === 'ragflow')
        ?.operations.find((operation) => operation.name === 'document.parse');
      expect(shipped).toMatchObject({ blast_radius: 'medium', auto_approvable: false });

      // A deployment decided this instance when the preset still said low / auto-approvable.
      await callAsAdmin('create_gate_instance', {
        gateId: 'kb-parse',
        preset: 'ragflow',
        target: 'https://ragflow-parse.example.invalid',
      });
      await overridePresets(async (dir) => {
        const file = path.join(dir, 'ragflow', 'operations.json');
        const operations = JSON.parse(await readFile(file, 'utf8')) as Operation[];
        const parse = operations.find((operation) => operation.name === 'document.parse');
        if (!parse) throw new Error('the RAGFlow preset has no document.parse');
        parse.blast_radius = 'low';
        parse.auto_approvable = true;
        await writeFile(file, JSON.stringify(operations, null, 2));
      });
      const [earlier] = (await pull()).filter((item) => item.gateId === 'kb-parse');
      expect(
        (await announce(presetAnnounceBody('kb-parse', earlier?.operations ?? []))).statusCode,
      ).toBe(200);
      await callAsAdmin('update_gate_instance', { gateId: 'kb-parse', status: 'enabled' });
      const { gatekeeperId } = (await dispatchCapability(
        { pool },
        ownerCaller(),
        'enable_gate_instance',
        { gateId: 'kb-parse' },
      )) as { gatekeeperId: string };
      async function deployedParse() {
        const { items } = (await dispatchCapability({ pool }, ownerCaller(), 'list_operations', {
          gatekeeperId,
        })) as { items: Array<{ name: string; blastRadius: string; autoApprovable: boolean }> };
        const parse = items.find((item) => item.name === 'document.parse');
        if (!parse) throw new Error('document.parse is not deployed');
        return parse;
      }
      expect(await deployedParse()).toMatchObject({ blastRadius: 'low', autoApprovable: true });

      // The upgrade: the host announces today's preset. The instance is decided, so the change is
      // held; the classification is not part of the definition the gate checks, so calls to
      // document.parse are not refused meanwhile — it runs under the classification deployed.
      Reflect.deleteProperty(process.env, 'CONNECTOR_PRESETS_DIR');
      const [upgraded] = (await pull()).filter((item) => item.gateId === 'kb-parse');
      expect(
        (await announce(presetAnnounceBody('kb-parse', upgraded?.operations ?? []))).statusCode,
      ).toBe(200);
      const held = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'kb-parse',
      });
      expect(held.pendingManifest?.changed).toEqual([
        expect.objectContaining({
          name: 'document.parse',
          direction: 'tightened',
          before: expect.objectContaining({ blastRadius: 'low', autoApprovable: true }),
          after: expect.objectContaining({ blastRadius: 'medium', autoApprovable: false }),
          otherChangedFields: [],
        }),
      ]);
      expect(held.pendingManifest?.refusedOperations).toEqual([]);
      expect(await deployedParse()).toMatchObject({ blastRadius: 'low', autoApprovable: true });

      // The administrator adopts it; what the workspace deployed does not change by itself.
      await callAsAdmin('confirm_gate_manifest', {
        gateId: 'kb-parse',
        digest: held.pendingManifest?.digest,
      });
      expect(await deployedParse()).toMatchObject({ blastRadius: 'low', autoApprovable: true });

      // The owner aligns: a tightening, written in place without a revision.
      const preview = (await dispatchCapability(
        { pool },
        ownerCaller(),
        'preview_gate_instance_enable',
        { gateId: 'kb-parse' },
      )) as {
        manifestDigest: string;
        operationsAlreadyPresent: Array<{
          name: string;
          direction: string;
          governanceByRevision?: true;
        }>;
      };
      const parseChange = preview.operationsAlreadyPresent.find(
        (operation) => operation.name === 'document.parse',
      );
      expect(parseChange).toMatchObject({ direction: 'tightened' });
      expect(parseChange?.governanceByRevision).toBeUndefined();
      await dispatchCapability({ pool }, ownerCaller(), 'refresh_operation_governance', {
        gatekeeperId,
        manifestDigest: preview.manifestDigest,
      });
      const tightened = await deployedParse();
      expect(tightened).toMatchObject({ blastRadius: 'medium', autoApprovable: false });

      // From now on a person decides every parse, even where a rule for this gate opts in.
      expect(
        evaluate({
          gatekeeperId,
          blastRadius: 'medium',
          operationAutoApprovable: tightened.autoApprovable,
          workspacePolicy: { scope: 'gatekeeper', autoApprove: true },
          requesterScope: {
            capabilities: ['request_action'],
            resources: { [GATEKEEPER_RESOURCE_SCOPE_KEY]: [gatekeeperId] },
          },
        }),
      ).toMatchObject({ decision: 'require_approval', reason: 'operation_not_auto_approvable' });
    });
  },
);
