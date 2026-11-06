import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdminProposalPackExportWire,
  AdminProposalSegmentApplyResultWire,
  AdminProposalSegmentPreviewWire,
  AdminProposalWire,
  ChangeVerificationResultWire,
  PackInstallPreviewWire,
  PackInstallResultWire,
  PackWire,
  Role,
} from '@nexttime/shared';
import { CHANGE_VERIFICATION_COOLDOWN_SECONDS } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { parseOntologyDefinition } from '../../substrate/ontology/index.js';
import { issueAdminAgentHandle } from '../admin-agent/index.js';
import { AdminProposalSegmentNotFoundError, derivePackComponentId } from '../change-plan/index.js';
import { type UserRow, createUser } from '../identity/index.js';
import { AdminProposalPackNotExportableError } from '../packs/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withAdminClient } from './auth.js';
import { dispatchCapability } from './dispatch.js';
import { authenticateHandle } from './handle-auth.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/admin-proposal-pack-export.integration.test (S11 AA5d-2; real Postgres,
 * auto-skip without DATABASE_URL): `export_admin_proposal_pack` end to end through
 * `dispatchCapability` — an admin proposal's workspace segment, applied and verified in its target,
 * exported by a platform administrator as version 1 of a pack named by the proposal's source name;
 * those files in the extra packs directory (`EXTRA_PACKS_DIR`) are a pack the target already has
 * (`up_to_date`: the same ids, the same content) and another workspace installs and verifies like
 * any. Refused while the segment is not applied or what it applied is no longer verified there
 * (governance 0039 answers only that boolean); anything but a workspace segment is not found; only
 * a platform administrator's console session reaches it. Every result is checked against its own
 * `resultSchema` (`KERNEL_VALIDATE_RESULTS=1`, vitest.config.ts).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

type Target = { readonly workspaceId: string; readonly ownerPrincipalId: string };

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

const ownerCaller = (target: Target) =>
  humanCaller(target.workspaceId, target.ownerPrincipalId, 'owner');

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

const SKILL_MARKDOWN = '# Triage\n\nRead the ticket, then label it.\n';

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA5d-2 an applied admin proposal segment exported as a pack (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let tag: string;
    let previousSwitch: string | undefined;
    let packsDir: string | undefined;

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

    afterEach(async () => {
      Reflect.deleteProperty(process.env, 'EXTRA_PACKS_DIR');
      if (packsDir) await rm(packsDir, { recursive: true, force: true });
      packsDir = undefined;
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    const call = <T>(caller: ResolvedCaller, name: string, params: unknown = {}) =>
      dispatchCapability({ pool }, caller, name, params) as Promise<T>;

    async function newWorkspace(owner: UserRow, purpose: 'standard' | 'admin_trial') {
      return createWorkspaceWithOwner(pool, {
        name: `aa5d2-${purpose}-${randomUUID().slice(0, 8)}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose,
      });
    }

    async function newTarget(): Promise<Target> {
      const owner = await createUser(pool, {
        login: `aa5d2-owner-${randomUUID().slice(0, 8)}`,
        displayName: 'Target Owner',
      });
      return newWorkspace(owner, 'standard');
    }

    /** A platform administrator, and their admin agent's Handle in a trial workspace of theirs. */
    async function administrator() {
      const suffix = randomUUID().slice(0, 8);
      const user = await createUser(pool, {
        login: `aa5d2-admin-${suffix}`,
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
      const agent: ResolvedCaller = { channel: 'handle', claims };
      return { user, trial, agent };
    }

    /** Proposes one segment for `target` (its target chosen first, as the platform's admin agent
     *  page does, AA4c) and returns the segment's id. */
    async function proposeFor(
      agent: ResolvedCaller,
      target: Target,
      sourceName: string,
      items: readonly Record<string, unknown>[],
    ): Promise<string> {
      if (agent.channel !== 'handle') throw new Error('not an agent');
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into admin_agent_targets
             (workspace_id, principal_id, target_workspace_id, chosen_by_user)
           select p.workspace_id, p.id, $3, p.user_id from principals p
            where p.workspace_id = $1 and p.id = $2
           on conflict do nothing`,
          [agent.claims.ws, agent.claims.obo, target.workspaceId],
        ),
      );
      const proposal = await call<AdminProposalWire>(agent, 'propose_admin_proposal', {
        title: 'Ticket triage everywhere',
        description: 'What the trial workspace settled on.',
        sourceName,
        segments: [{ targetWorkspaceId: target.workspaceId, items }],
      });
      const segmentId = proposal.segments[0]?.id;
      if (!segmentId) throw new Error('propose: no segment');
      return segmentId;
    }

    /** Previews, then applies what the preview showed, confirming every widening item. */
    async function previewAndApply(target: Target, segmentId: string) {
      const dryRun = await call<AdminProposalSegmentPreviewWire>(
        ownerCaller(target),
        'preview_admin_proposal_segment',
        { segmentId },
      );
      if (dryRun.digest === null) throw new Error(`blocked: ${JSON.stringify(dryRun.blockers)}`);
      return call<AdminProposalSegmentApplyResultWire>(
        ownerCaller(target),
        'apply_admin_proposal_segment',
        {
          segmentId,
          reviewedDigest: dryRun.digest,
          confirmedOrdinals: dryRun.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        },
      );
    }

    /** The ticket desk the trial workspace settled on: an ontology family, a Skill, a Worker
     *  mounting it. */
    function ticketDesk(sourceName: string, markdown = SKILL_MARKDOWN) {
      return [
        {
          kind: 'ontology_version',
          family: sourceName,
          definition: parseOntologyDefinition(
            `objectTypes:\n  - name: AaExportTicket${tag}\n    description: A ticket.\nlinkTypes:\n  - name: aa_export_follows_${tag}\n    domain: AaExportTicket${tag}\n    range: AaExportTicket${tag}\n    description: One ticket follows another.\n`,
          ),
        },
        {
          kind: 'skill_version',
          skill: {
            name: 'ticket-triage',
            description: 'Triage a ticket.',
            markdown,
            applicable: { gateKinds: ['http'] },
          },
        },
        {
          kind: 'worker_definition_version',
          definition: {
            name: 'ticket-worker',
            description: 'Triages tickets',
            systemPrompt: 'You triage tickets.',
            skills: ['ticket-triage'],
          },
        },
      ];
    }

    /** `pack`'s files laid out as the host's `config/packs/` holds them, and the deployment told
     *  where that is. */
    async function putInExtraPacks(pack: AdminProposalPackExportWire): Promise<void> {
      packsDir ??= await mkdtemp(path.join(tmpdir(), 'aa5d2-packs-'));
      for (const file of pack.files) {
        const at = path.join(packsDir, ...file.path.split('/'));
        await mkdir(path.dirname(at), { recursive: true });
        await writeFile(at, file.content);
      }
      process.env.EXTRA_PACKS_DIR = packsDir;
    }

    async function packIn(target: Target, name: string): Promise<PackWire | undefined> {
      const listed = await call<{ items: PackWire[] }>(ownerCaller(target), 'list_packs');
      return listed.items.find((pack) => pack.name === name);
    }

    it('exported once verified: the target already has it up to date, another workspace installs and verifies it', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const sourceName = `aa5d2-desk-${tag}`;
      const segmentId = await proposeFor(agent, target, sourceName, ticketDesk(sourceName));
      const applied = await previewAndApply(target, segmentId);
      // Applying verifies it once (AA5f).
      expect(applied.verification).toMatchObject({ passed: true });

      const params = {
        segmentId,
        summary: 'Ticket triage, from the admin agent.',
        notes: 'Closing a ticket stays approved.',
      };
      const pack = await call<AdminProposalPackExportWire>(
        platformCaller(user),
        'export_admin_proposal_pack',
        params,
      );
      expect(pack).toMatchObject({ name: sourceName, version: 1, omitted: [] });
      expect(pack.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(pack.files.map((file) => file.path)).toEqual([
        `${sourceName}/1/ontology/${sourceName}.yaml`,
        `${sourceName}/1/pack.yaml`,
        `${sourceName}/1/skills/ticket-triage.md`,
        `${sourceName}/1/workers/ticket-worker.yaml`,
      ]);
      // Exporting writes nothing: the same segment, summary and notes give the same pack.
      expect(
        await call<AdminProposalPackExportWire>(
          platformCaller(user),
          'export_admin_proposal_pack',
          params,
        ),
      ).toEqual(pack);

      await putInExtraPacks(pack);
      // The workspace it was applied to has exactly this: the same family ids, the same content.
      expect(await packIn(target, sourceName)).toMatchObject({
        source: 'extra',
        status: 'up_to_date',
        installedVersion: 1,
        summary: params.summary,
      });

      // Another workspace installs it like any pack, and its first verification passes.
      const other = await newTarget();
      expect(await packIn(other, sourceName)).toMatchObject({ status: 'not_installed' });
      const preview = await call<PackInstallPreviewWire>(
        ownerCaller(other),
        'preview_pack_install',
        {
          name: sourceName,
        },
      );
      expect(preview.items.map((item) => item.kind)).toEqual([
        'ontology_version',
        'skill_version',
        'worker_definition_version',
      ]);
      const installed = await call<PackInstallResultWire>(ownerCaller(other), 'install_pack', {
        name: sourceName,
        version: 1,
        reviewedDigest: preview.digest,
        confirmedOrdinals: preview.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      });
      expect(installed.pack).toMatchObject({
        source: 'extra',
        status: 'up_to_date',
        installedVersion: 1,
      });
      expect(installed.verification).toMatchObject({ passed: true, sourceFound: true });
      // The same ids in both workspaces: the Skill and the Worker are the families the source name
      // derives.
      const skillIds = await Promise.all(
        [target, other].map((workspace) =>
          withWorkspace(
            pool,
            { workspaceId: workspace.workspaceId, principalId: workspace.ownerPrincipalId },
            (client) =>
              client.query<{ id: string }>(
                `select distinct id from skills where workspace_id = $1 and name = 'ticket-triage'`,
                [workspace.workspaceId],
              ),
          ),
        ),
      );
      const derived = derivePackComponentId(sourceName, 'skill', 'ticket-triage');
      expect(skillIds.map((result) => result.rows.map((row) => row.id))).toEqual([
        [derived],
        [derived],
      ]);

      // Now that the deployment has it, exporting again gives the same pack; a different summary
      // would be a different pack by a name this deployment already has.
      expect(
        await call<AdminProposalPackExportWire>(
          platformCaller(user),
          'export_admin_proposal_pack',
          params,
        ),
      ).toEqual(pack);
      const taken = await thrownBy(
        call(platformCaller(user), 'export_admin_proposal_pack', {
          ...params,
          summary: 'Another summary.',
        }),
      );
      expect(taken).toBeInstanceOf(AdminProposalPackNotExportableError);
      expect(
        (taken as AdminProposalPackNotExportableError).details.problems.map(
          (problem) => problem.code,
        ),
      ).toEqual(['pack_name_taken']);
    });

    it('refused while not applied, or no longer verified where it was; 409 with every problem', async () => {
      const { user, agent } = await administrator();
      const target = await newTarget();
      const sourceName = `aa5d2-wait-${tag}`;
      const export_ = (segmentId: string) =>
        thrownBy(
          call(platformCaller(user), 'export_admin_proposal_pack', {
            segmentId,
            summary: 'Ticket triage.',
          }),
        );
      const codesOf = (err: unknown) => {
        expect(err).toBeInstanceOf(AdminProposalPackNotExportableError);
        return (err as AdminProposalPackNotExportableError).details.problems.map(
          (problem) => problem.code,
        );
      };

      const first = await proposeFor(agent, target, sourceName, ticketDesk(sourceName));
      const notApplied = await export_(first);
      expect(codesOf(notApplied)).toEqual(['segment_not_applied']);
      expect(mapCapabilityError(notApplied)).toMatchObject({
        status: 409,
        code: 'admin_proposal_pack_not_exportable',
        details: { problems: [{ code: 'segment_not_applied' }] },
      });

      const applied = await previewAndApply(target, first);
      expect(applied.verification).toMatchObject({ passed: true });

      // A later proposal revises the Skill there: verified again, what the first applied is no
      // longer in effect, and the first is no longer exportable.
      const second = await proposeFor(
        agent,
        target,
        sourceName,
        ticketDesk(sourceName, `${SKILL_MARKDOWN}\nThen say who should take it.\n`),
      );
      await previewAndApply(target, second);
      await withWorkspace(
        pool,
        { workspaceId: target.workspaceId, principalId: target.ownerPrincipalId },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          await client.query(
            `update change_segments set verified_at = verified_at - make_interval(secs => $3)
              where workspace_id = $1 and id = $2`,
            [target.workspaceId, applied.changeSegmentId, CHANGE_VERIFICATION_COOLDOWN_SECONDS + 1],
          );
        },
        { skipRoleSwitch: true },
      );
      const again = await call<ChangeVerificationResultWire>(
        ownerCaller(target),
        'verify_change_segment',
        { segmentId: applied.changeSegmentId },
      );
      expect(again.verification.passed).toBe(false);
      expect(codesOf(await export_(first))).toEqual(['not_verified']);
      // What the later one applied is verified: it exports.
      await expect(
        call(platformCaller(user), 'export_admin_proposal_pack', {
          segmentId: second,
          summary: 'Ticket triage.',
        }),
      ).resolves.toMatchObject({ name: sourceName, version: 1 });
    });

    it('anything but a workspace segment is not found; only a platform administrator’s console session reaches it', async () => {
      const { user, agent, trial } = await administrator();
      const target = await newTarget();
      const sourceName = `aa5d2-who-${tag}`;
      const segmentId = await proposeFor(agent, target, sourceName, ticketDesk(sourceName));
      await previewAndApply(target, segmentId);

      const unknown = await thrownBy(
        call(platformCaller(user), 'export_admin_proposal_pack', {
          segmentId: randomUUID(),
          summary: 'Nothing.',
        }),
      );
      expect(unknown).toBeInstanceOf(AdminProposalSegmentNotFoundError);
      expect(mapCapabilityError(unknown)).toMatchObject({
        status: 404,
        code: 'admin_proposal_segment_not_found',
      });

      // The target's owner, the administrator in their own trial workspace, and their agent: none
      // is a platform console session.
      for (const caller of [
        ownerCaller(target),
        humanCaller(trial.workspaceId, trial.ownerPrincipalId, 'owner'),
        agent,
      ]) {
        const err = await thrownBy(
          call(caller, 'export_admin_proposal_pack', { segmentId, summary: 'Mine.' }),
        );
        expect(mapCapabilityError(err), caller.channel).toMatchObject({
          status: 403,
          code: 'forbidden',
          message: expect.stringContaining('requires a platform administrator'),
        });
      }
    });
  },
);
