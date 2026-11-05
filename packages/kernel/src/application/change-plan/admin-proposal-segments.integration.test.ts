import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdminAgentTargetsResultWire,
  AdminProposalSegmentApplyResultWire,
  AdminProposalSegmentPreviewWire,
  AdminProposalWire,
  ChangeRollbackPreviewWire,
  ChangeSegmentDetailWire,
  ChangeSegmentWire,
  ChangeVerificationResultWire,
  ListEnvelope,
  Operation,
  ReceivedAdminProposalCountsWire,
  ReceivedAdminProposalSegmentWire,
  Role,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { withPlatform } from '../../adapters/db/platform-context.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { GateTarget, GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { CredentialReviewRequiredError } from '../../governance/redaction/credential-review.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { WS_ERROR_CODES, mapDispatchError } from '../../interfaces/ws/rpc.js';
import { issueAdminAgentHandle } from '../admin-agent/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { ForbiddenError } from '../gateway/authorize.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import { setGatekeeperReadHandlerDeps } from '../gateway/gatekeeper-read-handlers.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { purgeWorkspace } from '../platform/purge-workspace.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/definitions.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withdrawAdminProposal } from './admin-proposals.js';
import {
  AdminProposalSegmentBlockedError,
  AdminProposalSegmentNotFoundError,
  AdminProposalSegmentNotOpenError,
  AdminProposalSegmentUnchangedError,
  AdminProposalTargetNoLongerChosenError,
  AdminProposalTargetNotChosenError,
  ChangeConfirmationRequiredError,
  ChangePlanChangedError,
  derivePackComponentId,
} from './index.js';

/**
 * application/change-plan/admin-proposal-segments integration (S11 AA3b-2; real Postgres,
 * auto-skip without DATABASE_URL): what the owner of a workspace does with a segment of an admin
 * proposal addressed to it — reads it, previews it, applies it, rejects it, rolls it back — and
 * governance 0033's guards on the record that applying it leaves.
 *
 *  - F5: each workspace-agnostic intent resolves here — a Skill / Worker family by name (the next
 *    version), a new family under the id a pack of the proposal's source name would give it, an
 *    Operation through the gate instance this workspace enabled. What does not resolve is a blocker
 *    the owner reads, and nothing is planned while there is one.
 *  - I-A8: what is applied is what was previewed, the resolution included (409
 *    `change_plan_changed`); a widening item is confirmed by its ordinal (I-A4); suspected
 *    credentials need `credentialsReviewed` (F9).
 *  - I-A7: the versions an applied segment publishes are the agent's (`origin = 'agent'`); the
 *    owner applied them; the record names the administrator who proposed them and outlives the
 *    trial workspace.
 *  - F12 / F4: only the owner of the workspace a segment is addressed to reaches it (404 for any
 *    other); no Handle, no service account, no member.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

/** Not a real credential: a filler value under a name a credential would have. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Target = { readonly workspaceId: string; readonly ownerPrincipalId: string };

/** Strict: execute, high impact, not auto-approvable, awaiting the decision. */
const RESTART: Operation = {
  name: 'container.restart',
  description: 'Restart one container.',
  binding: { kind: 'http', method: 'POST', path: '/containers/{id}/restart' },
  params_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  mode: 'execute',
  blast_radius: 'high',
  reversibility: true,
  auto_approvable: false,
  await_decision: true,
  reads: ['Container'],
  writes: ['Container'],
};

function skillItem(name: string, markdown = '# Steps\n\n1. Look at the disk.') {
  return {
    kind: 'skill_version' as const,
    skill: { name, description: `Triage ${name}.`, markdown },
  };
}

function workerItem(definition: Record<string, unknown>) {
  return { kind: 'worker_definition_version' as const, definition };
}

function operationItem(gateId: string, set: Record<string, unknown>, name = RESTART.name) {
  return { kind: 'operation_version' as const, gateId, name, set };
}

function ownerCaller(target: Target, role: Role = 'owner', kind: 'human' | 'service' = 'human') {
  return humanCaller(target.workspaceId, target.ownerPrincipalId, role, kind);
}

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role,
  kind: 'human' | 'service' = 'human',
): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind, role, displayName: role },
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

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (err: unknown) => err,
  );
}

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA3b-2 Admin proposal segments in their target (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let tag: string;
    let previousSwitch: string | undefined;

    /** A platform administrator with a trial workspace of their own, and their agent's Handle. */
    async function administrator(): Promise<{
      readonly user: UserRow;
      readonly trial: Target;
      readonly agent: ResolvedCaller;
    }> {
      const suffix = randomUUID().slice(0, 8);
      const user = await createUser(pool, {
        login: `aa3b2-admin-${suffix}`,
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

    async function newWorkspace(
      owner: UserRow,
      purpose: 'standard' | 'admin_trial',
    ): Promise<Target> {
      return createWorkspaceWithOwner(pool, {
        name: `aa3b2-${purpose}-${randomUUID().slice(0, 8)}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose,
      });
    }

    /** A standard workspace with an owner of its own. */
    async function newTarget(): Promise<Target> {
      const owner = await createUser(pool, {
        login: `aa3b2-owner-${randomUUID().slice(0, 8)}`,
        displayName: 'Target Owner',
      });
      return newWorkspace(owner, 'standard');
    }

    /** What the administrator does on the platform's admin agent page before their agent proposes
     *  (AA4c, governance 0036): chooses each workspace segment's target, when it may be one — an
     *  active standard workspace — and the agent's person is a stored platform administrator.
     *  {@link call} does it for every `propose_admin_proposal`; {@link callUnchosen} does not. */
    async function chooseSegmentTargets(caller: ResolvedCaller, params: unknown): Promise<void> {
      const segments = (params as { segments?: unknown } | null)?.segments;
      if (caller.channel !== 'handle' || !Array.isArray(segments)) return;
      const ids = (segments as readonly { targetWorkspaceId?: unknown }[])
        .map((segment) => segment.targetWorkspaceId)
        .filter((id): id is string => typeof id === 'string' && UUID.test(id));
      if (ids.length === 0) return;
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into admin_agent_targets
             (workspace_id, principal_id, target_workspace_id, chosen_by_user)
           select p.workspace_id, p.id, w.id, p.user_id
             from principals p
             join users u on u.id = p.user_id and u.platform_role = 'admin'
             join workspaces w on w.id = any($3::uuid[])
                              and w.status = 'active' and w.purpose = 'standard'
            where p.workspace_id = $1 and p.id = $2 and p.kind = 'human'
           on conflict do nothing`,
          [caller.claims.ws, caller.claims.obo, ids],
        ),
      );
    }

    const callUnchosen = <T>(caller: ResolvedCaller, name: string, params: unknown) =>
      dispatchCapability({ pool }, caller, name, params) as Promise<T>;

    const call = async <T>(caller: ResolvedCaller, name: string, params: unknown): Promise<T> => {
      if (name === 'propose_admin_proposal') await chooseSegmentTargets(caller, params);
      return callUnchosen<T>(caller, name, params);
    };

    /** Proposes one segment for `target` and returns that segment's id and the proposal. */
    async function proposeFor(
      agent: ResolvedCaller,
      target: Target,
      items: readonly Record<string, unknown>[],
      sourceName = `aa3b2-${tag}`,
    ): Promise<{ readonly proposal: AdminProposalWire; readonly segmentId: string }> {
      const proposal = await call<AdminProposalWire>(agent, 'propose_admin_proposal', {
        title: 'Disk triage everywhere',
        description: 'What the trial workspace settled on.',
        sourceName,
        segments: [{ targetWorkspaceId: target.workspaceId, items }],
      });
      const segmentId = proposal.segments[0]?.id;
      if (!segmentId) throw new Error('propose: no segment');
      return { proposal, segmentId };
    }

    const preview = (target: Target, segmentId: string) =>
      call<AdminProposalSegmentPreviewWire>(ownerCaller(target), 'preview_admin_proposal_segment', {
        segmentId,
      });

    const apply = (
      target: Target,
      segmentId: string,
      reviewedDigest: string,
      extra: Record<string, unknown> = {},
    ) =>
      call<AdminProposalSegmentApplyResultWire>(
        ownerCaller(target),
        'apply_admin_proposal_segment',
        { segmentId, reviewedDigest, ...extra },
      );

    /** Previews, then applies what the preview showed, confirming every widening item. */
    async function previewAndApply(
      target: Target,
      segmentId: string,
      extra: Record<string, unknown> = {},
    ): Promise<AdminProposalSegmentApplyResultWire> {
      const dryRun = await preview(target, segmentId);
      if (dryRun.digest === null) throw new Error(`blocked: ${JSON.stringify(dryRun.blockers)}`);
      const widening = dryRun.items
        .filter((item) => item.classification === 'authority_widening')
        .map((item) => item.ordinal);
      return apply(target, segmentId, dryRun.digest, { confirmedOrdinals: widening, ...extra });
    }

    async function inTarget<T>(target: Target, run: (client: PoolClient) => Promise<T>) {
      return withWorkspace(
        pool,
        { workspaceId: target.workspaceId, principalId: target.ownerPrincipalId },
        run,
      );
    }

    async function segmentRow(segmentId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          status: string;
          decided_by: string | null;
          applied_segment_id: string | null;
          rolled_back_by: string | null;
          reason: string | null;
        }>(
          `select status, decided_by, applied_segment_id, rolled_back_by, reason
             from admin_proposal_segments where id = $1`,
          [segmentId],
        ),
      );
      return result.rows[0];
    }

    async function lastAudit(workspaceId: string, action: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          payload: Record<string, unknown>;
          resource_type: string | null;
          resource_id: string | null;
          actor_principal_id: string | null;
        }>(
          `select payload, resource_type, resource_id, actor_principal_id from audit_records
            where workspace_id = $1 and action = $2
            order by created_at desc, id desc limit 1`,
          [workspaceId, action],
        ),
      );
      return result.rows[0];
    }

    /** A WorkerDefinition family published in `target` by its owner. */
    async function seedWorkerFamily(
      target: Target,
      kind: 'entry' | 'worker',
      definition: Record<string, unknown>,
    ): Promise<string> {
      return inTarget(target, async (client) => {
        const draft = await proposeWorkerDefinition(
          client,
          target.workspaceId,
          target.ownerPrincipalId,
          { kind, definition, origin: 'human' },
        );
        await publishWorkerDefinition(client, target.workspaceId, target.ownerPrincipalId, {
          definitionId: draft.id,
          version: draft.version,
        });
        return draft.id;
      });
    }

    /** A gate instance of the catalog; when `enableIn` is given, that workspace enabled it as a
     *  Gatekeeper on which `RESTART` is published. Returns the gate instance's id. */
    async function seedGate(enableIn?: Target): Promise<{ gateId: string; gatekeeperId?: string }> {
      const gateId = `aa3b2-gate-${randomUUID().slice(0, 8)}`;
      const endpoint = `https://${gateId}.example.invalid`;
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into gate_instances (gate_id, connector, display_name, transport_kind, endpoint, status)
           values ($1, 'http', $1, 'http', $2, 'enabled')`,
          [gateId, endpoint],
        ),
      );
      if (!enableIn) return { gateId };
      const gatekeeperId = await inTarget(enableIn, async (client) => {
        const activity = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'test.aa3b2', 'running', $2) returning id`,
          [enableIn.workspaceId, enableIn.ownerPrincipalId],
        );
        const activityId = activity.rows[0]?.id ?? '';
        const registered = await registerGatekeeper(client, enableIn.workspaceId, {
          name: gateId,
          transportKind: 'http',
          target: 'docker',
          endpoint,
          activityId,
          registeredBy: { id: enableIn.ownerPrincipalId, kind: 'human' },
        });
        await importManifest(client, enableIn.workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          operations: [RESTART],
          proposedBy: { id: enableIn.ownerPrincipalId, kind: 'human' },
          activityId,
        });
        await publishOperation(client, enableIn.workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          name: RESTART.name,
        });
        return registered.gatekeeperId;
      });
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into workspace_gate_links (workspace_id, gate_id, gatekeeper_object_id, enabled_by)
           values ($1, $2, $3, $4)`,
          [enableIn.workspaceId, gateId, gatekeeperId, enableIn.ownerPrincipalId],
        ),
      );
      return { gateId, gatekeeperId };
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      tag = randomUUID().slice(0, 8);
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    it('F5: a Skill resolves to its family here by name, else to a new family under the id a pack of the source name gives it', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const first = await proposeFor(agent, target, [skillItem('disk-triage')]);
      const derived = derivePackComponentId(`aa3b2-${tag}`, 'skill', 'disk-triage');
      const dryRun = await preview(target, first.segmentId);
      expect(dryRun).toMatchObject({
        segment: { id: first.segmentId, status: 'proposed', proposal: { id: first.proposal.id } },
        blockers: [],
        unchanged: false,
        suspectedSecretValues: 0,
        suspectedSecretPaths: [],
        items: [
          {
            ordinal: 1,
            kind: 'skill_version',
            newFamily: true,
            target: { skillId: derived, name: 'disk-triage' },
            before: null,
            unchanged: false,
          },
        ],
      });
      expect(dryRun.digest).toMatch(/^sha256:/);
      // Previewing changes nothing here.
      const none = await inTarget(target, (client) =>
        client.query('select 1 from skills where workspace_id = $1 and name = $2', [
          target.workspaceId,
          'disk-triage',
        ]),
      );
      expect(none.rows).toHaveLength(0);
      await previewAndApply(target, first.segmentId);

      // Another proposal, another source name: the family here is the one by that name, whatever
      // id the new source name would give.
      const second = await proposeFor(
        agent,
        target,
        [skillItem('disk-triage', '# Steps\n\n1. Look at the disk.\n2. Look again.')],
        `aa3b2-other-${tag}`,
      );
      const next = await preview(target, second.segmentId);
      expect(next.items).toMatchObject([
        {
          kind: 'skill_version',
          newFamily: false,
          target: { skillId: derived },
          before: { version: 1 },
          changedFields: ['markdown'],
        },
      ]);
    });

    it('F5: a Worker resolves among worker families by name; an entry by that name, two workers by it, or a Skill it mounts that is not there blocks it', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      await seedWorkerFamily(target, 'entry', {
        name: 'front-desk',
        systemPrompt: 'Hello.',
        capabilities: [],
      });
      await seedWorkerFamily(target, 'worker', { name: 'twin', systemPrompt: 'One.' });
      await seedWorkerFamily(target, 'worker', { name: 'twin', systemPrompt: 'Two.' });
      const existing = await seedWorkerFamily(target, 'worker', {
        name: 'disk-worker',
        systemPrompt: 'You triage disks.',
      });
      const { segmentId } = await proposeFor(agent, target, [
        workerItem({ name: 'front-desk', systemPrompt: 'Taken.' }),
        workerItem({ name: 'twin', systemPrompt: 'Which one?' }),
        workerItem({ name: 'mounts-nothing', systemPrompt: 'x', skills: ['not-here'] }),
        skillItem('mounted-here'),
        workerItem({ name: 'mounts-earlier', systemPrompt: 'x', skills: ['mounted-here'] }),
        workerItem({ name: 'disk-worker', systemPrompt: 'You triage disks, carefully.' }),
      ]);
      const dryRun = await preview(target, segmentId);
      expect(dryRun.blockers).toEqual([
        { ordinal: 1, kind: 'worker_definition_version', reason: 'name_taken' },
        { ordinal: 2, kind: 'worker_definition_version', reason: 'name_ambiguous' },
        { ordinal: 3, kind: 'worker_definition_version', reason: 'unresolved_references' },
      ]);
      // Nothing is planned while an intent does not resolve.
      expect(dryRun).toMatchObject({ digest: null, items: [], unchanged: false });
      const refused = await thrownBy(apply(target, segmentId, 'sha256:anything'));
      expect(refused).toBeInstanceOf(AdminProposalSegmentBlockedError);
      expect(refused).toMatchObject({
        code: 'admin_proposal_segment_blocked',
        details: { blockers: dryRun.blockers },
      });
      expect((await segmentRow(segmentId))?.status).toBe('proposed');

      // Without the three, the rest resolves: the earlier Skill is there for the Worker after it,
      // and the existing worker family takes the next version, keeping this workspace's gates.
      const resolvable = await proposeFor(agent, target, [
        skillItem('mounted-here'),
        workerItem({ name: 'mounts-earlier', systemPrompt: 'x', skills: ['mounted-here'] }),
        workerItem({ name: 'disk-worker', systemPrompt: 'You triage disks, carefully.' }),
      ]);
      const resolved = await preview(target, resolvable.segmentId);
      expect(resolved.blockers).toEqual([]);
      expect(resolved.items).toMatchObject([
        { kind: 'skill_version', newFamily: true },
        {
          kind: 'worker_definition_version',
          newFamily: true,
          target: {
            definitionId: derivePackComponentId(`aa3b2-${tag}`, 'worker', 'mounts-earlier'),
          },
          gates: [],
        },
        {
          kind: 'worker_definition_version',
          newFamily: false,
          target: { definitionId: existing },
          before: { version: 1 },
        },
      ]);
    });

    it('F5: an Operation resolves through the gate instance enabled here; not enabled, not on it, or not a valid revision blocks it', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const elsewhere = await newTarget();
      const enabled = await seedGate(target);
      // Enabled in another workspace only.
      const notHere = await seedGate(elsewhere);
      const { segmentId } = await proposeFor(agent, target, [
        operationItem(notHere.gateId, { auto_approvable: true }),
        operationItem(enabled.gateId, { auto_approvable: true }, 'container.missing'),
        operationItem(enabled.gateId, { description: '   ' }),
      ]);
      const dryRun = await preview(target, segmentId);
      expect(dryRun.blockers).toEqual([
        // An instance of a connector the platform does not offer to workspaces (self_serve).
        {
          ordinal: 1,
          kind: 'operation_version',
          reason: 'gate_not_enabled',
          gateAvailability: 'needs_platform',
        },
        { ordinal: 2, kind: 'operation_version', reason: 'operation_not_found' },
        { ordinal: 3, kind: 'operation_version', reason: 'operation_revision_invalid' },
      ]);
      // A blocker stays with this workspace: nothing about it reaches the proposal the agent reads.
      const read = await call<AdminProposalWire>(agent, 'agent_get_admin_proposal', {
        proposalId: (await segmentProposal(segmentId)) ?? '',
      });
      expect(JSON.stringify(read)).not.toContain('gate_not_enabled');

      const loosen = await proposeFor(agent, target, [
        operationItem(enabled.gateId, { auto_approvable: true }),
      ]);
      const planned = await preview(target, loosen.segmentId);
      expect(planned.items).toMatchObject([
        {
          kind: 'operation_version',
          target: { gatekeeperId: enabled.gatekeeperId, name: RESTART.name },
          before: { version: 1 },
          classification: 'authority_widening',
          widening: [{ path: 'operation.auto_approvable', reason: 'loosened' }],
        },
      ]);
    });

    async function segmentProposal(segmentId: string): Promise<string | undefined> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ proposal_id: string }>(
          'select proposal_id from admin_proposal_segments where id = $1',
          [segmentId],
        ),
      );
      return result.rows[0]?.proposal_id;
    }

    it('applies what was previewed: the widening item confirmed, suspected credentials reviewed; versions the agent wrote, applied by the owner, recorded with the proposer', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const gate = await seedGate(target);
      const { proposal, segmentId } = await proposeFor(agent, target, [
        skillItem('token-check', `# Steps\n\n1. Run \`export API_TOKEN="${FAKE}"\` first.`),
        workerItem({ name: 'token-worker', systemPrompt: 'You check tokens.' }),
        operationItem(gate.gateId, { auto_approvable: true }),
      ]);
      const dryRun = await preview(target, segmentId);
      expect(dryRun.blockers).toEqual([]);
      expect(dryRun.suspectedSecretValues).toBe(1);
      expect(dryRun.suspectedSecretPaths).toEqual(['items[0].skill.markdown']);
      const digest = dryRun.digest ?? '';
      expect(dryRun.items.map((item) => [item.ordinal, item.classification])).toEqual([
        [1, expect.any(String)],
        [2, expect.any(String)],
        [3, 'authority_widening'],
      ]);
      const widening = dryRun.items
        .filter((item) => item.classification === 'authority_widening')
        .map((item) => item.ordinal);

      // The digest is the one reviewed.
      await expect(
        apply(target, segmentId, 'sha256:not-what-was-reviewed', {
          confirmedOrdinals: widening,
          credentialsReviewed: true,
        }),
      ).rejects.toBeInstanceOf(ChangePlanChangedError);
      // Each widening item is confirmed.
      await expect(
        apply(target, segmentId, digest, {
          confirmedOrdinals: widening.filter((ordinal) => ordinal !== 3),
          credentialsReviewed: true,
        }),
      ).rejects.toBeInstanceOf(ChangeConfirmationRequiredError);
      // The suspected credential is confirmed.
      const unreviewed = await thrownBy(
        apply(target, segmentId, digest, { confirmedOrdinals: widening }),
      );
      expect(unreviewed).toBeInstanceOf(CredentialReviewRequiredError);
      expect(JSON.stringify(unreviewed)).not.toContain(FAKE);
      // Refused three times, nothing changed.
      expect((await segmentRow(segmentId))?.status).toBe('proposed');
      const skillsBefore = await inTarget(target, (client) =>
        client.query('select 1 from skills where workspace_id = $1 and name = $2', [
          target.workspaceId,
          'token-check',
        ]),
      );
      expect(skillsBefore.rows).toHaveLength(0);

      const applied = await apply(target, segmentId, digest, {
        confirmedOrdinals: widening,
        credentialsReviewed: true,
      });
      expect(applied.segment).toMatchObject({
        id: segmentId,
        status: 'applied',
        decidedBy: { id: target.ownerPrincipalId, kind: 'human' },
        appliedSegmentId: applied.changeSegmentId,
      });
      expect(applied.segment.decidedAt).not.toBeNull();
      expect(await segmentRow(segmentId)).toMatchObject({
        status: 'applied',
        decided_by: target.ownerPrincipalId,
        applied_segment_id: applied.changeSegmentId,
      });

      // I-A7: the agent wrote what was published; the owner published it.
      const origins = await inTarget(target, (client) =>
        client.query<{ kind: string; origin: string }>(
          `select 'skill' as kind, origin from skills where workspace_id = $1 and name = $2
           union all
           select 'worker', origin from worker_definitions
            where workspace_id = $1 and definition ->> 'name' = $3`,
          [target.workspaceId, 'token-check', 'token-worker'],
        ),
      );
      expect(origins.rows).toEqual([
        { kind: 'skill', origin: 'agent' },
        { kind: 'worker', origin: 'agent' },
      ]);
      const record = await call<ChangeSegmentDetailWire>(
        ownerCaller(target),
        'get_change_segment',
        { segmentId: applied.changeSegmentId },
      );
      expect(record.segment).toMatchObject({
        status: 'applied',
        source: {
          kind: 'admin_proposal',
          name: `aa3b2-${tag}`,
          version: proposal.id,
          digest: proposal.segments[0]?.contentDigest,
        },
        proposedBy: null,
        adminProposal: {
          proposalId: proposal.id,
          proposalSegmentId: segmentId,
          proposedBy: { userId: user.id, displayName: user.displayName },
        },
        appliedBy: { id: target.ownerPrincipalId, kind: 'human' },
      });
      expect(record.items.map((item) => item.ordinal)).toEqual([1, 2, 3]);
      expect(await lastAudit(target.workspaceId, 'apply_admin_proposal_segment')).toMatchObject({
        actor_principal_id: target.ownerPrincipalId,
        resource_type: 'admin_proposal_segment',
        resource_id: segmentId,
        payload: {
          proposalId: proposal.id,
          changeSegmentId: applied.changeSegmentId,
          digest,
          credentialReview: { suspectedSecretValues: 1 },
        },
      });

      // Applied once: it is not open any more.
      const again = await thrownBy(
        apply(target, segmentId, digest, {
          confirmedOrdinals: widening,
          credentialsReviewed: true,
        }),
      );
      expect(again).toBeInstanceOf(AdminProposalSegmentNotOpenError);
      expect(again).toMatchObject({ details: { status: 'applied' } });
      await expect(preview(target, segmentId)).rejects.toBeInstanceOf(
        AdminProposalSegmentNotOpenError,
      );
      // The agent reads that it was applied.
      const read = await call<AdminProposalWire>(agent, 'agent_get_admin_proposal', {
        proposalId: proposal.id,
      });
      expect(read.segments[0]).toMatchObject({ status: 'applied' });
    });

    it('I-A8: what an intent resolves to is part of what was reviewed; a segment that changes nothing is not applied', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const first = await proposeFor(agent, target, [skillItem('shared', '# A\n\n1. One.')]);
      const second = await proposeFor(agent, target, [skillItem('shared', '# B\n\n1. Two.')]);
      const reviewed = await preview(target, first.segmentId);
      expect(reviewed.items[0]).toMatchObject({ newFamily: true, before: null });
      // In between, the other proposal starts the family by that name.
      await previewAndApply(target, second.segmentId);
      const refused = await thrownBy(apply(target, first.segmentId, reviewed.digest ?? ''));
      expect(refused).toBeInstanceOf(ChangePlanChangedError);
      expect(refused).toMatchObject({ code: 'change_plan_changed' });
      expect((await segmentRow(first.segmentId))?.status).toBe('proposed');
      // Previewed again, it is the family's next version.
      const now = await preview(target, first.segmentId);
      expect(now.items[0]).toMatchObject({ newFamily: false, before: { version: 1 } });

      const same = await proposeFor(agent, target, [skillItem('shared', '# B\n\n1. Two.')]);
      const nothing = await preview(target, same.segmentId);
      expect(nothing).toMatchObject({ unchanged: true, items: [{ unchanged: true }] });
      const unchanged = await thrownBy(apply(target, same.segmentId, nothing.digest ?? ''));
      expect(unchanged).toBeInstanceOf(AdminProposalSegmentUnchangedError);
      expect((await segmentRow(same.segmentId))?.status).toBe('proposed');
    });

    it('a withdrawn segment is neither previewed nor applied nor rejected', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const { proposal, segmentId } = await proposeFor(agent, target, [skillItem('withdrawn')]);
      const dryRun = await preview(target, segmentId);
      await call(agent, 'agent_withdraw_admin_proposal', { proposalId: proposal.id });
      for (const attempt of [
        () => apply(target, segmentId, dryRun.digest ?? ''),
        () => preview(target, segmentId),
        () =>
          call(ownerCaller(target), 'reject_admin_proposal_segment', {
            segmentId,
            reason: 'Too late.',
          }),
      ]) {
        const refused = await thrownBy(attempt());
        expect(refused).toBeInstanceOf(AdminProposalSegmentNotOpenError);
        expect(refused).toMatchObject({
          code: 'admin_proposal_segment_not_open',
          details: { status: 'withdrawn' },
        });
      }
      // Still listed here, as withdrawn.
      const listed = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(target),
        'list_admin_proposal_segments',
        { status: 'withdrawn' },
      );
      expect(listed.items.map((s) => [s.id, s.status, s.withdrawnOrigin])).toEqual([
        [segmentId, 'withdrawn', 'agent'],
      ]);
    });

    it('get_admin_proposal_segment_counts: what the list shows under proposed, counted, for this workspace only (S11 AA4e)', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const stranger = await newTarget();
      const counts = (of: Target) =>
        call<ReceivedAdminProposalCountsWire>(
          ownerCaller(of),
          'get_admin_proposal_segment_counts',
          {},
        );
      expect(await counts(target)).toEqual({ proposed: 0 });

      const first = await proposeFor(agent, target, [skillItem('counted-one')]);
      const second = await proposeFor(agent, target, [skillItem('counted-two')]);
      await proposeFor(agent, target, [skillItem('counted-three')]);
      expect(await counts(target)).toEqual({ proposed: 3 });
      const listed = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(target),
        'list_admin_proposal_segments',
        { status: 'proposed' },
      );
      expect(listed.items).toHaveLength(3);
      // Another workspace's owner counts none of them.
      expect(await counts(stranger)).toEqual({ proposed: 0 });

      // Decided or withdrawn: no longer waiting.
      await call(ownerCaller(target), 'reject_admin_proposal_segment', {
        segmentId: first.segmentId,
        reason: 'Not here.',
      });
      await call(agent, 'agent_withdraw_admin_proposal', {
        proposalId: second.proposal.id,
        reason: 'Superseded.',
      });
      expect(await counts(target)).toEqual({ proposed: 1 });
      expect(
        (
          await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
            ownerCaller(target),
            'list_admin_proposal_segments',
            { status: 'proposed' },
          )
        ).items,
      ).toHaveLength(1);
    });

    it('get_admin_proposal_segment_counts: the trial workspace counts none of the segments it sent out (S11 AA4e, #493 on #947)', async () => {
      // The segments table's RLS lets the trial workspace read the segments its own proposals
      // sent out; only `target_workspace_id = $1` keeps them out of its owner's count.
      const { agent, trial } = await administrator();
      const target = await newTarget();
      await proposeFor(agent, target, [skillItem('sent-one')]);
      await proposeFor(agent, target, [skillItem('sent-two')]);
      const counts = (of: Target) =>
        call<ReceivedAdminProposalCountsWire>(
          ownerCaller(of),
          'get_admin_proposal_segment_counts',
          {},
        );
      expect(await counts(target)).toEqual({ proposed: 2 });
      expect(await counts(trial)).toEqual({ proposed: 0 });
    });

    it('rejecting takes a reason; the owner and the platform read it, the agent reads only that it was rejected', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const { proposal, segmentId } = await proposeFor(agent, target, [skillItem('not-wanted')]);
      await expect(
        call(ownerCaller(target), 'reject_admin_proposal_segment', { segmentId }),
      ).rejects.toThrow();
      await expect(
        call(ownerCaller(target), 'reject_admin_proposal_segment', { segmentId, reason: '' }),
      ).rejects.toThrow();
      expect((await segmentRow(segmentId))?.status).toBe('proposed');

      const rejected = await call<ReceivedAdminProposalSegmentWire>(
        ownerCaller(target),
        'reject_admin_proposal_segment',
        { segmentId, reason: 'We do this by hand here.' },
      );
      expect(rejected).toMatchObject({
        id: segmentId,
        status: 'rejected',
        reason: 'We do this by hand here.',
        decidedBy: { id: target.ownerPrincipalId, kind: 'human' },
      });
      expect(await lastAudit(target.workspaceId, 'reject_admin_proposal_segment')).toMatchObject({
        actor_principal_id: target.ownerPrincipalId,
        resource_id: segmentId,
        payload: { proposalId: proposal.id },
      });
      const listed = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(target),
        'list_admin_proposal_segments',
        {},
      );
      expect(listed.items.find((s) => s.id === segmentId)).toMatchObject({
        status: 'rejected',
        reason: 'We do this by hand here.',
      });

      const byAgent = await call<AdminProposalWire>(agent, 'agent_get_admin_proposal', {
        proposalId: proposal.id,
      });
      expect(byAgent.segments[0]).toMatchObject({ status: 'rejected', reason: null });
      expect(JSON.stringify(byAgent)).not.toContain('by hand');
      const onPlatform = await call<AdminProposalWire>(platformCaller(user), 'get_admin_proposal', {
        proposalId: proposal.id,
      });
      expect(onPlatform.segments[0]).toMatchObject({
        status: 'rejected',
        reason: 'We do this by hand here.',
      });

      // Rejected is closed.
      expect(await thrownBy(preview(target, segmentId))).toMatchObject({
        details: { status: 'rejected' },
      });
    });

    it('legacy 420: a reason, a title or a description that looks like a credential reads masked to the owner, the platform and the agent', async () => {
      // #920 review P3-2: neither is refused when written (a reject reason never is), so the mask
      // on every read is what keeps the value from the next reader.
      const { user, agent } = await administrator();
      const target = await newTarget();
      const proposal = await call<AdminProposalWire>(agent, 'propose_admin_proposal', {
        title: `Disk triage with PGPASSWORD=${FAKE}`,
        description: `Run it with PGPASSWORD=${FAKE} set.`,
        sourceName: `aa3b2-mask-${tag}`,
        segments: [{ targetWorkspaceId: target.workspaceId, items: [skillItem('masked')] }],
      });
      const segmentId = proposal.segments[0]?.id ?? '';
      const rejected = await call<ReceivedAdminProposalSegmentWire>(
        ownerCaller(target),
        'reject_admin_proposal_segment',
        { segmentId, reason: `It printed PGPASSWORD=${FAKE} to the log.` },
      );
      expect(rejected.reason).toBe('It printed PGPASSWORD=[redacted] to the log.');
      expect(rejected.proposal).toMatchObject({
        title: 'Disk triage with PGPASSWORD=[redacted]',
        description: 'Run it with PGPASSWORD=[redacted] set.',
      });
      const ownerList = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(target),
        'list_admin_proposal_segments',
        {},
      );
      const onPlatform = await call<AdminProposalWire>(platformCaller(user), 'get_admin_proposal', {
        proposalId: proposal.id,
      });
      expect(onPlatform.segments[0]?.reason).toBe('It printed PGPASSWORD=[redacted] to the log.');
      const platformList = await call<ListEnvelope<{ id: string; title: string }>>(
        platformCaller(user),
        'list_admin_proposals',
        {},
      );
      const agentList = await call<ListEnvelope<{ id: string; title: string }>>(
        agent,
        'agent_list_admin_proposals',
        {},
      );
      expect(platformList.items.find((p) => p.id === proposal.id)?.title).toBe(
        'Disk triage with PGPASSWORD=[redacted]',
      );
      expect(agentList.items.find((p) => p.id === proposal.id)?.title).toBe(
        'Disk triage with PGPASSWORD=[redacted]',
      );
      for (const read of [rejected, ownerList, onPlatform, platformList, agentList]) {
        expect(JSON.stringify(read)).not.toContain(FAKE);
      }
      // The stored row is the record (I11): masked on read, kept as written.
      expect((await segmentRow(segmentId))?.reason).toContain(FAKE);
    });

    it('two decisions of one segment run one after the other: the second waits for the first and reads what it left (409 not open)', async () => {
      // #920 review P3-3: applying takes the segment's row lock first, so a withdrawal holding it
      // makes the apply wait, and the apply then refuses as not open — never a raw database error.
      const { user, agent } = await administrator();
      const target = await newTarget();
      const { proposal, segmentId } = await proposeFor(agent, target, [skillItem('raced')]);
      const dryRun = await preview(target, segmentId);
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let withdrawn: () => void = () => {};
      const withdrawing = new Promise<void>((resolve) => {
        withdrawn = resolve;
      });
      const holder = withPlatform(pool, { userId: user.id }, async (client) => {
        await withdrawAdminProposal(
          client,
          proposal.id,
          { reader: 'platform' },
          user.id,
          undefined,
        );
        withdrawn();
        await released;
      });
      await withdrawing;
      const applying = thrownBy(
        apply(target, segmentId, dryRun.digest ?? '', { confirmedOrdinals: [1] }),
      );
      // The apply is waiting on the segment's row lock before the withdrawal commits.
      let waiting = 0;
      for (let attempt = 0; attempt < 100 && waiting === 0; attempt += 1) {
        const locks = await withAdminClient(pool, (client) =>
          client.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where pid <> pg_backend_pid() and wait_event_type = 'Lock'
                and query like '%admin_proposal_segments%for update%'`,
          ),
        );
        waiting = locks.rows[0]?.n ?? 0;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBeGreaterThan(0);
      release();
      await holder;
      const refused = await applying;
      expect(refused).toBeInstanceOf(AdminProposalSegmentNotOpenError);
      expect(refused).toMatchObject({ details: { status: 'withdrawn' } });
      expect((await segmentRow(segmentId))?.status).toBe('withdrawn');
    });

    it('verifying an applied proposal of Skills only: its source is found and nothing it wrote runs through a gate; a later proposal of the same source name does not supersede it', async () => {
      // #920 review P3-1: a pack's later install of the same name supersedes an earlier one; two
      // proposals sharing a source name are two sources, each verified on its own.
      const { agent } = await administrator();
      const target = await newTarget();
      const sourceName = `aa3b2-verify-${tag}`;
      const first = await proposeFor(agent, target, [skillItem('verify-first')], sourceName);
      const firstApplied = await previewAndApply(target, first.segmentId);
      const second = await proposeFor(agent, target, [skillItem('verify-second')], sourceName);
      await previewAndApply(target, second.segmentId);
      const verified = await call<ChangeVerificationResultWire>(
        ownerCaller(target),
        'verify_change_segment',
        { segmentId: firstApplied.changeSegmentId },
      );
      expect(verified.verification).toMatchObject({ sourceFound: true, requirements: [] });
      expect(verified.segment).toMatchObject({
        id: firstApplied.changeSegmentId,
        source: { kind: 'admin_proposal', name: sourceName },
      });
    });

    it('verifying an applied proposal probes the gates what it wrote runs through (legacy 630): the Operation item’s gate and the gates the Worker item’s version names — every one must answer', async () => {
      const { agent } = await administrator();
      /** In a new target: a gate the proposal's Operation item revises, a gate the Worker's family
       *  already has (its version from the proposal keeps it, AA3b-2 F5), and a gate nothing it
       *  writes runs through; the proposal applied. */
      async function appliedInNewTarget() {
        const target = await newTarget();
        const operationGate = await seedGate(target);
        const workerGate = await seedGate(target);
        const unused = await seedGate(target);
        await seedWorkerFamily(target, 'worker', {
          name: 'gated-worker',
          systemPrompt: 'You restart containers.',
          gates: [workerGate.gatekeeperId],
        });
        const { segmentId } = await proposeFor(agent, target, [
          skillItem('restart-check'),
          workerItem({ name: 'gated-worker', systemPrompt: 'You restart containers, carefully.' }),
          operationItem(operationGate.gateId, { auto_approvable: true }),
        ]);
        const applied = await previewAndApply(target, segmentId);
        const verify = () =>
          call<ChangeVerificationResultWire>(ownerCaller(target), 'verify_change_segment', {
            segmentId: applied.changeSegmentId,
          });
        return { target, operationGate, workerGate, unused, verify };
      }
      const answering = new Set<string>();
      const probed: string[] = [];
      setGatekeeperReadHandlerDeps({
        gatekeeperClient: {
          health: async (gate: GateTarget) => {
            probed.push(gate.endpoint);
            if ([...answering].some((gateId) => gate.endpoint.includes(gateId))) {
              return { status: 'ok' };
            }
            throw new Error('connection refused');
          },
        } as unknown as GatekeeperClient,
      });
      try {
        // The Worker's gate does not answer: the items are in effect, the run does not pass.
        const down = await appliedInNewTarget();
        answering.add(down.operationGate.gateId);
        answering.add(down.unused.gateId);
        const failed = await down.verify();
        expect(failed.verification?.items.map((item) => item.state)).toEqual([
          'in_effect',
          'in_effect',
          'in_effect',
        ]);
        expect(failed.verification).toMatchObject({ passed: false, sourceFound: true });
        expect(failed.segment.status).toBe('verification_failed');
        // Both gates are of one system; a pack's requirement would pass with one answering.
        expect(failed.verification?.requirements).toHaveLength(1);
        expect(failed.verification?.requirements[0]).toMatchObject({
          connector: 'http',
          state: 'connected',
          met: false,
        });
        expect(
          new Map(
            failed.verification?.requirements[0]?.gates.map((gate) => [gate.id, gate.health]),
          ),
        ).toEqual(
          new Map([
            [down.operationGate.gatekeeperId, 'ok'],
            [down.workerGate.gatekeeperId, 'unreachable'],
          ]),
        );
        // A gate of the workspace nothing it wrote runs through is not probed.
        expect(probed.some((endpoint) => endpoint.includes(down.unused.gateId))).toBe(false);
        expect(
          (await lastAudit(down.target.workspaceId, 'change_segment.verify'))?.payload,
        ).toMatchObject({ passed: false, requirements: [{ connector: 'http', met: false }] });

        // Every gate it runs through answers: it passes.
        const up = await appliedInNewTarget();
        answering.add(up.operationGate.gateId);
        answering.add(up.workerGate.gateId);
        const passed = await up.verify();
        expect(passed.verification).toMatchObject({
          passed: true,
          requirements: [{ connector: 'http', state: 'connected', met: true }],
        });
        expect(passed.verification?.requirements[0]?.gates).toHaveLength(2);
        expect(passed.segment.status).toBe('verified');
      } finally {
        setGatekeeperReadHandlerDeps({});
      }
    });

    it('rolling back the record rolls the proposal segment back with it; once the trial workspace is purged, the record alone', async () => {
      const { user, trial, agent } = await administrator();
      const target = await newTarget();
      const kept = await proposeFor(agent, target, [skillItem('rolled')]);
      const applied = await previewAndApply(target, kept.segmentId);
      const dryRun = await call<ChangeRollbackPreviewWire>(
        ownerCaller(target),
        'preview_roll_back_change_segment',
        { segmentId: applied.changeSegmentId },
      );
      expect(dryRun.possible).toBe(true);
      const rolledBack = await call<ChangeSegmentWire>(
        ownerCaller(target),
        'roll_back_change_segment',
        {
          segmentId: applied.changeSegmentId,
          confirmedOrdinals: dryRun.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        },
      );
      expect(rolledBack).toMatchObject({ status: 'rolled_back' });
      expect(await segmentRow(kept.segmentId)).toMatchObject({
        status: 'rolled_back',
        rolled_back_by: target.ownerPrincipalId,
      });
      const byAgent = await call<AdminProposalWire>(agent, 'agent_get_admin_proposal', {
        proposalId: kept.proposal.id,
      });
      expect(byAgent.segments[0]).toMatchObject({ status: 'rolled_back' });
      expect(byAgent.segments[0]?.rolledBackAt).not.toBeNull();

      // The trial workspace goes, its proposals with it; what was applied here stays, and so does
      // who proposed it.
      const orphan = await proposeFor(agent, target, [skillItem('orphaned')]);
      const orphanApplied = await previewAndApply(target, orphan.segmentId);
      await withAdminClient(pool, (client) =>
        client.query(`update workspaces set status = 'disabled' where id = $1`, [
          trial.workspaceId,
        ]),
      );
      await purgeWorkspace(pool, { workspaceId: trial.workspaceId, confirm: true, force: true });
      expect(await segmentRow(orphan.segmentId)).toBeUndefined();
      const record = await call<ChangeSegmentDetailWire>(
        ownerCaller(target),
        'get_change_segment',
        { segmentId: orphanApplied.changeSegmentId },
      );
      expect(record.segment.adminProposal).toEqual({
        proposalId: orphan.proposal.id,
        proposalSegmentId: orphan.segmentId,
        proposedBy: { userId: user.id, displayName: user.displayName },
      });
      const local = await call<ChangeSegmentWire>(ownerCaller(target), 'roll_back_change_segment', {
        segmentId: orphanApplied.changeSegmentId,
      });
      expect(local).toMatchObject({ status: 'rolled_back' });
      // Its list here is empty: the segments went with their trial workspace.
      const listed = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(target),
        'list_admin_proposal_segments',
        {},
      );
      expect(listed.items).toEqual([]);
    });

    it('governance 0033: the record names the proposal segment it applied, as proposed, and nothing else', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const other = await newTarget();
      const { proposal, segmentId } = await proposeFor(agent, target, [skillItem('guarded')]);
      const forOther = await proposeFor(agent, other, [skillItem('guarded')]);
      const digest = proposal.segments[0]?.contentDigest ?? '';
      const insert = (overrides: Record<string, unknown>) => {
        const row = {
          sourceName: `aa3b2-${tag}`,
          sourceVersion: proposal.id,
          digest,
          proposalId: proposal.id,
          proposalSegmentId: segmentId,
          proposedByUser: user.id,
          proposerDisplayName: user.displayName,
          ...overrides,
        };
        return inTarget(target, (client) =>
          client.query(
            `insert into change_segments
               (workspace_id, plan_id, channel, source_kind, source_name, source_version,
                source_digest, reviewed_digest, proposed_by, applied_by, admin_proposal_id,
                admin_proposal_segment_id, proposed_by_user, proposer_display_name)
             values ($1, gen_random_uuid(), 'human', 'admin_proposal', $2, $3, $4, 'sha256:x',
                     null, $5, $6, $7, $8, $9)`,
            [
              target.workspaceId,
              row.sourceName,
              row.sourceVersion,
              row.digest,
              target.ownerPrincipalId,
              row.proposalId,
              row.proposalSegmentId,
              row.proposedByUser,
              row.proposerDisplayName,
            ],
          ),
        );
      };
      await expect(insert({ digest: 'sha256:forged' })).rejects.toThrow(
        /source and proposer are its proposal segment/,
      );
      await expect(insert({ sourceName: 'someone-else' })).rejects.toThrow(
        /source and proposer are its proposal segment/,
      );
      await expect(insert({ proposedByUser: randomUUID() })).rejects.toThrow(
        /source and proposer are its proposal segment/,
      );
      await expect(insert({ proposerDisplayName: 'Someone Else' })).rejects.toThrow(
        /source and proposer are its proposal segment/,
      );
      await expect(
        insert({ proposalSegmentId: forOther.segmentId, proposalId: forOther.proposal.id }),
      ).rejects.toThrow(/addressed to this workspace/);
      await expect(insert({ sourceVersion: randomUUID() })).rejects.toThrow(
        /change_segments_proposer/,
      );
      // A pack source names no proposal.
      await expect(
        inTarget(target, (client) =>
          client.query(
            `insert into change_segments
               (workspace_id, plan_id, channel, source_kind, source_name, source_version,
                source_digest, reviewed_digest, proposed_by, applied_by, admin_proposal_id)
             values ($1, gen_random_uuid(), 'human', 'pack', 'p', '1', 'sha256:x', 'sha256:x',
                     $2, $2, $3)`,
            [target.workspaceId, target.ownerPrincipalId, proposal.id],
          ),
        ),
      ).rejects.toThrow(/change_segments_proposer/);
      // The proposal segment is applied by the record that names it — not by another of this
      // workspace's records — and rolled back with it.
      const elsewhere = await proposeFor(agent, target, [skillItem('recorded-elsewhere')]);
      const otherRecord = await previewAndApply(target, elsewhere.segmentId);
      await expect(
        inTarget(target, (client) =>
          client.query(
            `update admin_proposal_segments
                set status = 'applied', decided_by = $2, applied_segment_id = $3
              where id = $1`,
            [segmentId, target.ownerPrincipalId, otherRecord.changeSegmentId],
          ),
        ),
      ).rejects.toThrow(/applied_segment_id is the change segment that records this segment/);
      // #916 review (#488 P3-a): who applied or rolled it back is the person of this transaction,
      // never another person of the target the writer names; and never the platform plane.
      const member = await createUser(pool, {
        login: `aa3b2-member-${randomUUID().slice(0, 8)}`,
        displayName: 'Target Member',
      });
      const memberPrincipalId = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, 'human', 'member', 'Target Member', $3)`,
          [target.workspaceId, memberPrincipalId, member.id],
        ),
      );
      await expect(
        inTarget(target, (client) =>
          client.query(
            `update admin_proposal_segments
                set status = 'applied', decided_by = $2, applied_segment_id = $3
              where id = $1`,
            [segmentId, memberPrincipalId, otherRecord.changeSegmentId],
          ),
        ),
      ).rejects.toThrow(/a segment is applied by the person of this transaction/);
      await previewAndApply(target, segmentId);
      await expect(
        inTarget(target, (client) =>
          client.query(
            `update admin_proposal_segments set status = 'rolled_back', rolled_back_by = $2
              where id = $1`,
            [segmentId, memberPrincipalId],
          ),
        ),
      ).rejects.toThrow(/a segment is rolled back by the person of this transaction/);
      await expect(
        withPlatform(pool, { userId: user.id }, (client) =>
          client.query(
            `update admin_proposal_segments set status = 'rolled_back', rolled_back_by = $2
              where id = $1`,
            [segmentId, target.ownerPrincipalId],
          ),
        ),
      ).rejects.toThrow(/is rolled_back in its target workspace/);
      await expect(
        inTarget(target, (client) =>
          client.query(
            `update admin_proposal_segments set status = 'rolled_back', rolled_back_by = $2
              where id = $1`,
            [segmentId, target.ownerPrincipalId],
          ),
        ),
      ).rejects.toThrow(/rolled back with the change segment that records it/);
      // Applied once: a second record of it is refused.
      await expect(insert({})).rejects.toThrow(/while it is proposed, not applied/);
    });

    it('a proposal with one segment applied and another still proposed is partially applied, in the list filter as on the wire', async () => {
      const { user, agent } = await administrator();
      const first = await newTarget();
      const second = await newTarget();
      const proposal = await call<AdminProposalWire>(agent, 'propose_admin_proposal', {
        title: 'Two places',
        sourceName: `aa3b2-${tag}`,
        segments: [
          { targetWorkspaceId: first.workspaceId, items: [skillItem('partly')] },
          { targetWorkspaceId: second.workspaceId, items: [skillItem('partly')] },
        ],
      });
      await previewAndApply(first, proposal.segments[0]?.id as string);
      const listed = await call<ListEnvelope<{ id: string; status: string }>>(
        platformCaller(user),
        'list_admin_proposals',
        { status: 'partially_applied' },
      );
      expect(listed.items.map((item) => [item.id, item.status])).toContainEqual([
        proposal.id,
        'partially_applied',
      ]);
      for (const item of listed.items) expect(item.status, item.id).toBe('partially_applied');
      for (const status of ['proposed', 'applied', 'closed'] as const) {
        const other = await call<ListEnvelope<{ id: string }>>(
          platformCaller(user),
          'list_admin_proposals',
          { status },
        );
        expect(
          other.items.map((item) => item.id),
          status,
        ).not.toContain(proposal.id);
      }
      const read = await call<AdminProposalWire>(agent, 'agent_get_admin_proposal', {
        proposalId: proposal.id,
      });
      expect(read.status).toBe('partially_applied');
      expect(read.segmentCounts).toMatchObject({ proposed: 1, applied: 1 });
    });

    it('AA4c (coordinator, 2026-11-02): a proposal keeps the target it was proposed with — once the administrator drops it, the owner reads it blocked and applying is refused; choosing it again restores what was reviewed', async () => {
      const { user, trial, agent } = await administrator();
      const target = await newTarget();
      const other = await newTarget();
      const { proposal, segmentId } = await proposeFor(agent, target, [skillItem('frozen')]);
      // Two more to `target`, for the ways out the 409 names (#937 R-1).
      const toReject = await proposeFor(agent, target, [skillItem('frozen-reject')]);
      const toWithdraw = await proposeFor(agent, target, [skillItem('frozen-withdraw')]);
      const reviewed = await preview(target, segmentId);
      expect(reviewed.targetChosen).toBe(true);
      expect(reviewed.digest).toMatch(/^sha256:/);

      // On the platform's admin agent page the administrator swaps `target` for `other`.
      const changed = await call<AdminAgentTargetsResultWire>(
        platformCaller(user),
        'set_admin_agent_targets',
        { trialWorkspaceId: trial.workspaceId, targetWorkspaceIds: [other.workspaceId] },
      );
      expect(changed).toMatchObject({
        added: [other.workspaceId],
        removed: [target.workspaceId],
      });

      // The proposal does not follow: its segment is still `target`'s, and `other` has none.
      const theirs = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(other),
        'list_admin_proposal_segments',
        {},
      );
      expect(theirs.items).toEqual([]);
      const blocked = await preview(target, segmentId);
      expect(blocked).toMatchObject({ targetChosen: false, digest: null });
      expect(blocked.segment.id).toBe(segmentId);
      // Applying what was reviewed before the change is refused, and nothing is written.
      const refused = await thrownBy(apply(target, segmentId, reviewed.digest as string));
      expect(refused).toBeInstanceOf(AdminProposalTargetNoLongerChosenError);
      expect(mapCapabilityError(refused)).toMatchObject({
        status: 409,
        code: 'admin_proposal_target_no_longer_chosen',
      });
      expect(mapDispatchError(refused).code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);
      expect((await segmentRow(segmentId))?.status).toBe('proposed');
      const recorded = await inTarget(target, (client) =>
        client.query('select 1 from change_segments where admin_proposal_segment_id = $1', [
          segmentId,
        ]),
      );
      expect(recorded.rows).toHaveLength(0);
      // What the refusal tells the owner to do still works with the target dropped (#937 R-1,
      // governance 0036's segment guard holds only applying to a chosen target): the owner
      // rejects, and the agent withdraws its own proposal.
      await expect(
        call<ReceivedAdminProposalSegmentWire>(
          ownerCaller(target),
          'reject_admin_proposal_segment',
          { segmentId: toReject.segmentId, reason: 'Not chosen for us any more.' },
        ),
      ).resolves.toMatchObject({ status: 'rejected' });
      expect((await segmentRow(toReject.segmentId))?.status).toBe('rejected');
      await call(agent, 'agent_withdraw_admin_proposal', { proposalId: toWithdraw.proposal.id });
      expect((await segmentRow(toWithdraw.segmentId))?.status).toBe('withdrawn');
      // The agent proposing it again to `target` is refused; to `other`, it goes through.
      const again = await thrownBy(
        callUnchosen(agent, 'propose_admin_proposal', {
          title: 'Again',
          sourceName: `aa3b2-${tag}`,
          segments: [{ targetWorkspaceId: target.workspaceId, items: [skillItem('frozen')] }],
        }),
      );
      expect(again).toBeInstanceOf(AdminProposalTargetNotChosenError);
      await expect(
        callUnchosen(agent, 'propose_admin_proposal', {
          title: 'Again',
          sourceName: `aa3b2-${tag}`,
          segments: [{ targetWorkspaceId: other.workspaceId, items: [skillItem('frozen')] }],
        }),
      ).resolves.toMatchObject({ segments: [{ targetWorkspaceId: other.workspaceId }] });

      // governance 0036, the database's second wall. A proposal written past the kernel — in one
      // transaction, as 0032 requires — gets no workspace segment to a target its proposer did
      // not choose...
      const writeCopy = (targetWorkspaceId: string) =>
        withWorkspace(
          pool,
          { workspaceId: trial.workspaceId, principalId: trial.ownerPrincipalId },
          async (client) => {
            const copy = await client.query<{ id: string }>(
              `insert into admin_proposals
                 (workspace_id, proposed_by, proposed_by_user, proposer_display_name, session_id,
                  origin, title, description, source_name, content_digest)
               select workspace_id, proposed_by, proposed_by_user, proposer_display_name,
                      session_id, origin, 'Written past the kernel', description, source_name,
                      content_digest
                 from admin_proposals where id = $1
               returning id`,
              [proposal.id],
            );
            await client.query(
              `insert into admin_proposal_segments
                 (workspace_id, proposal_id, ordinal, authority, target_workspace_id, items,
                  content_digest)
               select workspace_id, $2, 1, 'workspace', $3, items, content_digest
                 from admin_proposal_segments where id = $1`,
              [segmentId, copy.rows[0]?.id, targetWorkspaceId],
            );
          },
        );
      const third = await newTarget();
      await expect(writeCopy(third.workspaceId)).rejects.toThrow(
        /not among its proposer's targets/,
      );
      // ...nor to one another administrator in the same trial workspace chose for their own agent
      // (#937 G08): the targets are the proposer's.
      const colleague = await createUser(pool, {
        login: `aa3b2-colleague-${randomUUID().slice(0, 8)}`,
        displayName: 'Colleague',
        platformRole: 'admin',
      });
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, 'human', 'member', $3, $4)`,
          [trial.workspaceId, randomUUID(), colleague.displayName, colleague.id],
        ),
      );
      await call(platformCaller(colleague), 'set_admin_agent_targets', {
        trialWorkspaceId: trial.workspaceId,
        targetWorkspaceIds: [third.workspaceId],
      });
      await expect(writeCopy(third.workspaceId)).rejects.toThrow(
        /not among its proposer's targets/,
      );
      await expect(writeCopy(other.workspaceId)).resolves.toBeUndefined();
      // ...nor moved to applied, though its record is otherwise right.
      await inTarget(target, (client) =>
        client.query(
          `insert into change_segments
             (workspace_id, plan_id, channel, source_kind, source_name, source_version,
              source_digest, reviewed_digest, proposed_by, applied_by, admin_proposal_id,
              admin_proposal_segment_id, proposed_by_user, proposer_display_name)
           values ($1, gen_random_uuid(), 'human', 'admin_proposal', $2, $3, $4, $10,
                   null, $5, $6, $7, $8, $9)`,
          [
            target.workspaceId,
            `aa3b2-${tag}`,
            proposal.id,
            proposal.segments[0]?.contentDigest,
            target.ownerPrincipalId,
            proposal.id,
            segmentId,
            user.id,
            user.displayName,
            reviewed.digest,
          ],
        ),
      );
      const forged = await inTarget(target, (client) =>
        client.query<{ id: string }>(
          'select id from change_segments where admin_proposal_segment_id = $1',
          [segmentId],
        ),
      );
      const forgedId = forged.rows[0]?.id as string;
      const markApplied = () =>
        inTarget(target, (client) =>
          client.query(
            `update admin_proposal_segments
                set status = 'applied', decided_by = $2, applied_segment_id = $3
              where id = $1`,
            [segmentId, target.ownerPrincipalId, forgedId],
          ),
        );
      await expect(markApplied()).rejects.toThrow(/not among its proposer's targets/);
      expect((await segmentRow(segmentId))?.status).toBe('proposed');
      await withAdminClient(pool, (client) =>
        client.query('delete from change_segments where id = $1', [forgedId]),
      );

      // Chosen again: the same digest as before, and it applies.
      await call(platformCaller(user), 'set_admin_agent_targets', {
        trialWorkspaceId: trial.workspaceId,
        targetWorkspaceIds: [other.workspaceId, target.workspaceId],
      });
      const restored = await preview(target, segmentId);
      expect(restored).toMatchObject({ targetChosen: true, digest: reviewed.digest });
      await previewAndApply(target, segmentId);
      expect((await segmentRow(segmentId))?.status).toBe('applied');
    });

    it('F12: only the owner of the workspace a segment is addressed to reaches it', async () => {
      const { agent } = await administrator();
      const target = await newTarget();
      const stranger = await newTarget();
      const { segmentId } = await proposeFor(agent, target, [skillItem('mine')]);
      const dryRun = await preview(target, segmentId);

      // Another workspace's owner: as if there were no such segment.
      for (const [name, params] of [
        ['preview_admin_proposal_segment', { segmentId }],
        ['apply_admin_proposal_segment', { segmentId, reviewedDigest: dryRun.digest }],
        ['reject_admin_proposal_segment', { segmentId, reason: 'Not mine.' }],
      ] as const) {
        const refused = await thrownBy(call(ownerCaller(stranger), name, params));
        expect(refused, name).toBeInstanceOf(AdminProposalSegmentNotFoundError);
        expect(refused, name).toMatchObject({ code: 'admin_proposal_segment_not_found' });
      }
      const unknown = await thrownBy(preview(target, randomUUID()));
      expect(unknown).toBeInstanceOf(AdminProposalSegmentNotFoundError);
      const theirs = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(stranger),
        'list_admin_proposal_segments',
        {},
      );
      expect(theirs.items).toEqual([]);
      expect(await call(ownerCaller(stranger), 'get_admin_proposal_segment_counts', {})).toEqual({
        proposed: 0,
      });

      // In the target itself: a member, an owner-role service account, the admin agent's Handle.
      const memberId = randomUUID();
      const serviceId = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'member', 'member'), ($1, $3, 'service', 'owner', 'ci-bot')`,
          [target.workspaceId, memberId, serviceId],
        ),
      );
      const member = humanCaller(target.workspaceId, memberId, 'member');
      const service = humanCaller(target.workspaceId, serviceId, 'owner', 'service');
      for (const name of [
        'list_admin_proposal_segments',
        'get_admin_proposal_segment_counts',
        'preview_admin_proposal_segment',
        'apply_admin_proposal_segment',
        'reject_admin_proposal_segment',
      ]) {
        const params =
          name === 'list_admin_proposal_segments' || name === 'get_admin_proposal_segment_counts'
            ? {}
            : { segmentId, reviewedDigest: dryRun.digest, reason: 'No.' };
        for (const [who, caller] of [
          ['member', member],
          ['service', service],
        ] as const) {
          await expect(call(caller, name, params), `${who} ${name}`).rejects.toBeInstanceOf(
            ForbiddenError,
          );
        }
        await expect(call(agent, name, params), `agent ${name}`).rejects.toThrow();
      }
      expect((await segmentRow(segmentId))?.status).toBe('proposed');
    });
  },
);
