import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentAdminProposalWire,
  ChangeRollbackPreviewWire,
  ChangeSegmentDetailWire,
  ChangeSegmentWire,
  ListEnvelope,
  PackInstallPreviewWire,
  PackInstallResultWire,
  PackWire,
  ReceivedAdminProposalSegmentWire,
  Role,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { issueAdminAgentHandle } from '../admin-agent/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { ForbiddenError } from '../gateway/authorize.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { latestPackVersion, loadPackRegistry } from '../packs/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  AdminProposalInvalidError,
  AdminProposalPackMismatchError,
  AdminProposalSegmentIsPackInstallError,
  AdminProposalSegmentNotFoundError,
  AdminProposalSegmentNotOpenError,
  AdminProposalSegmentUnchangedError,
  AdminProposalTargetNoLongerChosenError,
  AdminProposalTargetNotChosenError,
} from './index.js';

/**
 * S11 AA5g-2 (docs/admin-agent-packs-design-2026-11-06.md D2–D4, I-G1–I-G5; governance 0040): an
 * admin agent asks workspace owners to install a capability pack (`propose_pack_install`); each
 * owner installs it the way every pack is installed (`install_pack`), naming the segment. The
 * install is the pack's (`source_kind = 'pack'`, published by the owner, not drafted by an agent)
 * and records the proposal as what asked for it; the segment is applied in the same transaction
 * and rolled back with the install.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

/** A shipped pack with no pack it builds on: installing it waits for nothing. */
const PACK = 'ops-base';

type Target = { readonly workspaceId: string; readonly ownerPrincipalId: string };

function ownerCaller(target: Target, role: Role = 'owner'): ResolvedCaller {
  return {
    channel: 'human',
    principal: {
      workspaceId: target.workspaceId,
      id: target.ownerPrincipalId,
      kind: 'human',
      role,
      displayName: role,
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

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (err: unknown) => err,
  );
}

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA5g-2 pack install proposals (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let previousSwitch: string | undefined;
    let latest: number;
    let latestDigest: string;

    async function newWorkspace(
      owner: UserRow,
      purpose: 'standard' | 'admin_trial',
    ): Promise<Target> {
      return createWorkspaceWithOwner(pool, {
        name: `aa5g2-${purpose}-${randomUUID().slice(0, 8)}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose,
      });
    }

    async function newTarget(): Promise<Target> {
      const owner = await createUser(pool, {
        login: `aa5g2-owner-${randomUUID().slice(0, 8)}`,
        displayName: 'Target Owner',
      });
      return newWorkspace(owner, 'standard');
    }

    /** A platform administrator, their trial workspace, and their admin agent's Handle there. */
    async function administrator(): Promise<{
      readonly trial: Target;
      readonly agent: ResolvedCaller;
    }> {
      const suffix = randomUUID().slice(0, 8);
      const user = await createUser(pool, {
        login: `aa5g2-admin-${suffix}`,
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
      return { trial, agent: { channel: 'handle', claims } };
    }

    /** What the administrator does on the platform's admin agent page: chooses the targets. */
    async function choose(trial: Target, targets: readonly Target[]): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into admin_agent_targets
             (workspace_id, principal_id, target_workspace_id, chosen_by_user)
           select p.workspace_id, p.id, w, p.user_id
             from principals p, unnest($3::uuid[]) w
            where p.workspace_id = $1 and p.id = $2
           on conflict do nothing`,
          [trial.workspaceId, trial.ownerPrincipalId, targets.map((t) => t.workspaceId)],
        ),
      );
    }

    async function unchoose(trial: Target, target: Target): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query(
          `delete from admin_agent_targets
            where workspace_id = $1 and principal_id = $2 and target_workspace_id = $3`,
          [trial.workspaceId, trial.ownerPrincipalId, target.workspaceId],
        ),
      );
    }

    const call = <T>(caller: ResolvedCaller, name: string, params: unknown) =>
      dispatchCapability({ pool }, caller, name, params) as Promise<T>;

    const proposeInstall = (agent: ResolvedCaller, targets: readonly Target[], extra = {}) =>
      call<AgentAdminProposalWire>(agent, 'propose_pack_install', {
        pack: PACK,
        version: latest,
        targetWorkspaceIds: targets.map((t) => t.workspaceId),
        title: 'Ops base for the ops teams',
        description: 'The trial workspace ran its Worker against a container host.',
        ...extra,
      });

    /** Previews the pack's install as the owner, then installs what it showed, confirming every
     *  widening item — naming `segmentId` when given. */
    async function install(target: Target, segmentId?: string, caller = ownerCaller(target)) {
      const dryRun = await call<PackInstallPreviewWire>(caller, 'preview_pack_install', {
        name: PACK,
      });
      return call<PackInstallResultWire>(caller, 'install_pack', {
        name: PACK,
        version: dryRun.targetVersion,
        reviewedDigest: dryRun.digest,
        confirmedOrdinals: dryRun.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
        ...(segmentId !== undefined ? { adminProposalSegmentId: segmentId } : {}),
      });
    }

    async function segmentRow(segmentId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          status: string;
          decided_by: string | null;
          applied_segment_id: string | null;
        }>(
          'select status, decided_by, applied_segment_id from admin_proposal_segments where id = $1',
          [segmentId],
        ),
      );
      return result.rows[0];
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      const entry = (await loadPackRegistry()).get(PACK);
      if (entry === undefined) throw new Error(`no pack ${PACK} in this deployment`);
      latest = latestPackVersion(entry).version;
      latestDigest = latestPackVersion(entry).digest;
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    it('proposed → installed by the owner (the pack’s record, naming the proposal) → applied; another owner rejects; rolling the install back rolls the segment back', async () => {
      const { trial, agent } = await administrator();
      const a = await newTarget();
      const b = await newTarget();
      await choose(trial, [a, b]);

      const packs = await call<ListEnvelope<PackWire>>(agent, 'agent_list_packs', {});
      expect(packs.items.find((pack) => pack.name === PACK)).toBeDefined();
      const before = await call<ListEnvelope<PackWire>>(ownerCaller(a), 'list_packs', {});
      expect(before.items.find((pack) => pack.name === PACK)?.status).toBe('not_installed');

      const proposal = await proposeInstall(agent, [a, b]);
      // Its source name is pack install proposals' own, never the pack's (#484 on #1002): a source
      // name is what new Skills and Workers are derived under, and this derives none.
      expect(proposal).toMatchObject({
        sourceName: 'pack-install',
        origin: 'agent',
        status: 'proposed',
      });
      // Its reads say which pack it asks for (the source name says nothing of it).
      expect(proposal.packInstall).toEqual({ pack: PACK, version: latest });
      // Each segment's content digest is the pack version's: the install's source digest answers it.
      expect(proposal.segments.map((segment) => segment.contentDigest)).toEqual([
        latestDigest,
        latestDigest,
      ]);
      expect(proposal.segments.map((segment) => segment.items)).toEqual([
        [{ kind: 'pack_install', pack: PACK, version: latest }],
        [{ kind: 'pack_install', pack: PACK, version: latest }],
      ]);
      const [segA, segB] = proposal.segments.map((segment) => segment.id);
      if (!segA || !segB) throw new Error('two segments');

      // The owner reads it with the others it received; it is not previewed as a segment of intents.
      const received = await call<ListEnvelope<ReceivedAdminProposalSegmentWire>>(
        ownerCaller(a),
        'list_admin_proposal_segments',
        {},
      );
      expect(received.items.map((segment) => segment.id)).toContain(segA);
      for (const name of ['preview_admin_proposal_segment', 'apply_admin_proposal_segment']) {
        const params =
          name === 'preview_admin_proposal_segment'
            ? { segmentId: segA }
            : { segmentId: segA, reviewedDigest: 'sha256:x' };
        const refused = await thrownBy(call(ownerCaller(a), name, params));
        expect(refused, name).toBeInstanceOf(AdminProposalSegmentIsPackInstallError);
        expect(mapCapabilityError(refused)).toMatchObject({
          status: 409,
          code: 'admin_proposal_segment_is_pack_install',
          details: { pack: PACK, version: latest },
        });
      }

      // Installed by the owner, answering the segment.
      const installed = await install(a, segA);
      expect(installed.pack.status).toBe('up_to_date');
      const changeSegmentId = installed.segmentId;
      if (changeSegmentId === null) throw new Error('installed nothing');
      expect(await segmentRow(segA)).toMatchObject({
        status: 'applied',
        decided_by: a.ownerPrincipalId,
        applied_segment_id: changeSegmentId,
      });
      const record = await call<ChangeSegmentDetailWire>(ownerCaller(a), 'get_change_segment', {
        segmentId: changeSegmentId,
      });
      expect(record.segment).toMatchObject({
        source: { kind: 'pack', name: PACK, version: String(latest) },
        proposedBy: { id: a.ownerPrincipalId },
        adminProposal: { proposalId: proposal.id, proposalSegmentId: segA },
      });
      // The pack's content, reviewed and published by the owner — never drafted by an agent (I-A7).
      // The target is new, so everything with an origin in it is what this install published: some
      // of it, and none of it the agent's (#493 on #1002, C5).
      const origins = await withAdminClient(pool, (client) =>
        client.query<{ origin: string | null; rows: number }>(
          `select origin, count(*)::int as rows from (
             select origin from ontology_versions where workspace_id = $1
             union all select origin from skills where workspace_id = $1
             union all select origin from worker_definitions where workspace_id = $1
             union all select origin from procedures where workspace_id = $1
           ) published group by origin`,
          [a.workspaceId],
        ),
      );
      expect(origins.rows.reduce((total, row) => total + row.rows, 0)).toBeGreaterThan(0);
      expect(origins.rows.map((row) => row.origin)).not.toContain('agent');

      // The other owner rejects theirs.
      await call(ownerCaller(b), 'reject_admin_proposal_segment', {
        segmentId: segB,
        reason: 'We run no containers here.',
      });

      // The agent reads back what became of each.
      const read = await call<AgentAdminProposalWire>(agent, 'agent_get_admin_proposal', {
        proposalId: proposal.id,
      });
      expect(read.segments.map((segment) => segment.status)).toEqual(['applied', 'rejected']);
      expect(read.status).toBe('partially_applied');

      // Rolling the install back rolls the segment back with it (I-G5).
      const dryRun = await call<ChangeRollbackPreviewWire>(
        ownerCaller(a),
        'preview_roll_back_change_segment',
        { segmentId: changeSegmentId },
      );
      expect(dryRun.possible).toBe(true);
      const rolledBack = await call<ChangeSegmentWire>(ownerCaller(a), 'roll_back_change_segment', {
        segmentId: changeSegmentId,
        confirmedOrdinals: dryRun.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      });
      expect(rolledBack.status).toBe('rolled_back');
      expect((await segmentRow(segA))?.status).toBe('rolled_back');
    });

    it('refused proposals: a target not chosen, a pack this deployment does not have, a version that is not the latest, a target named twice — nothing written', async () => {
      const { trial, agent } = await administrator();
      const chosen = await newTarget();
      const other = await newTarget();
      await choose(trial, [chosen]);
      const count = async () =>
        (
          await withAdminClient(pool, (client) =>
            client.query<{ n: number }>(
              'select count(*)::int as n from admin_proposals where workspace_id = $1',
              [trial.workspaceId],
            ),
          )
        ).rows[0]?.n;

      expect(await thrownBy(proposeInstall(agent, [chosen, other]))).toBeInstanceOf(
        AdminProposalTargetNotChosenError,
      );
      for (const extra of [
        { pack: 'no-such-pack' },
        { version: latest + 1 },
        ...(latest > 1 ? [{ version: latest - 1 }] : []),
        { targetWorkspaceIds: [chosen.workspaceId, chosen.workspaceId] },
      ]) {
        const refused = await thrownBy(proposeInstall(agent, [chosen], extra));
        expect(refused, JSON.stringify(extra)).toBeInstanceOf(AdminProposalInvalidError);
      }
      expect(await count()).toBe(0);
      // A person has no such capability: it is the agent's.
      await expect(
        call(ownerCaller(trial), 'propose_pack_install', {
          pack: PACK,
          version: latest,
          targetWorkspaceIds: [chosen.workspaceId],
          title: 'x',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refused installs answering a segment: not the owner, another pack or version, a segment addressed elsewhere, a target no longer chosen, already installed, already decided — nothing installed', async () => {
      const { trial, agent } = await administrator();
      const a = await newTarget();
      const b = await newTarget();
      await choose(trial, [a, b]);
      const proposal = await proposeInstall(agent, [a, b]);
      const [segA, segB] = proposal.segments.map((segment) => segment.id);
      if (!segA || !segB) throw new Error('two segments');

      // A member, not the owner: install_pack is the owner's.
      await expect(install(a, segA, ownerCaller(a, 'member'))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // A segment addressed to another workspace reads as none here.
      expect(await thrownBy(install(a, segB))).toBeInstanceOf(AdminProposalSegmentNotFoundError);
      // Another pack or version than the segment asks for.
      const dryRun = await call<PackInstallPreviewWire>(ownerCaller(a), 'preview_pack_install', {
        name: PACK,
      });
      const mismatch = await thrownBy(
        call(ownerCaller(a), 'install_pack', {
          name: 'ops-assets',
          version: 2,
          reviewedDigest: dryRun.digest,
          adminProposalSegmentId: segA,
        }),
      );
      expect(mismatch).toBeInstanceOf(AdminProposalPackMismatchError);
      expect(mapCapabilityError(mismatch)).toMatchObject({
        status: 409,
        code: 'admin_proposal_pack_mismatch',
        details: { pack: PACK, version: latest },
      });
      // A segment of intents is not a pack install.
      expect((await segmentRow(segA))?.status).toBe('proposed');

      // The administrator took the workspace off their agent's targets since.
      await unchoose(trial, a);
      expect(await thrownBy(install(a, segA))).toBeInstanceOf(
        AdminProposalTargetNoLongerChosenError,
      );
      const listed = await call<ListEnvelope<PackWire>>(ownerCaller(a), 'list_packs', {});
      expect(listed.items.find((pack) => pack.name === PACK)?.status).toBe('not_installed');
      await choose(trial, [a]);

      // Installed already (without the segment): nothing to answer it with — reject it instead.
      await install(a);
      expect(await thrownBy(install(a, segA))).toBeInstanceOf(AdminProposalSegmentUnchangedError);
      expect((await segmentRow(segA))?.status).toBe('proposed');

      // Decided already.
      await call(ownerCaller(b), 'reject_admin_proposal_segment', {
        segmentId: segB,
        reason: 'Not here.',
      });
      expect(await thrownBy(install(b, segB))).toBeInstanceOf(AdminProposalSegmentNotOpenError);
    });

    it('governance 0040: a pack record names only a segment asking for exactly it; a pack_install is alone in its segment', async () => {
      const { trial, agent } = await administrator();
      const a = await newTarget();
      await choose(trial, [a]);
      const proposal = await proposeInstall(agent, [a]);
      const segmentId = proposal.segments[0]?.id;
      if (!segmentId) throw new Error('one segment');
      const head = await withAdminClient(pool, (client) =>
        client.query<{ proposed_by_user: string; proposer_display_name: string }>(
          'select proposed_by_user, proposer_display_name from admin_proposals where id = $1',
          [proposal.id],
        ),
      );
      const row = head.rows[0];
      if (!row) throw new Error('no proposal');
      const other = await proposeInstall(agent, [a]);
      const insert = (
        version: string,
        name = PACK,
        partial = false,
        digest = latestDigest,
        provenance: {
          proposalId?: string;
          segmentId?: string | null;
          proposedByUser?: string;
        } = {},
      ) =>
        withWorkspace(
          pool,
          { workspaceId: a.workspaceId, principalId: a.ownerPrincipalId },
          (client) =>
            client.query(
              `insert into change_segments
                 (workspace_id, plan_id, channel, source_kind, source_name, source_version,
                  source_digest, reviewed_digest, proposed_by, applied_by, admin_proposal_id,
                  admin_proposal_segment_id, proposed_by_user, proposer_display_name)
               values ($1, gen_random_uuid(), 'human', 'pack', $2, $3, $9, 'sha256:x',
                       $4, $4, $5, $6, $7, $8)`,
              [
                a.workspaceId,
                name,
                version,
                a.ownerPrincipalId,
                provenance.proposalId ?? proposal.id,
                provenance.segmentId === undefined ? segmentId : provenance.segmentId,
                provenance.proposedByUser ?? row.proposed_by_user,
                partial ? null : row.proposer_display_name,
                digest,
              ],
            ),
        );
      await expect(insert(String(latest + 1))).rejects.toThrow(
        /a pack install answers a proposal segment asking for this pack/,
      );
      await expect(insert(String(latest), 'ops-assets')).rejects.toThrow(
        /a pack install answers a proposal segment asking for this pack/,
      );
      // The same name and version with other content (an extra pack replaced in place).
      await expect(insert(String(latest), PACK, false, `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
        /a pack install answers a proposal segment asking for this pack .* with this content/,
      );
      // A part of the provenance: no segment while the other three are there names no proposal
      // segment it could be checked against (0040's `change_segments_proposer`, the guard passing a
      // record with no segment) …
      await expect(
        insert(String(latest), PACK, false, latestDigest, { segmentId: null }),
      ).rejects.toThrow(/change_segments_proposer/);
      // … and a segment with its proposer's name left out is not its proposer (the guard first).
      await expect(insert(String(latest), PACK, true)).rejects.toThrow(
        /a pack install's proposal and proposer are its proposal segment's/,
      );
      // Another proposal's id, or another proposer, beside this segment (#493 on #1002, G3 / G4).
      await expect(
        insert(String(latest), PACK, false, latestDigest, { proposalId: other.id }),
      ).rejects.toThrow(/a pack install's proposal and proposer are its proposal segment's/);
      await expect(
        insert(String(latest), PACK, false, latestDigest, { proposedByUser: randomUUID() }),
      ).rejects.toThrow(/a pack install's proposal and proposer are its proposal segment's/);

      // A pack_install beside another item, written past the kernel: what a segment proposes never
      // changes (0032's guard), and the kinds it may hold are 0040's `item_kinds` check, probed on
      // its own in platform-segments.integration.test.ts.
      await expect(
        withAdminClient(pool, (client) =>
          client.query(
            `update admin_proposal_segments
                set items = items || '[{"kind":"skill_version","skill":{"name":"x","description":"x","markdown":"x"}}]'::jsonb
              where id = $1`,
            [segmentId],
          ),
        ),
      ).rejects.toThrow(/admin_proposal_segments/);
    });
  },
);
