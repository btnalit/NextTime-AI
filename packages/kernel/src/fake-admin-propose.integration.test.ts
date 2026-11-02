import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdminProposalWire } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './adapters/db/migrate.js';
import { createPool, withWorkspace } from './adapters/db/pool.js';
import { openAdminAgentSession } from './application/admin-agent/index.js';
import { loadConnectorPresets } from './application/gates/index.js';
import { withAdminClient } from './application/gateway/auth.js';
import { dispatchCapability } from './application/gateway/index.js';
import type { ResolvedCaller } from './application/gateway/resolve-caller.js';
import type { StartTurnInput } from './application/host-bridge/index.js';
import { FAKE_ADMIN_PROPOSE_MARKER } from './application/host-bridge/index.js';
import { type UserRow, createUser } from './application/identity/index.js';
import { createWorkspaceWithOwner } from './application/workspace/index.js';
import {
  FAKE_ADMIN_PROPOSAL_SOURCE_NAME,
  createFakeAdminProposeHandler,
} from './fake-admin-propose.js';
import { generateEphemeralHandleKeyPair } from './governance/capability/index.js';

/**
 * fake-admin-propose.integration (real Postgres; auto-skips without DATABASE_URL): the CI-only
 * glue of S11 AA4d (AA4 plan F9) proposes through the real dispatch with the Turn's own admin
 * agent Handle — the proposal lands in the trial workspace, one workspace segment per chosen
 * target and the platform segment, and its audit row says the admin agent made it under the
 * Turn's session. It holds nothing the kernel would not refuse the real agent: no targets, an
 * ended session or the switch off each end in a refusal and no proposal.
 * `FakeAgentRuntime`'s marker routing is unit-tested in application/host-bridge/fake-runtime.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.resolve(KERNEL_ROOT, '..', '..', 'ontology');

describe.runIf(DATABASE_URL !== undefined)(
  'fake-admin-propose — integration (S11 AA4d; real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let previousSwitch: string | undefined;

    const unique = () => randomUUID().slice(0, 8);

    interface Trial {
      readonly user: UserRow;
      readonly workspaceId: string;
      readonly principalId: string;
    }

    async function newTrial(): Promise<Trial> {
      const suffix = unique();
      const user = await createUser(pool, {
        login: `aa4d-admin-${suffix}`,
        displayName: `AA4d Admin ${suffix}`,
        platformRole: 'admin',
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: `aa4d-trial-${suffix}`,
        owner: { userId: user.id, displayName: user.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose: 'admin_trial',
      });
      return { user, workspaceId: created.workspaceId, principalId: created.ownerPrincipalId };
    }

    async function newTarget(): Promise<string> {
      const owner = await createUser(pool, {
        login: `aa4d-owner-${unique()}`,
        displayName: 'AA4d Target Owner',
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: `aa4d-target-${unique()}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose: 'standard',
      });
      return created.workspaceId;
    }

    function platform(user: UserRow): ResolvedCaller {
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

    /** What the administrator does on 平台 · 管理员智能体 before the journey sends its marker. */
    async function chooseTargets(trial: Trial, targets: readonly string[]): Promise<void> {
      await dispatchCapability({ pool }, platform(trial.user), 'set_admin_agent_targets', {
        trialWorkspaceId: trial.workspaceId,
        targetWorkspaceIds: targets,
      });
    }

    /** The session a Turn of the trial's admin agent is recorded under (`sendChatMessage`). */
    function sessionOf(trial: Trial): Promise<string> {
      return withWorkspace(pool, trial, (client) =>
        openAdminAgentSession(client, trial.workspaceId, trial.principalId),
      );
    }

    function turnOf(trial: Trial, sessionId: string): StartTurnInput {
      return {
        workspaceId: trial.workspaceId,
        chatId: randomUUID(),
        turnId: randomUUID(),
        principalId: trial.principalId,
        prompt: `${FAKE_ADMIN_PROPOSE_MARKER} 提一份管理员提案`,
        agentKind: 'admin_agent',
        sessionId,
      };
    }

    const handler = () =>
      createFakeAdminProposeHandler({
        pool,
        privateKey,
        loadHandlePublicKey: async () => publicKey,
      });

    async function proposalsOf(trial: Trial): Promise<number> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ n: string }>(
          'select count(*)::text as n from admin_proposals where workspace_id = $1',
          [trial.workspaceId],
        ),
      );
      return Number(result.rows[0]?.n ?? '0');
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      ({ privateKey, publicKey } = await generateEphemeralHandleKeyPair());
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool.end();
    });

    it('proposes through the real dispatch with the Turn’s admin agent Handle: a workspace segment per chosen target, the platform segment, an audit row under the Turn’s session', async () => {
      const trial = await newTrial();
      const [targetA, targetB] = [await newTarget(), await newTarget()];
      await chooseTargets(trial, [targetA, targetB]);
      const sessionId = await sessionOf(trial);
      const input = turnOf(trial, sessionId);

      const outcome = await handler()(input);

      expect(outcome).toMatchObject({
        status: 'proposed',
        title: expect.stringMatching(/^CI admin proposal /),
      });
      const proposal = (await dispatchCapability(
        { pool },
        platform(trial.user),
        'get_admin_proposal',
        { proposalId: outcome.proposalId },
      )) as AdminProposalWire;
      expect(proposal).toMatchObject({
        id: outcome.proposalId,
        sourceName: FAKE_ADMIN_PROPOSAL_SOURCE_NAME,
        origin: 'agent',
      });
      const workspaceSegments = proposal.segments.filter((s) => s.authority === 'workspace');
      expect(workspaceSegments.map((s) => s.targetWorkspaceId).sort()).toEqual(
        [targetA, targetB].sort(),
      );
      // The first preset the repository ships: the kernel names none itself (§7.10).
      const [preset] = await loadConnectorPresets();
      const platformSegment = proposal.segments.find((s) => s.authority === 'platform');
      expect(platformSegment?.items).toEqual([
        expect.objectContaining({ kind: 'gate_instance', preset: preset?.name }),
      ]);

      const audit = await withAdminClient(pool, (client) =>
        client.query<{ payload: Record<string, unknown>; actor_principal_id: string }>(
          `select payload, actor_principal_id from audit_records
            where workspace_id = $1 and action = 'propose_admin_proposal'
            order by created_at desc, id desc limit 1`,
          [trial.workspaceId],
        ),
      );
      expect(audit.rows[0]).toMatchObject({
        actor_principal_id: trial.principalId,
        payload: expect.objectContaining({ sessionKind: 'admin_agent', sessionId }),
      });

      // Two Turns propose two proposals: the names follow the Turn, so a second journey run
      // collides with nothing the first one left.
      const second = await handler()(turnOf(trial, sessionId));
      expect(second.proposalId).not.toBe(outcome.proposalId);
      expect(second.title).not.toBe(outcome.title);
    });

    it('refuses as the kernel refuses the real agent, proposing nothing: no targets chosen, an ended session, the switch off, an entry Turn', async () => {
      const trial = await newTrial();
      const sessionId = await sessionOf(trial);

      await expect(handler()(turnOf(trial, sessionId))).rejects.toThrow(/no proposal targets/);

      await chooseTargets(trial, [await newTarget()]);
      await expect(
        handler()({ ...turnOf(trial, sessionId), agentKind: undefined }),
      ).rejects.toThrow(/not an admin agent Turn/);

      process.env.ADMIN_AGENT_ENABLED = '0';
      try {
        await expect(handler()(turnOf(trial, sessionId))).rejects.toThrow();
      } finally {
        process.env.ADMIN_AGENT_ENABLED = '1';
      }

      await withAdminClient(pool, (client) =>
        client.query("update sessions set status = 'revoked' where id = $1", [sessionId]),
      );
      await expect(handler()(turnOf(trial, sessionId))).rejects.toThrow(/has ended/);

      expect(await proposalsOf(trial)).toBe(0);
    });
  },
);
