import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChangeSegmentDetailWire,
  ChangeVerificationResultWire,
  PackInstallPreviewWire,
  PackInstallResultWire,
  PackWire,
  Role,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type GateTarget,
  type GatekeeperClient,
  GatekeeperClientError,
} from '../../adapters/gatekeeper-client/index.js';
import { normalizeGateEndpoint, registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { type ChangeSource, ChangeVerificationCooldownError } from '../change-plan/index.js';
import { type PackFixtureDirs, skillFile, writePackFixture } from '../packs/fixture.js';
import {
  latestPackVersion,
  loadPackRegistry,
  readPackRequirements,
  requirePack,
} from '../packs/index.js';
import { ForbiddenError } from './authorize.js';
import { sourceRequirementsChecker } from './change-verification.js';
import { dispatchCapability } from './dispatch.js';
import { setGatekeeperReadHandlerDeps } from './gatekeeper-read-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway — change-verification.integration (S11 P1-E): where the systems a pack needs
 * stand in a workspace (`readPackRequirements`: connected / can_enable / can_connect /
 * needs_platform, read from the gate catalog), how a verification run finds them
 * (`sourceRequirementsChecker`: the connected Gatekeepers' health through the gate's own health
 * endpoint, the path `get_gatekeeper` uses), and the capabilities around it: `list_packs` shows
 * each pack's requirements, `install_pack` verifies the segment it recorded right after the commit
 * as the person who installed (`trigger: system`), `verify_change_segment` is the owner's and is
 * refused within the cooldown.
 *
 * Gated on `DATABASE_URL`. Connector names are this file's own (the catalog is platform-wide).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
/** Platform-scope tables are written as the migrations' role (see operation-governance's test). */
const ADMIN_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

type Ws = { readonly workspaceId: string; readonly ownerId: string; readonly memberId: string };

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: role },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

/** A health client answering by endpoint; anything else is unreachable. */
function fakeHealthClient(answers: ReadonlyMap<string, 'ok' | 'unauthorized'>): GatekeeperClient {
  return {
    health: async (target: GateTarget) => {
      const answer = answers.get(target.endpoint);
      if (answer === 'ok') return { status: 'ok' };
      if (answer === 'unauthorized') {
        throw new GatekeeperClientError('no', { code: 'unauthorized', status: 401 });
      }
      throw new Error('connection refused');
    },
  } as unknown as GatekeeperClient;
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/gateway — pack requirements and change verification (S11 P1-E, integration, real Postgres)',
  () => {
    let pool: Pool;
    let fixture: PackFixtureDirs | undefined;
    const suffix = randomUUID().slice(0, 8);
    const connector = (role: string) => `p1e-${role}-${suffix}`;

    async function newWorkspace(): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      const memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1e-verification',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, memberId],
          );
        },
        { skipRoleSwitch: true },
      );
      return { workspaceId, ownerId, memberId };
    }

    const inWorkspace = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);

    const asAdmin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER }, fn, {
        skipRoleSwitch: true,
      });

    const addConnector = (name: string, mode: 'disabled' | 'self_serve' | 'platform_preset') =>
      asAdmin((client) =>
        client.query("insert into connectors (name, kind, mode) values ($1, 'http', $2)", [
          name,
          mode,
        ]),
      );

    const addInstance = (gateId: string, name: string, endpoint: string, status: string) =>
      asAdmin((client) =>
        client.query(
          `insert into gate_instances (gate_id, connector, display_name, transport_kind, endpoint, status)
           values ($1, $2, $1, 'http', $3, $4)`,
          [gateId, name, endpoint, status],
        ),
      );

    async function addGatekeeper(ws: Ws, endpoint: string): Promise<string> {
      return inWorkspace(ws, async (client) => {
        const activity = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.p1e', 'running', $2) returning id`,
          [ws.workspaceId, ws.ownerId],
        );
        const { gatekeeperId } = await registerGatekeeper(client, ws.workspaceId, {
          name: `gate-${randomUUID().slice(0, 8)}`,
          transportKind: 'http',
          target: 'system',
          endpoint,
          activityId: activity.rows[0]?.id ?? '',
          registeredBy: { id: ws.ownerId, kind: 'human' },
        });
        return gatekeeperId;
      });
    }

    /** A Gatekeeper the workspace enabled from a catalog instance in `status`. */
    async function linkCatalogGate(ws: Ws, name: string, status: string): Promise<string> {
      const endpoint = `https://${name}-${randomUUID().slice(0, 8)}.example.invalid`;
      const gateId = `${name}-${randomUUID().slice(0, 6)}`;
      await addInstance(gateId, name, endpoint, status);
      const gatekeeperId = await addGatekeeper(ws, endpoint);
      await asAdmin((client) =>
        client.query(
          `insert into workspace_gate_links (workspace_id, gate_id, gatekeeper_object_id, enabled_by)
           values ($1, $2, $3, $4)`,
          [ws.workspaceId, gateId, gatekeeperId, ws.ownerId],
        ),
      );
      return gatekeeperId;
    }

    /** A Gatekeeper the workspace connected itself on `name`, suspended by the platform or not. */
    async function connectSelf(
      ws: Ws,
      name: string,
      suspended = false,
    ): Promise<{ gatekeeperId: string; endpoint: string }> {
      const endpoint = `https://${name}-${randomUUID().slice(0, 8)}.example.invalid`;
      const gatekeeperId = await addGatekeeper(ws, endpoint);
      await withWorkspace(
        pool,
        { workspaceId: ws.workspaceId, principalId: ws.ownerId },
        (client) =>
          client.query(
            `insert into workspace_self_connections
               (workspace_id, gatekeeper_object_id, connector, target, endpoint, endpoint_key,
                connected_by, suspended_at, suspended_by_user_id)
             values ($1, $2, $3, 'system', $4, $5, $6,
                     case when $7 then now() end, case when $7 then gen_random_uuid() end)`,
            [
              ws.workspaceId,
              gatekeeperId,
              name,
              endpoint,
              normalizeGateEndpoint(endpoint),
              ws.ownerId,
              suspended,
            ],
          ),
        { skipRoleSwitch: true },
      );
      return { gatekeeperId, endpoint };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterEach(async () => {
      setGatekeeperReadHandlerDeps({});
      if (fixture) await rm(fixture.root, { recursive: true, force: true });
      fixture = undefined;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('readPackRequirements: the first state that holds, per connector, in order', async () => {
      const ws = await newWorkspace();
      await addConnector(connector('linked'), 'platform_preset');
      await addConnector(connector('off'), 'platform_preset');
      await addConnector(connector('offered'), 'platform_preset');
      await addConnector(connector('open'), 'self_serve');
      await addConnector(connector('self'), 'self_serve');
      await addConnector(connector('cut'), 'self_serve');
      await addConnector(connector('closed'), 'disabled');

      const linked = await linkCatalogGate(ws, connector('linked'), 'enabled');
      // Linked, but the platform turned the instance off: not connected, nothing else offered.
      await linkCatalogGate(ws, connector('off'), 'disabled');
      await addInstance(
        `${connector('offered')}-a`,
        connector('offered'),
        'https://offered.example.invalid',
        'enabled',
      );
      const self = await connectSelf(ws, connector('self'));
      await connectSelf(ws, connector('cut'), true);

      const names = ['linked', 'off', 'offered', 'open', 'self', 'cut', 'closed', 'missing'].map(
        connector,
      );
      const statuses = await inWorkspace(ws, (client) =>
        readPackRequirements(client, ws.workspaceId, names),
      );
      expect(statuses).toEqual([
        { connector: connector('linked'), state: 'connected', gatekeeperIds: [linked] },
        { connector: connector('off'), state: 'needs_platform', gatekeeperIds: [] },
        { connector: connector('offered'), state: 'can_enable', gatekeeperIds: [] },
        { connector: connector('open'), state: 'can_connect', gatekeeperIds: [] },
        { connector: connector('self'), state: 'connected', gatekeeperIds: [self.gatekeeperId] },
        { connector: connector('cut'), state: 'can_connect', gatekeeperIds: [] },
        { connector: connector('closed'), state: 'needs_platform', gatekeeperIds: [] },
        { connector: connector('missing'), state: 'needs_platform', gatekeeperIds: [] },
      ]);
      // Another workspace has not linked the enabled instance: the platform offers it.
      const other = await newWorkspace();
      expect(
        (
          await inWorkspace(other, (client) =>
            readPackRequirements(client, other.workspaceId, [connector('linked')]),
          )
        )[0]?.state,
      ).toBe('can_enable');
    });

    it('sourceRequirementsChecker: probes each connected Gatekeeper through its health endpoint', async () => {
      const ws = await newWorkspace();
      await addConnector(connector('probed'), 'self_serve');
      await addConnector(connector('absent'), 'self_serve');
      const up = await connectSelf(ws, connector('probed'));
      const locked = await connectSelf(ws, connector('probed'));
      const down = await connectSelf(ws, connector('probed'));
      setGatekeeperReadHandlerDeps({
        gatekeeperClient: fakeHealthClient(
          new Map([
            [up.endpoint, 'ok'],
            [locked.endpoint, 'unauthorized'],
          ]),
        ),
      });
      fixture = await writePackFixture({
        'needs-pack': [
          {
            requires: [connector('probed'), connector('absent')],
            skills: [skillFile('fix-it', 'Fix the thing.', '# Fix it')],
          },
        ],
      });
      const version = latestPackVersion(requirePack(await loadPackRegistry(fixture), 'needs-pack'));
      const source: ChangeSource = {
        kind: 'pack',
        name: 'needs-pack',
        version: '1',
        digest: version.digest,
      };

      const found = await inWorkspace(ws, (client) =>
        sourceRequirementsChecker(client, ws.workspaceId, fixture)(source),
      );
      expect(found.sourceFound).toBe(true);
      expect(found.requirements).toHaveLength(2);
      expect(found.requirements[0]).toMatchObject({
        connector: connector('probed'),
        state: 'connected',
      });
      const health = new Map(found.requirements[0]?.gates.map((gate) => [gate.id, gate.health]));
      expect(health).toEqual(
        new Map([
          [up.gatekeeperId, 'ok'],
          [locked.gatekeeperId, 'unauthorized'],
          [down.gatekeeperId, 'unreachable'],
        ]),
      );
      expect(found.requirements[1]).toEqual({
        connector: connector('absent'),
        state: 'can_connect',
        gates: [],
      });

      // Another digest for the same name and version is not a version this deployment has.
      const unknown = await inWorkspace(ws, (client) =>
        sourceRequirementsChecker(
          client,
          ws.workspaceId,
          fixture,
        )({
          ...source,
          digest: `sha256:${'0'.repeat(64)}`,
        }),
      );
      expect(unknown).toEqual({ sourceFound: false, requirements: [] });
    });

    it('install_pack verifies what it installed as the installer (trigger system); verify_change_segment is the owner’s, with a cooldown', async () => {
      const ws = await newWorkspace();
      const owner = humanCaller(ws.workspaceId, ws.ownerId, 'owner');
      const member = humanCaller(ws.workspaceId, ws.memberId, 'member');
      const call = <T>(caller: ResolvedCaller, name: string, params: unknown) =>
        dispatchCapability({ pool }, caller, name, params) as Promise<T>;

      const listed = (await call<{ items: PackWire[] }>(member, 'list_packs', {})).items.find(
        (pack) => pack.name === 'ops-base',
      );
      expect(listed?.requirements).toHaveLength(1);
      expect(listed?.requirements[0]?.connector).toBe('docker');
      // The catalog is platform-wide and other tests may add docker to it: never connected here.
      expect(listed?.requirements[0]?.state).not.toBe('connected');
      expect(listed?.versions.map((v) => [v.version, v.requiredConnectors])).toEqual([
        [1, []],
        [2, ['docker']],
      ]);

      const preview = await call<PackInstallPreviewWire>(owner, 'preview_pack_install', {
        name: 'ops-base',
      });
      expect(preview.pack.requirements).toEqual(listed?.requirements);
      const installed = await call<PackInstallResultWire>(owner, 'install_pack', {
        name: 'ops-base',
        version: preview.targetVersion,
        reviewedDigest: preview.digest,
        confirmedOrdinals: preview.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      });
      expect(installed.pack).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(installed.verification).toMatchObject({
        trigger: 'system',
        verifiedBy: { id: ws.ownerId, kind: 'human' },
        passed: false,
        sourceFound: true,
        items: [
          { ordinal: 1, kind: 'skill_version', state: 'in_effect' },
          { ordinal: 2, kind: 'worker_definition_version', state: 'in_effect' },
        ],
        requirements: [{ connector: 'docker', met: false, gates: [] }],
      });
      const segmentId = installed.segmentId;
      if (!segmentId) throw new Error('install recorded no segment');
      const audits = await inWorkspace(ws, async (client) => {
        const result = await client.query<{ actor: string; trigger: string }>(
          `select actor_principal_id as actor, payload ->> 'trigger' as trigger from audit_records
            where workspace_id = $1 and action = 'change_segment.verify' and resource_id = $2`,
          [ws.workspaceId, segmentId],
        );
        return result.rows;
      });
      expect(audits).toEqual([{ actor: ws.ownerId, trigger: 'system' }]);

      const detail = await call<ChangeSegmentDetailWire>(member, 'get_change_segment', {
        segmentId,
      });
      expect(detail.segment.status).toBe('verification_failed');
      expect(detail.verification).toEqual(installed.verification);

      await expect(call(member, 'verify_change_segment', { segmentId })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      const cooldown = await call<ChangeVerificationResultWire>(owner, 'verify_change_segment', {
        segmentId,
      }).catch((err: unknown) => err);
      expect(cooldown).toBeInstanceOf(ChangeVerificationCooldownError);
    });
  },
);
