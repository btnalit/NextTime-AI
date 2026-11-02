import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdminProposalSegmentApplyResultWire,
  AdminProposalSegmentPreviewWire,
  AdminProposalWire,
  GateInstanceWire,
  ListEnvelope,
  PlatformChangeRollbackPreviewWire,
  PlatformChangeRollbackResultWire,
  PlatformChangeSegmentWire,
  PlatformSegmentApplyResultWire,
  PlatformSegmentPreviewWire,
  ReceivedAdminProposalSegmentWire,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADVISORY_LOCK_NAMESPACES } from '../../adapters/db/advisory-lock-namespaces.js';
import { runMigrations } from '../../adapters/db/migrate.js';
import { withPlatform } from '../../adapters/db/platform-context.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { CredentialReviewRequiredError } from '../../governance/redaction/credential-review.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { WS_ERROR_CODES, mapDispatchError } from '../../interfaces/ws/rpc.js';
import { issueAdminAgentHandle } from '../admin-agent/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { ForbiddenError } from '../gateway/authorize.js';
import type { CapabilityHandler } from '../gateway/capability-handler.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import { CAPABILITY_HANDLERS } from '../gateway/handlers.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { purgeWorkspace } from '../platform/purge-workspace.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  AdminProposalCredentialError,
  AdminProposalInvalidError,
  AdminProposalSegmentNotOpenError,
  ChangeConfirmationRequiredError,
  ChangePlanChangedError,
  DependentSegmentsAppliedError,
  PlatformChangeDriftedError,
  PlatformChangeSegmentRolledBackError,
  PlatformSegmentBlockedError,
  PlatformSegmentChangedError,
  PlatformSegmentNotAppliedError,
  PlatformSegmentNotFoundError,
  applyAdminProposalSegment,
  rollBackPlatformChangeSegment,
} from './index.js';
import { lockProposalDependency } from './proposal-dependency.js';

/**
 * application/change-plan/platform-segments integration (S11 AA3c-1; real Postgres, auto-skip
 * without DATABASE_URL): an admin proposal's platform segment — new gate-host instances
 * (`gate_instance`, the F6 whitelist) — proposed by an admin agent, previewed, applied and rejected
 * by a platform administrator on the platform plane, and the platform change segment its apply
 * records, rolled back from there (F-c3: compared first, then written); the workspace segments of
 * the proposal depend on it (applied only once it is, withdrawn with it); governance 0034's guards.
 * S11 AA3c-2 (the AA3c plan F-c4; governance 0035): that dependency held — the proposal's
 * dependency lock between a workspace apply and a platform rollback, what the platform segment
 * created compared again before a workspace segment applies, the dependents read from what their
 * applies recorded (after a purge too), and the database's own wall beside the kernel's.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

/** Not a real credential: a filler value under a name a credential would have. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

type Target = { readonly workspaceId: string; readonly ownerPrincipalId: string };

function skillItem(name: string) {
  return {
    kind: 'skill_version' as const,
    skill: { name, description: `Triage ${name}.`, markdown: '# Steps\n\n1. Look at the disk.' },
  };
}

/** A plain http instance of the system `connector` (no preset), unique by `gateId`. */
function gateItem(gateId: string, connector: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'gate_instance' as const,
    gateId,
    displayName: `Tickets ${gateId}`,
    transportKind: 'http' as const,
    target: `https://${gateId}.example.invalid`,
    credentialMode: 'shared' as const,
    manifestSource: `https://${gateId}.example.invalid/openapi.json`,
    connector,
    ...extra,
  };
}

function ownerCaller(target: Target): ResolvedCaller {
  return {
    channel: 'human',
    principal: {
      workspaceId: target.workspaceId,
      id: target.ownerPrincipalId,
      kind: 'human',
      role: 'owner',
      displayName: 'owner',
    },
    session: {
      workspaceId: target.workspaceId,
      id: randomUUID(),
      principalId: target.ownerPrincipalId,
      kind: 'web',
      onBehalfOf: target.ownerPrincipalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
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

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (err: unknown) => err,
  );
}

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA3c-1 Admin proposal platform segments (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let previousSwitch: string | undefined;

    const unique = () => randomUUID().slice(0, 8);

    /** A platform administrator with a trial workspace of their own, and their agent's Handle. */
    async function administrator(): Promise<{
      readonly user: UserRow;
      readonly trial: Target;
      readonly agent: ResolvedCaller;
    }> {
      const suffix = unique();
      const user = await createUser(pool, {
        login: `aa3c1-admin-${suffix}`,
        displayName: `Admin ${suffix}`,
        platformRole: 'admin',
      });
      const trial = await newWorkspace(user, 'admin_trial');
      const issued = await withWorkspace(
        pool,
        { workspaceId: trial.workspaceId, principalId: trial.ownerPrincipalId },
        (client) =>
          issueAdminAgentHandle(client, {
            workspaceId: trial.workspaceId,
            principalId: trial.ownerPrincipalId,
            ttlSeconds: 600,
            privateKey,
          }),
      );
      const claims = await authenticateHandle(pool, issued.token, { publicKey }, 'source');
      return { user, trial, agent: { channel: 'handle', claims } };
    }

    /** Another platform administrator: the one who decides what the first one's agent proposed. */
    async function otherAdministrator(): Promise<UserRow> {
      const suffix = unique();
      return createUser(pool, {
        login: `aa3c1-decider-${suffix}`,
        displayName: `Decider ${suffix}`,
        platformRole: 'admin',
      });
    }

    async function newWorkspace(
      owner: UserRow,
      purpose: 'standard' | 'admin_trial',
    ): Promise<Target> {
      return createWorkspaceWithOwner(pool, {
        name: `aa3c1-${purpose}-${unique()}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose,
      });
    }

    async function newTarget(): Promise<Target> {
      const owner = await createUser(pool, {
        login: `aa3c1-owner-${unique()}`,
        displayName: 'Target Owner',
      });
      return newWorkspace(owner, 'standard');
    }

    const call = <T>(caller: ResolvedCaller, name: string, params: unknown) =>
      dispatchCapability({ pool }, caller, name, params) as Promise<T>;

    /** Proposes a platform segment of `items`, with a workspace segment for each of `targets`. */
    async function proposePlatform(
      agent: ResolvedCaller,
      items: readonly Record<string, unknown>[],
      targets: readonly Target[] = [],
    ): Promise<{
      readonly proposal: AdminProposalWire;
      readonly platformSegmentId: string;
      readonly workspaceSegmentIds: readonly string[];
    }> {
      const proposal = await call<AdminProposalWire>(agent, 'propose_admin_proposal', {
        title: 'Connect the ticket system',
        description: 'What the trial workspace settled on.',
        sourceName: `aa3c1-${unique()}`,
        segments: targets.map((target, index) => ({
          targetWorkspaceId: target.workspaceId,
          items: [skillItem(`ticket-triage-${index}`)],
        })),
        platform: { items },
      });
      const platformSegmentId = proposal.segments.find((s) => s.authority === 'platform')?.id;
      if (!platformSegmentId) throw new Error('propose: no platform segment');
      return {
        proposal,
        platformSegmentId,
        workspaceSegmentIds: proposal.segments
          .filter((s) => s.authority === 'workspace')
          .map((s) => s.id),
      };
    }

    const preview = (user: UserRow, segmentId: string) =>
      call<PlatformSegmentPreviewWire>(platformCaller(user), 'preview_platform_segment', {
        segmentId,
      });

    const apply = (
      user: UserRow,
      segmentId: string,
      reviewedDigest: string,
      extra: Record<string, unknown> = {},
    ) =>
      call<PlatformSegmentApplyResultWire>(platformCaller(user), 'apply_platform_segment', {
        segmentId,
        reviewedDigest,
        ...extra,
      });

    /** Previews, then applies what the preview showed, confirming every item. */
    async function previewAndApply(user: UserRow, segmentId: string) {
      const dryRun = await preview(user, segmentId);
      if (dryRun.digest === null) throw new Error(`blocked: ${JSON.stringify(dryRun.blockers)}`);
      return apply(user, segmentId, dryRun.digest, {
        confirmedOrdinals: dryRun.items.map((item) => item.ordinal),
      });
    }

    async function gateRow(gateId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          connector: string;
          status: string;
          status_before_lost: string | null;
          hosted: boolean;
          definition: Record<string, unknown> | null;
        }>(
          `select connector, status, status_before_lost, hosted, definition
             from gate_instances where gate_id = $1`,
          [gateId],
        ),
      );
      return result.rows[0];
    }

    async function connectorRow(name: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ kind: string; mode: string; packaged: boolean }>(
          'select kind, mode, packaged from connectors where name = $1',
          [name],
        ),
      );
      return result.rows[0];
    }

    async function segmentRow(segmentId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          status: string;
          decided_by_user: string | null;
          rolled_back_by_user: string | null;
          applied_platform_segment_id: string | null;
          withdrawn_origin: string | null;
          reason: string | null;
        }>(
          `select status, decided_by_user, rolled_back_by_user, applied_platform_segment_id,
                  withdrawn_origin, reason
             from admin_proposal_segments where id = $1`,
          [segmentId],
        ),
      );
      return result.rows[0];
    }

    /** Platform AuditRecords (`workspace_id` null) of `action`, newest first. */
    async function platformAudits(
      action: string,
      where: { resourceRef?: string; resourceId?: string },
    ) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          payload: Record<string, unknown>;
          resource_type: string | null;
          resource_id: string | null;
          actor_user_id: string | null;
        }>(
          `select payload, resource_type, resource_id, actor_user_id from audit_records
            where workspace_id is null and action = $1
              and ($2::text is null or payload ->> 'resourceRef' = $2)
              and ($3::text is null or resource_id::text = $3)
            order by created_at desc, id desc`,
          [action, where.resourceRef ?? null, where.resourceId ?? null],
        ),
      );
      return result.rows;
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    // -----------------------------------------------------------------------------------------
    // Proposing
    // -----------------------------------------------------------------------------------------

    it('F6: a proposal may be a platform segment alone; it follows the workspace segments, holds gate_instance items only, and creates nothing', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const system = `tickets-${unique()}`;
      const gateId = `aa3c1-${unique()}`;
      const alone = await proposePlatform(agent, [gateItem(gateId, system)]);
      expect(alone.proposal.segments).toEqual([
        expect.objectContaining({
          ordinal: 1,
          authority: 'platform',
          targetWorkspaceId: null,
          status: 'proposed',
          items: [expect.objectContaining({ kind: 'gate_instance', gateId, connector: system })],
        }),
      ]);
      const both = await proposePlatform(agent, [gateItem(`aa3c1-${unique()}`, system)], [target]);
      expect(both.proposal.segments.map((s) => [s.ordinal, s.authority])).toEqual([
        [1, 'workspace'],
        [2, 'platform'],
      ]);
      // Nothing exists until a platform administrator applies it.
      expect(await gateRow(gateId)).toBeUndefined();
      expect(await connectorRow(system)).toBeUndefined();
      expect(await platformAudits('gate_instance.created', { resourceRef: gateId })).toEqual([]);
      // The platform reads it as proposed.
      const onPlatform = await call<AdminProposalWire>(platformCaller(user), 'get_admin_proposal', {
        proposalId: alone.proposal.id,
      });
      expect(onPlatform.segments[0]).toMatchObject({ authority: 'platform', status: 'proposed' });
    });

    it('F6: refused when proposing — a gate_instance in a workspace segment, no connector or a generic one, a duplicate gate id, a credential in a target or OpenAPI address', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const gateId = `aa3c1-${unique()}`;
      const base = {
        title: 'Connect the ticket system',
        description: 'x',
        sourceName: `aa3c1-${unique()}`,
      };
      const refused = async (params: Record<string, unknown>) =>
        mapCapabilityError(
          await thrownBy(call(agent, 'propose_admin_proposal', { ...base, ...params })),
        );

      // The whitelist: a workspace segment never carries a gate_instance.
      expect(
        await refused({
          segments: [
            { targetWorkspaceId: target.workspaceId, items: [gateItem(gateId, 'tickets')] },
          ],
        }),
      ).toMatchObject({ status: 400, code: 'invalid_params' });
      // One platform segment, an object — not a list of them.
      expect(await refused({ platform: [{ items: [gateItem(gateId, 'tickets')] }] })).toMatchObject(
        { status: 400, code: 'invalid_params' },
      );
      // Without a preset it names the system's own connector, never a generic one.
      const { connector: _dropped, ...noConnector } = gateItem(gateId, 'tickets');
      expect(await refused({ platform: { items: [noConnector] } })).toMatchObject({
        status: 400,
        code: 'invalid_params',
      });
      expect(await refused({ platform: { items: [gateItem(gateId, 'http')] } })).toMatchObject({
        status: 400,
        code: 'invalid_params',
      });
      // A preset fixes the connector: naming one too is refused.
      expect(
        await refused({
          platform: {
            items: [
              {
                kind: 'gate_instance',
                gateId,
                preset: 'ragflow',
                target: 'https://kb.example.invalid',
                connector: 'tickets',
              },
            ],
          },
        }),
      ).toMatchObject({ status: 400, code: 'invalid_params' });
      // Over the target limit (F-c8, 500).
      expect(
        await refused({
          platform: {
            items: [
              gateItem(gateId, 'tickets', {
                target: `https://${'a'.repeat(490)}.example.invalid`,
              }),
            ],
          },
        }),
      ).toMatchObject({ status: 400, code: 'invalid_params' });

      // Two instances with one gate id.
      const duplicate = await thrownBy(
        call(agent, 'propose_admin_proposal', {
          ...base,
          platform: { items: [gateItem(gateId, 'tickets'), gateItem(gateId, 'tickets')] },
        }),
      );
      expect(duplicate).toBeInstanceOf(AdminProposalInvalidError);
      expect(
        (mapCapabilityError(duplicate).details as { problems: { path: string }[] }).problems.map(
          (problem) => problem.path,
        ),
      ).toEqual(['platform.items[1].gateId']);

      // A user and password in an address, as create_gate_instance refuses them.
      const inTarget = await thrownBy(
        call(agent, 'propose_admin_proposal', {
          ...base,
          platform: {
            items: [
              gateItem(gateId, 'tickets', { target: `https://ops:${FAKE}@t.example.invalid` }),
            ],
          },
        }),
      );
      expect(inTarget).toBeInstanceOf(AdminProposalCredentialError);
      expect(mapCapabilityError(inTarget)).toMatchObject({
        status: 400,
        code: 'admin_proposal_credential',
      });
      expect(JSON.stringify(mapCapabilityError(inTarget))).not.toContain(FAKE);
      const inSource = await thrownBy(
        call(agent, 'propose_admin_proposal', {
          ...base,
          platform: {
            items: [
              gateItem(gateId, 'tickets', {
                manifestSource: `https://ops:${FAKE}@t.example.invalid/openapi.json`,
              }),
            ],
          },
        }),
      );
      expect(inSource).toBeInstanceOf(AdminProposalCredentialError);
      expect(JSON.stringify(mapCapabilityError(inSource))).toContain(
        'platform.items[0].manifestSource',
      );
      // A query parameter only the connection rule counts as a credential — not the value
      // patterns (no user, password or `token=`): refused just the same (review of #921, #493 P3-3).
      for (const address of [
        `https://t.example.invalid/api?sig=${FAKE}`,
        `https://t.example.invalid/api?X-Amz-Signature=${FAKE}`,
      ]) {
        const signed = await thrownBy(
          call(agent, 'propose_admin_proposal', {
            ...base,
            platform: { items: [gateItem(gateId, 'tickets', { target: address })] },
          }),
        );
        expect(signed).toBeInstanceOf(AdminProposalCredentialError);
        expect(mapCapabilityError(signed)).toMatchObject({
          status: 400,
          code: 'admin_proposal_credential',
        });
        expect(JSON.stringify(mapCapabilityError(signed))).toContain('platform.items[0].target');
        expect(JSON.stringify(mapCapabilityError(signed))).not.toContain(FAKE);
      }
    });

    // -----------------------------------------------------------------------------------------
    // The platform plane
    // -----------------------------------------------------------------------------------------

    it('only a platform administrator reaches the platform segment and its record: not a workspace owner, not the agent', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const { platformSegmentId } = await proposePlatform(
        agent,
        [gateItem(`aa3c1-${unique()}`, `tickets-${unique()}`)],
        [target],
      );
      for (const caller of [ownerCaller(target), agent]) {
        for (const [name, params] of [
          ['preview_platform_segment', { segmentId: platformSegmentId }],
          ['apply_platform_segment', { segmentId: platformSegmentId, reviewedDigest: 'sha256:x' }],
          ['reject_platform_segment', { segmentId: platformSegmentId, reason: 'no' }],
          ['list_platform_change_segments', {}],
        ] as const) {
          await expect(call(caller, name, params)).rejects.toBeInstanceOf(ForbiddenError);
        }
      }
      // A workspace segment's id is not a platform segment's.
      const workspaceSegment = (
        await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
          ownerCaller(target),
          'list_admin_proposal_segments',
          {},
        )
      ).items[0];
      const notPlatform = await thrownBy(preview(user, workspaceSegment?.id ?? ''));
      expect(notPlatform).toBeInstanceOf(PlatformSegmentNotFoundError);
      expect(mapCapabilityError(notPlatform)).toMatchObject({
        status: 404,
        code: 'admin_proposal_segment_not_found',
      });
      expect(mapDispatchError(notPlatform).code).toBe(WS_ERROR_CODES.NOT_FOUND);
    });

    it('F-c7: preview names each item the platform would not take now, and plans nothing while there is one', async () => {
      const { user, agent } = await administrator();
      const taken = `aa3c1-${unique()}`;
      const mcpSystem = `mcp-sys-${unique()}`;
      const offList = `self-sys-${unique()}`;
      const packaged = `packaged-${unique()}`;
      await withAdminClient(pool, async (client) => {
        await client.query(
          `insert into gate_instances (gate_id, connector, display_name, transport_kind, endpoint, status)
           values ($1, 'http', $1, 'http', 'https://taken.example.invalid', 'enabled')`,
          [taken],
        );
        await client.query(
          `insert into connectors (name, kind, mode, packaged) values
             ($1, 'mcp', 'platform_preset', false),
             ($2, 'http', 'self_serve', false),
             ($3, 'http', 'platform_preset', true)`,
          [mcpSystem, offList, packaged],
        );
      });
      const { platformSegmentId } = await proposePlatform(agent, [
        gateItem(`aa3c1-${unique()}`, `ok-${unique()}`),
        gateItem(taken, `ok-${unique()}`),
        gateItem(`aa3c1-${unique()}`, mcpSystem),
        gateItem(`aa3c1-${unique()}`, offList),
        gateItem(`aa3c1-${unique()}`, packaged),
        {
          kind: 'gate_instance',
          gateId: `aa3c1-${unique()}`,
          preset: `no-such-${unique()}`,
          target: 'https://kb.example.invalid',
        },
      ]);
      const dryRun = await preview(user, platformSegmentId);
      expect(dryRun.blockers).toEqual([
        { ordinal: 2, kind: 'gate_instance', reason: 'gate_id_taken' },
        { ordinal: 3, kind: 'gate_instance', reason: 'connector_kind_mismatch' },
        { ordinal: 4, kind: 'gate_instance', reason: 'connector_not_offerable' },
        { ordinal: 5, kind: 'gate_instance', reason: 'connector_packaged' },
        { ordinal: 6, kind: 'gate_instance', reason: 'connector_preset_not_found' },
      ]);
      expect(dryRun).toMatchObject({ digest: null, items: [] });
      const blocked = await thrownBy(apply(user, platformSegmentId, 'sha256:anything'));
      expect(blocked).toBeInstanceOf(PlatformSegmentBlockedError);
      expect(mapCapabilityError(blocked)).toMatchObject({
        status: 409,
        code: 'admin_proposal_segment_blocked',
        details: { blockers: dryRun.blockers },
      });
    });

    it('preview simulates the segment: a later item joins the connector an earlier one creates, and one of another kind there is a blocker', async () => {
      const { user, agent } = await administrator();
      const system = `tickets-${unique()}`;
      const first = await proposePlatform(agent, [
        gateItem(`aa3c1-${unique()}`, system),
        gateItem(`aa3c1-${unique()}`, system, { credentialMode: 'connected_account' }),
      ]);
      const dryRun = await preview(user, first.platformSegmentId);
      expect(dryRun.blockers).toEqual([]);
      expect(dryRun.items.map((item) => [item.ordinal, item.connector, item.nextSteps])).toEqual([
        [
          1,
          { name: system, created: true },
          ['enter_shared_credential', 'await_announce', 'review_and_enable'],
        ],
        [2, { name: system, created: false }, ['await_announce', 'review_and_enable']],
      ]);
      for (const item of dryRun.items) {
        expect(item).toMatchObject({
          classification: 'authority_widening',
          widening: [{ path: 'target', reason: 'added' }],
        });
      }
      expect(dryRun.digest).toMatch(/^sha256:/);
      // The digest is stable: the same dry run again.
      expect((await preview(user, first.platformSegmentId)).digest).toBe(dryRun.digest);

      const mixed = await proposePlatform(agent, [
        gateItem(`aa3c1-${unique()}`, `${system}-x`),
        {
          kind: 'gate_instance',
          gateId: `aa3c1-${unique()}`,
          transportKind: 'mcp',
          target: 'https://mcp.example.invalid',
          credentialMode: 'shared',
          connector: `${system}-x`,
        },
      ]);
      expect((await preview(user, mixed.platformSegmentId)).blockers).toEqual([
        { ordinal: 2, kind: 'gate_instance', reason: 'connector_kind_mismatch' },
      ]);
    });

    it('applies what was previewed, every item confirmed and suspected credentials reviewed: instances discovered, one record, the proposer and the applier apart', async () => {
      const { user: proposer, agent } = await administrator();
      const decider = await otherAdministrator();
      const system = `tickets-${unique()}`;
      const gateA = `aa3c1-${unique()}`;
      const gateB = `aa3c1-${unique()}`;
      const { proposal, platformSegmentId } = await proposePlatform(agent, [
        gateItem(gateA, system, { displayName: `Tickets; run with API_TOKEN="${FAKE}"` }),
        gateItem(gateB, system, { credentialMode: 'connected_account' }),
      ]);
      const dryRun = await preview(decider, platformSegmentId);
      expect(dryRun.suspectedSecretValues).toBe(1);
      expect(dryRun.suspectedSecretPaths).toEqual(['items[0].displayName']);
      const digest = dryRun.digest ?? '';

      // What was reviewed is what is applied.
      await expect(
        apply(decider, platformSegmentId, 'sha256:not-what-was-reviewed', {
          confirmedOrdinals: [1, 2],
          credentialsReviewed: true,
        }),
      ).rejects.toBeInstanceOf(ChangePlanChangedError);
      // Every item widens authority: each is confirmed.
      const unconfirmed = await thrownBy(
        apply(decider, platformSegmentId, digest, {
          confirmedOrdinals: [1],
          credentialsReviewed: true,
        }),
      );
      expect(unconfirmed).toBeInstanceOf(ChangeConfirmationRequiredError);
      expect(mapCapabilityError(unconfirmed)).toMatchObject({
        status: 400,
        code: 'change_confirmation_required',
      });
      await expect(
        apply(decider, platformSegmentId, digest, { confirmedOrdinals: [1, 2] }),
      ).rejects.toBeInstanceOf(CredentialReviewRequiredError);
      // Nothing was written by the refusals.
      expect(await gateRow(gateA)).toBeUndefined();
      expect((await segmentRow(platformSegmentId))?.status).toBe('proposed');

      const applied = await apply(decider, platformSegmentId, digest, {
        confirmedOrdinals: [1, 2],
        credentialsReviewed: true,
      });
      expect(applied.segment).toMatchObject({ id: platformSegmentId, status: 'applied' });
      expect(applied.nextSteps).toEqual([
        {
          gateId: gateA,
          steps: ['enter_shared_credential', 'await_announce', 'review_and_enable'],
        },
        { gateId: gateB, steps: ['await_announce', 'review_and_enable'] },
      ]);
      const record = applied.changeSegment;
      expect(record).toMatchObject({
        status: 'applied',
        source: {
          kind: 'admin_proposal',
          name: proposal.sourceName,
          proposalId: proposal.id,
          proposalSegmentId: platformSegmentId,
          digest: proposal.segments[0]?.contentDigest,
        },
        proposedBy: { userId: proposer.id, displayName: proposer.displayName },
        reviewedDigest: digest,
        appliedBy: { userId: decider.id, displayName: decider.displayName },
        rolledBackBy: null,
        rolledBackAt: null,
      });
      expect(record.items.map((item) => [item.ordinal, item.gateId, item.connector])).toEqual([
        [1, gateA, { name: system, created: true }],
        [2, gateB, { name: system, created: false }],
      ]);
      expect(record.items[1]).toMatchObject({
        classification: 'authority_widening',
        definition: {
          transportKind: 'http',
          target: `https://${gateB}.example.invalid`,
          credentialMode: 'connected_account',
          manifestSource: `https://${gateB}.example.invalid/openapi.json`,
        },
        confirmedBy: { userId: decider.id },
      });

      // The instances, as create_gate_instance creates them: discovered, hosted, under the new
      // connector, which is in the catalog.
      expect(await gateRow(gateA)).toMatchObject({
        status: 'discovered',
        hosted: true,
        connector: system,
      });
      expect(await connectorRow(system)).toEqual({
        kind: 'http',
        mode: 'platform_preset',
        packaged: false,
      });
      expect(await segmentRow(platformSegmentId)).toMatchObject({
        status: 'applied',
        decided_by_user: decider.id,
        applied_platform_segment_id: record.id,
      });

      // Audit: the connector once, each instance, and the call — by the applier, naming the proposer.
      expect(await platformAudits('connector.created', { resourceRef: system })).toEqual([
        expect.objectContaining({ actor_user_id: decider.id }),
      ]);
      const created = await platformAudits('gate_instance.created', { resourceRef: gateA });
      expect(created).toEqual([
        expect.objectContaining({
          actor_user_id: decider.id,
          resource_type: 'gate_instance',
          payload: expect.objectContaining({
            resourceRef: gateA,
            connector: system,
            platformChangeSegmentId: record.id,
            adminProposalId: proposal.id,
            ordinal: 1,
          }),
        }),
      ]);
      expect(JSON.stringify(created)).not.toContain(FAKE);
      const callRow = (
        await platformAudits('apply_platform_segment', { resourceId: platformSegmentId })
      )[0];
      expect(callRow).toMatchObject({
        actor_user_id: decider.id,
        resource_type: 'admin_proposal_segment',
        payload: expect.objectContaining({
          proposalId: proposal.id,
          platformChangeSegmentId: record.id,
          proposedByUser: proposer.id,
          gateIds: [gateA, gateB],
          credentialReview: { confirmed: true, suspectedSecretValues: 1 },
        }),
      });

      // Read back from the record list and by id; applying again is refused.
      const listed = await call<ListEnvelope<PlatformChangeSegmentWire>>(
        platformCaller(decider),
        'list_platform_change_segments',
        { status: 'applied' },
      );
      expect(listed.items.find((item) => item.id === record.id)).toEqual(record);
      expect(
        await call(platformCaller(decider), 'get_platform_change_segment', {
          changeSegmentId: record.id,
        }),
      ).toEqual(record);
      const again = await thrownBy(previewAndApply(decider, platformSegmentId));
      expect(again).toBeInstanceOf(AdminProposalSegmentNotOpenError);
    });

    it('a preset item: the preset’s definition with only the administrator’s address; the read redacts nothing it should not hold', async () => {
      const { user, agent } = await administrator();
      const gateId = `aa3c1-${unique()}`;
      const { platformSegmentId } = await proposePlatform(agent, [
        { kind: 'gate_instance', gateId, preset: 'ragflow', target: 'https://kb.example.invalid' },
      ]);
      const dryRun = await preview(user, platformSegmentId);
      expect(dryRun.items[0]).toMatchObject({
        gateId,
        connector: { name: 'ragflow' },
        definition: {
          transportKind: 'http',
          target: 'https://kb.example.invalid',
          credentialMode: 'shared',
          manifestSource: null,
          preset: 'ragflow',
        },
      });
      const applied = await previewAndApply(user, platformSegmentId);
      expect(applied.changeSegment.items[0]?.definition.preset).toBe('ragflow');
      expect((await gateRow(gateId))?.definition).toMatchObject({ preset: 'ragflow' });
    });

    // -----------------------------------------------------------------------------------------
    // Rejecting, and the workspace segments that depend on it
    // -----------------------------------------------------------------------------------------

    it('a workspace segment waits for its platform segment: no digest in its preview, 409 platform_segment_not_applied, then applied once the platform segment is', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const { platformSegmentId, workspaceSegmentIds } = await proposePlatform(
        agent,
        [gateItem(`aa3c1-${unique()}`, `tickets-${unique()}`)],
        [target],
      );
      const segmentId = workspaceSegmentIds[0] ?? '';
      const waiting = await call<AdminProposalSegmentPreviewWire>(
        ownerCaller(target),
        'preview_admin_proposal_segment',
        { segmentId },
      );
      expect(waiting.digest).toBeNull();
      expect(waiting.segment.platformSegment).toMatchObject({
        id: platformSegmentId,
        status: 'proposed',
      });
      expect(waiting.items.length).toBe(1);
      const refused = await thrownBy(
        call(ownerCaller(target), 'apply_admin_proposal_segment', {
          segmentId,
          reviewedDigest: 'sha256:anything',
        }),
      );
      expect(refused).toBeInstanceOf(PlatformSegmentNotAppliedError);
      expect(mapCapabilityError(refused)).toMatchObject({
        status: 409,
        code: 'platform_segment_not_applied',
        details: { platformSegmentStatus: 'proposed' },
      });
      expect(mapDispatchError(refused).code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);

      await previewAndApply(user, platformSegmentId);
      const ready = await call<AdminProposalSegmentPreviewWire>(
        ownerCaller(target),
        'preview_admin_proposal_segment',
        { segmentId },
      );
      expect(ready.segment.platformSegment?.status).toBe('applied');
      expect(ready.digest).toMatch(/^sha256:/);
      const applied = await call<AdminProposalSegmentApplyResultWire>(
        ownerCaller(target),
        'apply_admin_proposal_segment',
        {
          segmentId,
          reviewedDigest: ready.digest,
          confirmedOrdinals: ready.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        },
      );
      expect(applied.segment.status).toBe('applied');
    });

    it('rejecting the platform segment withdraws the workspace segments still proposed; the reason is the platform’s, never the agent’s to read', async () => {
      const { user, agent } = await administrator();
      const decider = await otherAdministrator();
      const [targetA, targetB] = [await newTarget(), await newTarget()];
      const { proposal, platformSegmentId, workspaceSegmentIds } = await proposePlatform(
        agent,
        [gateItem(`aa3c1-${unique()}`, `tickets-${unique()}`)],
        [targetA, targetB],
      );
      // The owner of B rejected theirs first: it stays rejected.
      await call(ownerCaller(targetB), 'reject_admin_proposal_segment', {
        segmentId: workspaceSegmentIds[1],
        reason: 'Not here.',
      });
      const rejected = await call<AdminProposalWire>(
        platformCaller(decider),
        'reject_platform_segment',
        { segmentId: platformSegmentId, reason: 'That system is being retired.' },
      );
      expect(rejected.segments.map((s) => [s.authority, s.status, s.withdrawnOrigin])).toEqual([
        ['workspace', 'withdrawn', 'platform_segment'],
        ['workspace', 'rejected', null],
        ['platform', 'rejected', null],
      ]);
      expect(rejected.segments[2]?.reason).toBe('That system is being retired.');
      expect(await segmentRow(platformSegmentId)).toMatchObject({
        status: 'rejected',
        decided_by_user: decider.id,
      });
      expect(
        (await platformAudits('reject_platform_segment', { resourceId: platformSegmentId }))[0],
      ).toMatchObject({
        actor_user_id: decider.id,
        payload: expect.objectContaining({ proposalId: proposal.id, withdrawnSegments: 1 }),
      });
      // The agent reads that it was rejected, not why.
      const asAgent = await call<AdminProposalWire>(agent, 'agent_get_admin_proposal', {
        proposalId: proposal.id,
      });
      expect(asAgent.segments[2]).toMatchObject({ status: 'rejected', reason: null });
      // The withdrawn workspace segment cannot be applied.
      await expect(
        call(ownerCaller(targetA), 'apply_admin_proposal_segment', {
          segmentId: workspaceSegmentIds[0],
          reviewedDigest: 'sha256:x',
        }),
      ).rejects.toBeInstanceOf(AdminProposalSegmentNotOpenError);
      await expect(previewAndApply(user, platformSegmentId)).rejects.toBeInstanceOf(
        AdminProposalSegmentNotOpenError,
      );
    });

    // -----------------------------------------------------------------------------------------
    // Rolling back (F-c3)
    // -----------------------------------------------------------------------------------------

    it('rolls back by disabling what it created, as it is now: enabled or discovered → disabled, disabled stays, lost returns disabled, gone is nothing; the connector stays', async () => {
      const { user, agent } = await administrator();
      const decider = await otherAdministrator();
      const target = await newTarget();
      const system = `tickets-${unique()}`;
      const ids = Array.from({ length: 5 }, () => `aa3c1-${unique()}`);
      const [enabled, discovered, disabled, lost, gone] = ids as [
        string,
        string,
        string,
        string,
        string,
      ];
      const { proposal, platformSegmentId, workspaceSegmentIds } = await proposePlatform(
        agent,
        ids.map((gateId) => gateItem(gateId, system)),
        [target],
      );
      const applied = await previewAndApply(decider, platformSegmentId);
      const recordId = applied.changeSegment.id;
      await call<GateInstanceWire>(platformCaller(user), 'update_gate_instance', {
        gateId: enabled,
        status: 'enabled',
      });
      await call<GateInstanceWire>(platformCaller(user), 'update_gate_instance', {
        gateId: disabled,
        status: 'disabled',
      });
      await withAdminClient(pool, async (client) => {
        await client.query(
          `update gate_instances set status = 'lost', status_before_lost = 'enabled' where gate_id = $1`,
          [lost],
        );
        await client.query('delete from gate_instances where gate_id = $1', [gone]);
      });

      const dryRun = await call<PlatformChangeRollbackPreviewWire>(
        platformCaller(user),
        'preview_roll_back_platform_change_segment',
        { changeSegmentId: recordId },
      );
      expect(dryRun.items.map((item) => [item.gateId, item.action, item.drift])).toEqual([
        [enabled, 'disable', []],
        [discovered, 'disable', []],
        [disabled, 'already_disabled', []],
        [lost, 'disable', []],
        [gone, 'gone', []],
      ]);
      expect(dryRun).toMatchObject({ dependentsApplied: [], canRollBack: true });

      const rolledBack = await call<PlatformChangeRollbackResultWire>(
        platformCaller(user),
        'roll_back_platform_change_segment',
        { changeSegmentId: recordId },
      );
      expect(rolledBack.withdrawnSegments).toBe(1);
      expect(rolledBack.changeSegment).toMatchObject({
        status: 'rolled_back',
        appliedBy: { userId: decider.id },
        rolledBackBy: { userId: user.id },
      });
      expect((await gateRow(enabled))?.status).toBe('disabled');
      expect((await gateRow(discovered))?.status).toBe('disabled');
      expect((await gateRow(disabled))?.status).toBe('disabled');
      expect(await gateRow(lost)).toMatchObject({ status: 'lost', status_before_lost: 'disabled' });
      expect(await gateRow(gone)).toBeUndefined();
      expect(await connectorRow(system)).toMatchObject({ mode: 'platform_preset' });
      expect(await segmentRow(platformSegmentId)).toMatchObject({
        status: 'rolled_back',
        rolled_back_by_user: user.id,
      });
      expect(await segmentRow(workspaceSegmentIds[0] ?? '')).toMatchObject({
        status: 'withdrawn',
        withdrawn_origin: 'platform_segment',
      });
      // One gate_instance.disabled per instance it disabled; none for the others.
      for (const gateId of [enabled, discovered, lost]) {
        expect(await platformAudits('gate_instance.disabled', { resourceRef: gateId })).toEqual([
          expect.objectContaining({
            actor_user_id: user.id,
            payload: expect.objectContaining({
              platformChangeSegmentId: recordId,
              adminProposalId: proposal.id,
              linkedWorkspaceCount: 0,
            }),
          }),
        ]);
      }
      expect(
        (await platformAudits('gate_instance.disabled', { resourceRef: lost }))[0]?.payload,
      ).toMatchObject({ statusBefore: 'lost', statusBeforeLost: 'enabled' });
      for (const gateId of [disabled, gone]) {
        expect(await platformAudits('gate_instance.disabled', { resourceRef: gateId })).toEqual([]);
      }
      expect(
        (await platformAudits('roll_back_platform_change_segment', { resourceId: recordId }))[0],
      ).toMatchObject({
        actor_user_id: user.id,
        resource_type: 'platform_change_segment',
        payload: expect.objectContaining({
          proposalId: proposal.id,
          disabledGateIds: [enabled, discovered, lost],
          withdrawnSegments: 1,
        }),
      });

      // Once is all.
      const twice = await thrownBy(
        call(platformCaller(user), 'roll_back_platform_change_segment', {
          changeSegmentId: recordId,
        }),
      );
      expect(twice).toBeInstanceOf(PlatformChangeSegmentRolledBackError);
      expect(mapCapabilityError(twice)).toMatchObject({
        status: 409,
        code: 'platform_change_segment_rolled_back',
      });
      expect(
        (
          await call<PlatformChangeRollbackPreviewWire>(
            platformCaller(user),
            'preview_roll_back_platform_change_segment',
            { changeSegmentId: recordId },
          )
        ).canRollBack,
      ).toBe(false);
    });

    it('refuses, writing nothing, while an instance changed since (platform_change_drifted) or a workspace segment of the proposal is applied (dependent_segments_applied)', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const system = `tickets-${unique()}`;
      const gateId = `aa3c1-${unique()}`;
      const { platformSegmentId, workspaceSegmentIds } = await proposePlatform(
        agent,
        [gateItem(gateId, system)],
        [target],
      );
      const recordId = (await previewAndApply(user, platformSegmentId)).changeSegment.id;
      const segmentId = workspaceSegmentIds[0] ?? '';
      const ready = await call<AdminProposalSegmentPreviewWire>(
        ownerCaller(target),
        'preview_admin_proposal_segment',
        { segmentId },
      );
      const appliedThere = await call<AdminProposalSegmentApplyResultWire>(
        ownerCaller(target),
        'apply_admin_proposal_segment',
        {
          segmentId,
          reviewedDigest: ready.digest,
          confirmedOrdinals: ready.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        },
      );

      const rollBack = () =>
        thrownBy(
          call(platformCaller(user), 'roll_back_platform_change_segment', {
            changeSegmentId: recordId,
          }),
        );
      const dryRun = await call<PlatformChangeRollbackPreviewWire>(
        platformCaller(user),
        'preview_roll_back_platform_change_segment',
        { changeSegmentId: recordId },
      );
      expect(dryRun).toMatchObject({
        canRollBack: false,
        dependentsApplied: [
          { segmentId, targetWorkspaceId: target.workspaceId, status: 'applied' },
        ],
      });
      const dependent = await rollBack();
      expect(dependent).toBeInstanceOf(DependentSegmentsAppliedError);
      expect(mapCapabilityError(dependent)).toMatchObject({
        status: 409,
        code: 'dependent_segments_applied',
        details: { segments: [{ segmentId, status: 'applied' }] },
      });

      // Rolled back in its workspace, the dependent no longer holds it; a changed instance does.
      await call(ownerCaller(target), 'roll_back_change_segment', {
        segmentId: appliedThere.changeSegmentId,
      });
      await withAdminClient(pool, (client) =>
        client.query(
          `update gate_instances
              set definition = jsonb_set(definition, '{target}', '"https://elsewhere.example.invalid"')
            where gate_id = $1`,
          [gateId],
        ),
      );
      const drifted = await rollBack();
      expect(drifted).toBeInstanceOf(PlatformChangeDriftedError);
      expect(mapCapabilityError(drifted)).toMatchObject({
        status: 409,
        code: 'platform_change_drifted',
        details: { items: [{ ordinal: 1, gateId, drift: ['target'] }] },
      });
      expect(mapDispatchError(drifted).code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);
      // Nothing was written by either refusal.
      expect((await gateRow(gateId))?.status).toBe('discovered');
      expect((await segmentRow(platformSegmentId))?.status).toBe('applied');
      expect(await platformAudits('gate_instance.disabled', { resourceRef: gateId })).toEqual([]);
    });

    it('the record outlives the trial workspace: still listed, and still rolled back once the proposal is purged', async () => {
      const { user, trial, agent } = await administrator();
      const gateId = `aa3c1-${unique()}`;
      const { proposal, platformSegmentId } = await proposePlatform(agent, [
        gateItem(gateId, `tickets-${unique()}`),
      ]);
      const recordId = (await previewAndApply(user, platformSegmentId)).changeSegment.id;
      await purgeWorkspace(pool, { workspaceId: trial.workspaceId, confirm: true, force: true });
      const record = await call<PlatformChangeSegmentWire>(
        platformCaller(user),
        'get_platform_change_segment',
        { changeSegmentId: recordId },
      );
      expect(record.source).toMatchObject({
        proposalId: proposal.id,
        proposalSegmentId: platformSegmentId,
      });
      const rolledBack = await call<PlatformChangeRollbackResultWire>(
        platformCaller(user),
        'roll_back_platform_change_segment',
        { changeSegmentId: recordId },
      );
      expect(rolledBack).toMatchObject({
        withdrawnSegments: 0,
        changeSegment: { status: 'rolled_back' },
      });
      expect((await gateRow(gateId))?.status).toBe('disabled');
    });

    // -----------------------------------------------------------------------------------------
    // Visibility and the database's own walls
    // -----------------------------------------------------------------------------------------

    it('another workspace never reads the proposal’s platform segment; its target reads only its status', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const stranger = await newTarget();
      const { proposal, platformSegmentId } = await proposePlatform(
        agent,
        [gateItem(`aa3c1-${unique()}`, `tickets-${unique()}`)],
        [target],
      );
      const theirs = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(stranger),
        'list_admin_proposal_segments',
        {},
      );
      expect(theirs.items).toEqual([]);
      const sees = (who: Target) =>
        withWorkspace(
          pool,
          { workspaceId: who.workspaceId, principalId: who.ownerPrincipalId },
          async (client) => {
            const direct = await client.query(
              `select id from admin_proposal_segments where authority = 'platform' and proposal_id = $1`,
              [proposal.id],
            );
            const sibling = await client.query<{ id: string | null }>(
              'select (admin_proposal_platform_segment($1)).id as id',
              [proposal.id],
            );
            return { direct: direct.rowCount, sibling: sibling.rows[0]?.id ?? null };
          },
        );
      expect(await sees(stranger)).toEqual({ direct: 0, sibling: null });
      expect(await sees(target)).toEqual({ direct: 0, sibling: platformSegmentId });
      const mine = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(target),
        'list_admin_proposal_segments',
        {},
      );
      expect(mine.items[0]?.platformSegment).toMatchObject({
        id: platformSegmentId,
        status: 'proposed',
      });
    });

    it('governance 0034: a record and its items are written only as an apply writes them, and never removed or rewritten', async () => {
      const { user, trial, agent } = await administrator();
      const { platformSegmentId } = await proposePlatform(agent, [
        gateItem(`aa3c1-${unique()}`, `tickets-${unique()}`),
      ]);
      const recordId = (await previewAndApply(user, platformSegmentId)).changeSegment.id;
      const refusedOnPlatform = (sql: string, params: unknown[]) =>
        thrownBy(withPlatform(pool, { userId: user.id }, (client) => client.query(sql, params)));
      for (const [sql, message] of [
        ['delete from platform_change_segments where id = $1', /permission denied|never removed/],
        [
          `update platform_change_segments set reviewed_digest = 'sha256:x' where id = $1`,
          /never changes/,
        ],
        [
          `update platform_change_segments set status = 'rolled_back', rolled_back_by_user = gen_random_uuid() where id = $1`,
          /rolled back by the acting administrator/,
        ],
        [
          `update platform_change_items set definition = '{}'::jsonb where change_segment_id = $1`,
          /permission denied|never changes once recorded/,
        ],
        [
          `insert into platform_change_items
             (change_segment_id, ordinal, kind, classification, widening, confirmed_by_user, gate_id,
              display_name, connector, connector_created, definition)
           values ($1, 9, 'gate_instance', 'authority_widening', '[{"path":"target","reason":"added"}]',
                   nullif(current_setting('app.user_id', true), '')::uuid, 'aa3c1-late', 'late', 'late',
                   false, '{}'::jsonb)`,
          /written by the transaction that writes their record/,
        ],
      ] as const) {
        const err = await refusedOnPlatform(sql, [recordId]);
        expect(String((err as Error).message)).toMatch(message);
      }
      // A platform segment is decided on the platform plane, never in a workspace — not even the
      // trial workspace its proposal lives in.
      const inWorkspace = await withWorkspace(
        pool,
        { workspaceId: trial.workspaceId, principalId: trial.ownerPrincipalId },
        (client) =>
          client.query(`update admin_proposal_segments set status = 'rolled_back' where id = $1`, [
            platformSegmentId,
          ]),
      ).then(
        (result) => `rows ${result.rowCount}`,
        (err: unknown) => String((err as Error).message),
      );
      expect(inWorkspace).toMatch(/on the platform plane|rows 0/);
      expect((await segmentRow(platformSegmentId))?.status).toBe('applied');
    });

    it('governance 0034: the database holds who decides and what a record records too — the acting administrator rejects, rolls back and applies; a record names its proposal’s proposer; one platform segment a proposal; withdrawn with the platform segment only once that is decided', async () => {
      // Review of #921 (#493 P3-4): each write below is refused by its own guard, the kernel not
      // involved; the message names which.
      const { user, agent } = await administrator();
      const other = await createUser(pool, {
        login: `aa3c1-other-${unique()}`,
        displayName: 'Other administrator',
        platformRole: 'admin',
      });
      const target = await newTarget();
      const onPlatform = (sql: string, params: unknown[]) =>
        withPlatform(pool, { userId: user.id }, (client) => client.query(sql, params)).then(
          () => 'written',
          (err: unknown) => String((err as Error).message),
        );
      // A platform segment still proposed (with a workspace segment), and one applied.
      const open = await proposePlatform(
        agent,
        [gateItem(`aa3c1-${unique()}`, `tickets-${unique()}`)],
        [target],
      );
      const applied = await proposePlatform(agent, [
        gateItem(`aa3c1-${unique()}`, `tickets-${unique()}`),
      ]);
      await previewAndApply(user, applied.platformSegmentId);

      // Rejected in another administrator's name.
      expect(
        await onPlatform(
          `update admin_proposal_segments set status = 'rejected', decided_by_user = $2, reason = 'no'
            where id = $1`,
          [open.platformSegmentId, other.id],
        ),
      ).toMatch(/a platform segment is rejected by the acting administrator of this transaction/);
      // Rolled back while the record of its apply is still applied.
      expect(
        await onPlatform(
          `update admin_proposal_segments set status = 'rolled_back', rolled_back_by_user = $2
            where id = $1`,
          [applied.platformSegmentId, user.id],
        ),
      ).toMatch(/rolled back with the platform change segment that records it/);
      // A workspace segment withdrawn "with its platform segment" while that is still proposed.
      expect(
        await onPlatform(
          `update admin_proposal_segments
              set status = 'withdrawn', withdrawn_by_user = $2, withdrawn_origin = 'platform_segment'
            where id = $1`,
          [open.workspaceSegmentIds[0], user.id],
        ),
      ).toMatch(/withdrawn with its platform segment once that is rejected or rolled back/);

      // A record of the open platform segment: in another administrator's name, or naming a
      // proposer other than its proposal's — everything else as an apply would write it.
      const source = (
        await withAdminClient(pool, (client) =>
          client.query<{
            proposal_id: string;
            content_digest: string;
            source_name: string;
            proposed_by_user: string;
            proposer_display_name: string;
          }>(
            `select s.proposal_id, s.content_digest, p.source_name, p.proposed_by_user,
                    p.proposer_display_name
               from admin_proposal_segments s
               join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
              where s.id = $1`,
            [open.platformSegmentId],
          ),
        )
      ).rows[0];
      if (!source) throw new Error('no open platform segment');
      expect(source.proposed_by_user).toBe(user.id);
      const writeRecord = (appliedBy: string, proposedBy: string) =>
        onPlatform(
          `insert into platform_change_segments
             (admin_proposal_id, admin_proposal_segment_id, source_name, source_digest,
              proposed_by_user, proposer_display_name, reviewed_digest, applied_by_user)
           values ($1, $2, $3, $4, $5, $6, $4, $7)`,
          [
            source.proposal_id,
            open.platformSegmentId,
            source.source_name,
            source.content_digest,
            proposedBy,
            source.proposer_display_name,
            appliedBy,
          ],
        );
      expect(await writeRecord(other.id, user.id)).toMatch(
        /applied by the acting administrator of this transaction/,
      );
      expect(await writeRecord(user.id, other.id)).toMatch(
        /a record's source and proposer are its platform segment's proposal/,
      );

      // A second platform segment for one proposal: past the segment guards (triggers off, as only
      // a superuser can), the unique index still refuses it.
      const second = await withAdminClient(pool, async (client) => {
        await client.query('set local session_replication_role = replica');
        return client.query(
          `insert into admin_proposal_segments
             (workspace_id, proposal_id, ordinal, authority, target_workspace_id, items, content_digest)
           select workspace_id, proposal_id, ordinal + 100, authority, target_workspace_id, items,
                  content_digest
             from admin_proposal_segments where id = $1`,
          [open.platformSegmentId],
        );
      }).then(
        () => 'written',
        (err: unknown) => String((err as Error).message),
      );
      expect(second).toMatch(/admin_proposal_segments_one_platform/);

      // None of it took.
      expect((await segmentRow(open.platformSegmentId))?.status).toBe('proposed');
      expect((await segmentRow(open.workspaceSegmentIds[0] as string))?.status).toBe('proposed');
      expect((await segmentRow(applied.platformSegmentId))?.status).toBe('applied');
    });

    it('governance 0034: each authority holds only its own kinds, every item an object naming one — not a non-string kind, an array holding the name, or an item that is itself an array', async () => {
      const cases: readonly (readonly [string, string, boolean])[] = [
        ['platform', '[{"kind":"gate_instance"}]', true],
        ['platform', '[{"kind":"gate_instance"},{"kind":"gate_instance"}]', true],
        ['platform', '[{"kind":"skill_version"}]', false],
        ['platform', '[{"kind":"gate_instance"},{"kind":"x"}]', false],
        ['platform', '[{"kind":1}]', false],
        ['platform', '[{"kind":["gate_instance"]}]', false],
        ['platform', '["gate_instance"]', false],
        ['platform', '[{}]', false],
        // An item that is itself an array: lax mode would unwrap it and count the object inside.
        ['platform', '[[{"kind":"gate_instance"}]]', false],
        ['platform', '[[{"kind":"gate_instance"},{"kind":"x"}]]', false],
        [
          'platform',
          JSON.stringify(Array.from({ length: 11 }, () => ({ kind: 'gate_instance' }))),
          false,
        ],
        ['workspace', '[{"kind":"skill_version"},{"kind":"operation_version"}]', true],
        ['workspace', '[{"kind":"worker_definition_version"},{"kind":"ontology_version"}]', true],
        ['workspace', '[{"kind":"gate_instance"}]', false],
        ['workspace', '[{"kind":1}]', false],
        ['workspace', '[{"kind":["skill_version"]}]', false],
        ['workspace', '[[{"kind":"skill_version"}]]', false],
        ['workspace', '[[{"kind":"skill_version"},{"kind":"x"}]]', false],
      ];
      // The constraint as migrated, on a scratch table without the segment guards in front of it
      // (they refuse any row not written by the transaction that makes its proposal).
      const verdicts = await withAdminClient(pool, async (client) => {
        const found = await client.query<{ def: string }>(
          `select pg_get_constraintdef(oid) as def from pg_constraint
            where conname = 'admin_proposal_segments_item_kinds'`,
        );
        const definition = found.rows[0]?.def;
        if (!definition) throw new Error('no admin_proposal_segments_item_kinds constraint');
        await client.query(
          'create temp table item_kinds_probe (authority text not null, items jsonb not null) on commit drop',
        );
        await client.query(
          `alter table item_kinds_probe add constraint item_kinds_probe ${definition}`,
        );
        const taken: boolean[] = [];
        for (const [authority, items] of cases) {
          await client.query('savepoint probe');
          taken.push(
            await client
              .query('insert into item_kinds_probe values ($1, $2::jsonb)', [authority, items])
              .then(
                () => true,
                (err: unknown) => {
                  if (!/item_kinds_probe/.test(String((err as Error).message))) throw err;
                  return false;
                },
              ),
          );
          await client.query('rollback to savepoint probe');
        }
        return taken;
      });
      expect(cases.map(([authority, items], index) => [authority, items, verdicts[index]])).toEqual(
        cases,
      );
    });

    it('F-c8: an existing instance with a target over 500 still reads and disables; only creating one is refused', async () => {
      const { user } = await administrator();
      const gateId = `aa3c1-long-${unique()}`;
      const longTarget = `https://${'a'.repeat(560)}.example.invalid`;
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into gate_instances
             (gate_id, connector, display_name, transport_kind, target, endpoint, operations,
              status, health, hosted, definition)
           values ($1, 'http', $1, 'http', $2, '', '[]'::jsonb, 'enabled', 'unknown', true, $3::jsonb)`,
          [
            gateId,
            longTarget,
            JSON.stringify({
              transportKind: 'http',
              target: longTarget,
              credentialMode: 'shared',
              manifestSource: null,
            }),
          ],
        ),
      );
      const listed = await call<ListEnvelope<GateInstanceWire>>(
        platformCaller(user),
        'list_gate_instances',
        {},
      );
      expect(listed.items.find((item) => item.gateId === gateId)?.definition?.target).toBe(
        longTarget,
      );
      const disabled = await call<GateInstanceWire>(platformCaller(user), 'update_gate_instance', {
        gateId,
        status: 'disabled',
      });
      expect(disabled.status).toBe('disabled');
      const created = await thrownBy(
        call(platformCaller(user), 'create_gate_instance', {
          gateId: `aa3c1-long-${unique()}`,
          transportKind: 'http',
          target: `https://${'a'.repeat(490)}.example.invalid`,
          credentialMode: 'shared',
          manifestSource: 'https://t.example.invalid/openapi.json',
        }),
      );
      expect(mapCapabilityError(created)).toMatchObject({ status: 400, code: 'invalid_params' });
    });

    it('coordinator (AA3c-1 audit copy): create_gate_instance’s audit rows hold no credential, nor an address as typed that carried one — refused calls write nothing, and dispatch cuts what a handler forgot', async () => {
      const { user } = await administrator();
      const admin = platformCaller(user);
      // This test's own filler, so the search below finds only what this test wrote.
      const mark = `${FAKE}${unique()}`;
      /** Synthetic, JWT-shaped (`.gitleaks.toml` allows this signature segment). */
      const JWT =
        'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
      const actionsHolding = async (text: string) =>
        (
          await withAdminClient(pool, (client) =>
            client.query<{ action: string }>(
              'select action from audit_records where strpos(payload::text, $1) > 0',
              [text],
            ),
          )
        ).rows.map((row) => row.action);
      const create = (gateId: string, target: string, manifestSource: string) =>
        call<GateInstanceWire>(admin, 'create_gate_instance', {
          gateId,
          transportKind: 'http',
          target,
          credentialMode: 'shared',
          manifestSource,
        });
      const callRow = async (gateId: string) => {
        const rows = await platformAudits('create_gate_instance', { resourceRef: gateId });
        expect(rows).toHaveLength(1);
        return rows[0]?.payload ?? {};
      };
      const cleanSource = 'https://t.example.invalid/openapi.json';

      // A credential in the address — a user and password, or a query parameter the connection
      // rule counts as one, the value patterns' or not (`sig=`, `X-Amz-Signature=`) — is refused
      // before anything is written, the call's audit row with it.
      for (const target of [
        `https://ops:${mark}@t.example.invalid`,
        `https://t.example.invalid/api?token=${mark}`,
        `https://t.example.invalid/api?sig=${mark}`,
        `https://t.example.invalid/api?X-Amz-Signature=${mark}`,
      ]) {
        const refused = await thrownBy(create(`aa3c1-audit-${unique()}`, target, cleanSource));
        expect(mapCapabilityError(refused)).toMatchObject({ status: 400 });
      }
      expect(await actionsHolding(mark)).toEqual([]);

      // A clean address is recorded as typed: the row still says where the instance points.
      const cleanGate = `aa3c1-audit-${unique()}`;
      await create(cleanGate, 'https://t.example.invalid/api?format=json', cleanSource);
      const clean = await callRow(cleanGate);
      expect(clean).toMatchObject({
        channel: 'platform',
        params: {
          target: 'https://t.example.invalid/api?format=json',
          manifestSource: cleanSource,
        },
      });
      // Only `credentialMode` (a field named after a credential: the field rule replaces it whole,
      // as it always has) is counted; no address is.
      expect(clean).toMatchObject({ params: { credentialMode: '[redacted]' }, redactedValues: 1 });

      // The wall behind the handler's own check: a create_gate_instance handler that forgot it —
      // takes the address as typed and puts it in its own audit additions too — still leaves a row
      // with the address cut and the credential gone, in its params and in what it added.
      const handlers = CAPABILITY_HANDLERS as Map<string, CapabilityHandler>;
      const real = handlers.get('create_gate_instance');
      if (!real) throw new Error('no create_gate_instance handler');
      const forgetful: CapabilityHandler = async (client, workspaceId, params, ctx) => {
        const input = params as Record<string, unknown>;
        const created = await real(
          client,
          workspaceId,
          { ...input, target: 'https://t.example.invalid/api', manifestSource: cleanSource },
          ctx,
        );
        return {
          ...created,
          auditPayload: {
            definition: { target: input.target, manifestSource: input.manifestSource },
            note: `Authorization: Bearer ${JWT}`,
            channel: 'workspace',
          },
        };
      };
      const forgotGate = `aa3c1-audit-${unique()}`;
      handlers.set('create_gate_instance', forgetful);
      try {
        await create(
          forgotGate,
          `https://ops:${mark}@t.example.invalid/api?X-Amz-Signature=${mark}&sig=${mark}`,
          `https://t.example.invalid/openapi.json?sig=${mark}`,
        );
      } finally {
        handlers.set('create_gate_instance', real);
      }
      const forgot = await callRow(forgotGate);
      expect(forgot).toMatchObject({
        // The fixed fields still win over a handler's additions.
        channel: 'platform',
        params: { target: 'https://t.example.invalid/api', manifestSource: cleanSource },
        definition: { target: 'https://t.example.invalid/api', manifestSource: cleanSource },
        note: 'Authorization: [redacted]',
        // The two addresses cut, beside `credentialMode`.
        redactedValues: 3,
      });
      expect(JSON.stringify(forgot)).not.toContain(JWT);
      expect(await actionsHolding(mark)).toEqual([]);
    });

    // -----------------------------------------------------------------------------------------
    // AA3c-2: the dependency held (F-c4) — re-compared, locked, and walled in the database
    // -----------------------------------------------------------------------------------------

    const previewThere = (target: Target, segmentId: string) =>
      call<AdminProposalSegmentPreviewWire>(ownerCaller(target), 'preview_admin_proposal_segment', {
        segmentId,
      });

    const widenings = (dryRun: AdminProposalSegmentPreviewWire) =>
      dryRun.items
        .filter((item) => item.classification === 'authority_widening')
        .map((item) => item.ordinal);

    const applyThere = (
      target: Target,
      segmentId: string,
      dryRun: AdminProposalSegmentPreviewWire,
    ) =>
      call<AdminProposalSegmentApplyResultWire>(
        ownerCaller(target),
        'apply_admin_proposal_segment',
        {
          segmentId,
          reviewedDigest: dryRun.digest,
          confirmedOrdinals: widenings(dryRun),
        },
      );

    /** One new instance and a workspace segment for a new target; the platform segment applied. */
    async function appliedPlatform() {
      const { user, trial, agent } = await administrator();
      const target = await newTarget();
      const gateId = `aa3c2-${unique()}`;
      const { proposal, platformSegmentId, workspaceSegmentIds } = await proposePlatform(
        agent,
        [gateItem(gateId, `tickets-${unique()}`)],
        [target],
      );
      const recordId = (await previewAndApply(user, platformSegmentId)).changeSegment.id;
      return {
        user,
        trial,
        target,
        gateId,
        proposalId: proposal.id,
        platformSegmentId,
        recordId,
        segmentId: workspaceSegmentIds[0] ?? '',
      };
    }

    /** Returns once another transaction waits on the proposal's dependency lock. */
    async function untilWaitingOnDependency(proposalId: string): Promise<void> {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const result = await pool.query<{ waiting: number }>(
          `select count(*)::int as waiting from pg_locks
            where locktype = 'advisory' and not granted
              and classid = $1::int::oid
              and objid::text::bigint = (hashtext($2::text)::bigint + 4294967296) % 4294967296`,
          [ADVISORY_LOCK_NAMESPACES.adminProposalDependency, proposalId],
        );
        if ((result.rows[0]?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('nothing waits on the proposal’s dependency lock');
    }

    const inTarget = <T>(target: Target, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(
        pool,
        { workspaceId: target.workspaceId, principalId: target.ownerPrincipalId },
        fn,
      );

    async function recordStatus(recordId: string): Promise<string | undefined> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ status: string }>(
          'select status from platform_change_segments where id = $1',
          [recordId],
        ),
      );
      return result.rows[0]?.status;
    }

    it('AA3c-2: a workspace segment compares what its platform segment created with the instances now — changed or gone, no digest and 409 platform_segment_changed; as created again, the same digest', async () => {
      const { target, gateId, segmentId } = await appliedPlatform();
      const ready = await previewThere(target, segmentId);
      expect(ready.platformChanges).toEqual([]);
      expect(ready.digest).toMatch(/^sha256:/);
      const created = String((await gateRow(gateId))?.definition?.target);
      const setTarget = (address: string) =>
        withAdminClient(pool, (client) =>
          client.query(
            `update gate_instances set definition = jsonb_set(definition, '{target}', to_jsonb($2::text))
              where gate_id = $1`,
            [gateId, address],
          ),
        );

      await setTarget('https://elsewhere.example.invalid');
      const changed = await previewThere(target, segmentId);
      expect(changed.platformChanges).toEqual([{ gateId, gone: false, drift: ['target'] }]);
      expect(changed.digest).toBeNull();
      // What it would apply is still shown.
      expect(changed.items.length).toBe(1);
      const refused = await thrownBy(applyThere(target, segmentId, ready));
      expect(refused).toBeInstanceOf(PlatformSegmentChangedError);
      expect(mapCapabilityError(refused)).toMatchObject({
        status: 409,
        code: 'platform_segment_changed',
        details: { items: [{ gateId, gone: false, drift: ['target'] }] },
      });
      expect(mapDispatchError(refused).code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);
      expect((await segmentRow(segmentId))?.status).toBe('proposed');

      // As created again: the digest the owner reviewed holds again.
      await setTarget(created);
      const again = await previewThere(target, segmentId);
      expect(again.platformChanges).toEqual([]);
      expect(again.digest).toBe(ready.digest);

      await withAdminClient(pool, (client) =>
        client.query('delete from gate_instances where gate_id = $1', [gateId]),
      );
      const gone = await previewThere(target, segmentId);
      expect(gone.platformChanges).toEqual([{ gateId, gone: true, drift: [] }]);
      expect(gone.digest).toBeNull();
      expect(await thrownBy(applyThere(target, segmentId, ready))).toBeInstanceOf(
        PlatformSegmentChangedError,
      );
    });

    it('AA3c-2: an Operation on an instance not enabled here says who can enable it — the owner (can_enable) or a platform administrator first (needs_platform)', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const gateId = `aa3c2-${unique()}`;
      const proposal = await call<AdminProposalWire>(agent, 'propose_admin_proposal', {
        title: 'Connect the ticket system',
        description: 'Its new instance, and the Operation the trial settled on.',
        sourceName: `aa3c2-${unique()}`,
        segments: [
          {
            targetWorkspaceId: target.workspaceId,
            items: [
              {
                kind: 'operation_version',
                gateId,
                name: 'tickets.close',
                set: { auto_approvable: false },
              },
            ],
          },
        ],
        platform: { items: [gateItem(gateId, `tickets-${unique()}`)] },
      });
      const segmentId = proposal.segments.find((s) => s.authority === 'workspace')?.id ?? '';
      const platformSegmentId = proposal.segments.find((s) => s.authority === 'platform')?.id ?? '';
      const blockers = async () => (await previewThere(target, segmentId)).blockers;
      const blocked = (gateAvailability: string) => [
        { ordinal: 1, kind: 'operation_version', reason: 'gate_not_enabled', gateAvailability },
      ];

      // Not created yet, then created but not offered to workspaces (discovered).
      expect(await blockers()).toEqual(blocked('needs_platform'));
      await previewAndApply(user, platformSegmentId);
      expect(await blockers()).toEqual(blocked('needs_platform'));
      // Offered: the owner can enable it here (enable_gate_instance, its own manifest review).
      await withAdminClient(pool, (client) =>
        client.query(`update gate_instances set status = 'enabled' where gate_id = $1`, [gateId]),
      );
      expect(await blockers()).toEqual(blocked('can_enable'));
    });

    it('AA3c-2: the dependency lock — a platform rollback waiting on a workspace apply then finds it applied (dependent_segments_applied)', async () => {
      const { user, target, proposalId, recordId, segmentId } = await appliedPlatform();
      const ready = await previewThere(target, segmentId);
      let rollingBack: Promise<unknown> | undefined;
      await inTarget(target, async (client) => {
        await lockProposalDependency(client, proposalId, 'shared');
        rollingBack = thrownBy(
          call(platformCaller(user), 'roll_back_platform_change_segment', {
            changeSegmentId: recordId,
          }),
        );
        await untilWaitingOnDependency(proposalId);
        await applyAdminProposalSegment(client, target.workspaceId, target.ownerPrincipalId, {
          segmentId,
          reviewedDigest: ready.digest ?? '',
          confirmedOrdinals: widenings(ready),
        });
      });
      const refused = await rollingBack;
      expect(refused).toBeInstanceOf(DependentSegmentsAppliedError);
      expect(mapCapabilityError(refused)).toMatchObject({
        status: 409,
        code: 'dependent_segments_applied',
        details: { segments: [{ segmentId, targetWorkspaceId: target.workspaceId }] },
      });
      expect((await segmentRow(segmentId))?.status).toBe('applied');
      expect(await recordStatus(recordId)).toBe('applied');
    });

    it('AA3c-2: the dependency lock — a workspace apply waiting on a platform rollback then finds its segment withdrawn, and applies nothing', async () => {
      const { user, target, gateId, proposalId, recordId, segmentId } = await appliedPlatform();
      const ready = await previewThere(target, segmentId);
      let applying: Promise<unknown> | undefined;
      await withPlatform(pool, { userId: user.id }, async (client) => {
        await lockProposalDependency(client, proposalId, 'exclusive');
        applying = thrownBy(applyThere(target, segmentId, ready));
        await untilWaitingOnDependency(proposalId);
        await rollBackPlatformChangeSegment(client, user.id, recordId);
      });
      const refused = await applying;
      expect(refused).toBeInstanceOf(AdminProposalSegmentNotOpenError);
      expect(await segmentRow(segmentId)).toMatchObject({
        status: 'withdrawn',
        withdrawn_origin: 'platform_segment',
      });
      expect(await recordStatus(recordId)).toBe('rolled_back');
      expect((await gateRow(gateId))?.status).toBe('disabled');
      const changes = await inTarget(target, (client) =>
        client.query('select id from change_segments where admin_proposal_segment_id = $1', [
          segmentId,
        ]),
      );
      expect(changes.rowCount).toBe(0);
    });

    it('governance 0035: a write that does not come from the kernel is refused too — a workspace segment applied before its platform segment, or after its record was rolled back; a record rolled back under an applied workspace segment', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const second = await newTarget();
      const { platformSegmentId, workspaceSegmentIds } = await proposePlatform(
        agent,
        [gateItem(`aa3c2-${unique()}`, `tickets-${unique()}`)],
        [target, second],
      );
      const [segmentId = '', otherSegmentId = ''] = workspaceSegmentIds;
      const markApplied = (who: Target, id: string) =>
        inTarget(who, (client) =>
          client.query(
            `update admin_proposal_segments set status = 'applied', decided_by = $2, decided_at = now()
              where id = $1`,
            [id, who.ownerPrincipalId],
          ),
        );
      // The platform segment is still proposed.
      await expect(markApplied(target, segmentId)).rejects.toThrow(/platform segment is applied/);

      const recordId = (await previewAndApply(user, platformSegmentId)).changeSegment.id;
      const ready = await previewThere(target, segmentId);
      await applyThere(target, segmentId, ready);
      const rollRecordBack = () =>
        withPlatform(pool, { userId: user.id }, (client) =>
          client.query(
            `update platform_change_segments
                set status = 'rolled_back', rolled_back_by_user = $2, rolled_back_at = now()
              where id = $1`,
            [recordId, user.id],
          ),
        );
      // A workspace segment of the proposal is applied.
      await expect(rollRecordBack()).rejects.toThrow(
        /no workspace segment of its proposal is applied/,
      );
      expect(await recordStatus(recordId)).toBe('applied');

      // Rolled back in its workspace, the record may be rolled back (here past the kernel, which
      // would also disable the instance); the platform segment still reads applied.
      const appliedThere = await inTarget(target, (client) =>
        client.query<{ id: string }>(
          'select id from change_segments where admin_proposal_segment_id = $1',
          [segmentId],
        ),
      );
      await call(ownerCaller(target), 'roll_back_change_segment', {
        segmentId: appliedThere.rows[0]?.id,
      });
      await rollRecordBack();
      expect((await segmentRow(platformSegmentId))?.status).toBe('applied');
      // The other target's segment now applies neither through the kernel nor past it.
      const notApplied = await thrownBy(
        call(ownerCaller(second), 'apply_admin_proposal_segment', {
          segmentId: otherSegmentId,
          reviewedDigest: 'sha256:anything',
          confirmedOrdinals: [],
        }),
      );
      expect(notApplied).toBeInstanceOf(PlatformSegmentNotAppliedError);
      expect(mapCapabilityError(notApplied)).toMatchObject({
        status: 409,
        code: 'platform_segment_not_applied',
        details: { platformSegmentStatus: 'rolled_back' },
      });
      await expect(markApplied(second, otherSegmentId)).rejects.toThrow(
        /platform segment is applied \(it is applied, its record rolled_back\)/,
      );
    });

    it('AA3c-2: after the trial workspace is purged, a workspace segment applied from it still holds the platform rollback — read from what its apply recorded where it was applied', async () => {
      const { user, trial, target, recordId, segmentId } = await appliedPlatform();
      const applied = await applyThere(target, segmentId, await previewThere(target, segmentId));
      await purgeWorkspace(pool, { workspaceId: trial.workspaceId, confirm: true, force: true });
      expect(await segmentRow(segmentId)).toBeUndefined();

      const dryRun = await call<PlatformChangeRollbackPreviewWire>(
        platformCaller(user),
        'preview_roll_back_platform_change_segment',
        { changeSegmentId: recordId },
      );
      expect(dryRun).toMatchObject({
        canRollBack: false,
        dependentsApplied: [
          { segmentId, targetWorkspaceId: target.workspaceId, status: 'applied' },
        ],
      });
      const refused = await thrownBy(
        call(platformCaller(user), 'roll_back_platform_change_segment', {
          changeSegmentId: recordId,
        }),
      );
      expect(refused).toBeInstanceOf(DependentSegmentsAppliedError);
      // Nor past the kernel.
      await expect(
        withPlatform(pool, { userId: user.id }, (client) =>
          client.query(
            `update platform_change_segments
                set status = 'rolled_back', rolled_back_by_user = $2, rolled_back_at = now()
              where id = $1`,
            [recordId, user.id],
          ),
        ),
      ).rejects.toThrow(/no workspace segment of its proposal is applied/);

      // Rolled back where it was applied, the record rolls back.
      await call(ownerCaller(target), 'roll_back_change_segment', {
        segmentId: applied.changeSegmentId,
      });
      const rolledBack = await call<PlatformChangeRollbackResultWire>(
        platformCaller(user),
        'roll_back_platform_change_segment',
        { changeSegmentId: recordId },
      );
      expect(rolledBack.changeSegment.status).toBe('rolled_back');
    });

    it('coordinator (AA3c-1 audit copy): the workspace branch cuts a gate address and a credential a handler put in its audit additions, as the platform branch does', async () => {
      const target = await newTarget();
      const mark = `${FAKE}${unique()}`;
      const JWT =
        'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
      const handlers = CAPABILITY_HANDLERS as Map<string, CapabilityHandler>;
      const real = handlers.get('get_workspace');
      if (!real) throw new Error('no get_workspace handler');
      // A handler that puts an address as typed, and a credential, in its own audit additions.
      const careless: CapabilityHandler = async (client, workspaceId, params, ctx) => ({
        ...(await real(client, workspaceId, params, ctx)),
        auditPayload: {
          definition: {
            target: `https://ops:${mark}@t.example.invalid/api?sig=${mark}`,
            endpoint: `https://t.example.invalid/hook?X-Amz-Signature=${mark}`,
            manifestSource: 'https://t.example.invalid/openapi.json',
          },
          note: `Authorization: Bearer ${JWT}`,
          channel: 'platform',
        },
      });
      handlers.set('get_workspace', careless);
      try {
        await call(ownerCaller(target), 'get_workspace', {});
      } finally {
        handlers.set('get_workspace', real);
      }
      const rows = await withAdminClient(pool, (client) =>
        client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records where workspace_id = $1 and action = 'get_workspace'
            order by created_at desc, id desc`,
          [target.workspaceId],
        ),
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0]?.payload ?? {};
      expect(row).toMatchObject({
        // The fixed fields still win over a handler's additions.
        channel: 'human',
        definition: {
          target: 'https://t.example.invalid/api',
          endpoint: 'https://t.example.invalid/hook',
          // An address without a credential is kept as typed.
          manifestSource: 'https://t.example.invalid/openapi.json',
        },
        note: 'Authorization: [redacted]',
      });
      expect(JSON.stringify(row)).not.toContain(mark);
      expect(JSON.stringify(row)).not.toContain(JWT);
    });
  },
);
