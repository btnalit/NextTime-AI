import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KernelToAgentHostFrame } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/keys.js';
import { openAdminAgentSession } from '../admin-agent/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { createUser } from '../identity/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { AgentHostRuntime } from './agent-host-runtime.js';
import type { AgentRuntimeEvent } from './agent-runtime.js';

/**
 * Integration test (real Postgres; auto-skips without DATABASE_URL) for an admin agent's Turn in
 * `AgentHostRuntime` (S11 AA4c-2; the AA4c plan's D8): the `startTurn` frame names the kind and
 * carries the admin agent's own prompt and a Handle issued under the session the Turn was recorded
 * under — no Skills, no egress list; the Handle is reused while that session lives; and the Turn
 * fails, sending nothing, when the authority is gone (I-A3), the session ended (`stop_admin_agent`)
 * or the prompt cannot be read. Real database because the authority and the session are read
 * inside the trial workspace's transaction.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.resolve(KERNEL_ROOT, '..', '..', 'ontology');
const ADMIN_PROMPT = 'You are the admin agent (test prompt).';

describe.runIf(DATABASE_URL !== undefined)(
  'AgentHostRuntime admin agent Turn (S11 AA4c-2; integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let previousSwitch: string | undefined;

    interface Member {
      readonly workspaceId: string;
      readonly principalId: string;
      readonly userId: string;
    }

    async function newTrialMember(): Promise<Member> {
      const user = await createUser(pool, {
        login: `aa4c2-runtime-${randomUUID().slice(0, 8)}`,
        displayName: 'AA4c-2 Runtime Admin',
        platformRole: 'admin',
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: `aa4c2-trial-${randomUUID().slice(0, 8)}`,
        owner: { userId: user.id, displayName: user.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose: 'admin_trial',
      });
      return {
        workspaceId: created.workspaceId,
        principalId: created.ownerPrincipalId,
        userId: user.id,
      };
    }

    /** The session a Turn of `member`'s admin agent is recorded under (`sendChatMessage`). */
    function sessionOf(member: Member): Promise<string> {
      return withWorkspace(pool, member, (client) =>
        openAdminAgentSession(client, member.workspaceId, member.principalId),
      );
    }

    function newRuntime(adminAgentSystemPrompt: () => Promise<string> = async () => ADMIN_PROMPT) {
      const events: AgentRuntimeEvent[] = [];
      const sent: KernelToAgentHostFrame[] = [];
      const runtime = new AgentHostRuntime({
        pool,
        sink: {
          handle(event) {
            events.push(event);
          },
        },
        privateKey,
        kernelLlmUrl: 'http://llm-proxy:8082',
        adminAgentSystemPrompt,
        log: () => {},
      });
      runtime.connect({ send: (frame) => sent.push(frame) });
      return { runtime, events, sent };
    }

    async function startAdminTurn(
      harness: ReturnType<typeof newRuntime>,
      member: Member,
      sessionId: string,
    ): Promise<string> {
      const turnId = randomUUID();
      const before = harness.sent.length;
      await harness.runtime.startTurn({
        workspaceId: member.workspaceId,
        chatId: randomUUID(),
        turnId,
        principalId: member.principalId,
        prompt: 'look at the platform',
        agentKind: 'admin_agent',
        sessionId,
      });
      // Settle the accept wait so no timer outlives the test.
      if (harness.sent.length > before)
        harness.runtime.handleFrame({ type: 'turnAccepted', turnId });
      return turnId;
    }

    function startFrames(sent: readonly KernelToAgentHostFrame[]) {
      return sent.filter(
        (frame): frame is Extract<KernelToAgentHostFrame, { type: 'startTurn' }> =>
          frame.type === 'startTurn',
      );
    }

    async function handleCount(member: Member): Promise<number> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ n: string }>(
          `select count(*)::text as n from capability_handles
            where workspace_id = $1 and on_behalf_of = $2`,
          [member.workspaceId, member.principalId],
        ),
      );
      return Number(result.rows[0]?.n ?? '0');
    }

    function expectFailedWithoutFrame(
      harness: ReturnType<typeof newRuntime>,
      turnId: string,
    ): void {
      expect(startFrames(harness.sent)).toEqual([]);
      expect(harness.events).toContainEqual(
        expect.objectContaining({ type: 'turnEnded', status: 'failed', turnId }),
      );
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool.end();
    });

    it('starts with its own prompt and a Handle under the Turn’s session — no Skills, no egress list — and reuses that Handle while the session lives', async () => {
      const member = await newTrialMember();
      const sessionId = await sessionOf(member);
      const harness = newRuntime();

      await startAdminTurn(harness, member, sessionId);
      const [first] = startFrames(harness.sent);
      expect(first).toMatchObject({
        type: 'startTurn',
        principalId: member.principalId,
        agentKind: 'admin_agent',
        systemPrompt: ADMIN_PROMPT,
      });
      expect(first).not.toHaveProperty('skillsInline');
      expect(first).not.toHaveProperty('egressDeny');
      const claims = decodeJwt(first?.handle as string);
      expect(claims.sid).toBe(sessionId);
      expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(3600);

      await startAdminTurn(harness, member, sessionId);
      const [, second] = startFrames(harness.sent);
      expect(second?.handle).toBe(first?.handle);
      expect(await handleCount(member)).toBe(1);

      // Stopping it names the kind, so agent-host finds the admin container's Turn.
      const turnId = await startAdminTurn(harness, member, sessionId);
      expect(await harness.runtime.stopTurn(turnId)).toBe(true);
      expect(harness.sent.at(-1)).toEqual({
        type: 'stopTurn',
        turnId,
        principalId: member.principalId,
        agentKind: 'admin_agent',
      });
    });

    /** The jti of the one Handle `startFrames(sent)[index]` carried. */
    function jtiOf(sent: readonly KernelToAgentHostFrame[], index: number): string {
      return decodeJwt(startFrames(sent)[index]?.handle as string).jti as string;
    }

    it('#941 review R04: a Turn under a new session gets a Handle of that session, even while the old session’s Handle is unrevoked and cached', async () => {
      const member = await newTrialMember();
      const first = await sessionOf(member);
      const harness = newRuntime();
      await startAdminTurn(harness, member, first);
      // The first session ends without its Handle being revoked (the platform's same-role
      // set_membership_role does this): the next one opens and its Turn names it.
      await withAdminClient(pool, (client) =>
        client.query(`update sessions set status = 'revoked' where id = $1`, [first]),
      );
      const second = await sessionOf(member);
      expect(second).not.toBe(first);
      await startAdminTurn(harness, member, second);
      const frames = startFrames(harness.sent);
      expect(frames).toHaveLength(2);
      expect(decodeJwt(frames[1]?.handle as string).sid).toBe(second);
      expect(jtiOf(harness.sent, 1)).not.toBe(jtiOf(harness.sent, 0));
      expect(await handleCount(member)).toBe(2);
    });

    it('#941 review R05: a cached Handle revoked since is never sent again — the same session gets a new one', async () => {
      const member = await newTrialMember();
      const sessionId = await sessionOf(member);
      const harness = newRuntime();
      await startAdminTurn(harness, member, sessionId);
      const revoked = jtiOf(harness.sent, 0);
      await withAdminClient(pool, (client) =>
        client.query('update capability_handles set revoked_at = now() where jti = $1', [revoked]),
      );
      await startAdminTurn(harness, member, sessionId);
      expect(startFrames(harness.sent)).toHaveLength(2);
      expect(jtiOf(harness.sent, 1)).not.toBe(revoked);
      expect(decodeJwt(startFrames(harness.sent)[1]?.handle as string).sid).toBe(sessionId);
      expect(await handleCount(member)).toBe(2);
    });

    it('#941 review R06: once the person’s role in the trial workspace changes, the cached Handle (narrowed for the old role) is not reused', async () => {
      const member = await newTrialMember();
      const sessionId = await sessionOf(member);
      const harness = newRuntime();
      await startAdminTurn(harness, member, sessionId);
      await withAdminClient(pool, (client) =>
        client.query(`update principals set role = 'auditor' where id = $1`, [member.principalId]),
      );
      await startAdminTurn(harness, member, sessionId);
      expect(startFrames(harness.sent)).toHaveLength(2);
      expect(jtiOf(harness.sent, 1)).not.toBe(jtiOf(harness.sent, 0));
      expect(await handleCount(member)).toBe(2);
    });

    it('#941 review (#493 P3): a Turn queued under a session that ended while its Handle stayed live (same-role set_membership_role) fails rather than reusing the cached Handle', async () => {
      const member = await newTrialMember();
      const sessionId = await sessionOf(member);
      const harness = newRuntime();
      await startAdminTurn(harness, member, sessionId);
      expect(startFrames(harness.sent)).toHaveLength(1);
      harness.sent.length = 0;
      // What the platform's set_membership_role does to the same role: the session ends, its
      // Handles are left alone (they are revoked only on a role change).
      await withAdminClient(pool, (client) =>
        client.query(
          `update sessions set status = 'revoked', expires_at = least(expires_at, now()) where id = $1`,
          [sessionId],
        ),
      );
      expectFailedWithoutFrame(harness, await startAdminTurn(harness, member, sessionId));
      expect(await handleCount(member)).toBe(1);
    });

    it('fails, sending nothing, once the session the Turn was recorded under has ended — no new session under the old Turn', async () => {
      const member = await newTrialMember();
      const sessionId = await sessionOf(member);
      await withAdminClient(pool, (client) =>
        client.query(`update sessions set status = 'revoked' where id = $1`, [sessionId]),
      );
      const harness = newRuntime();
      const turnId = await startAdminTurn(harness, member, sessionId);
      expectFailedWithoutFrame(harness, turnId);
      expect(await handleCount(member)).toBe(0);
      const live = await withAdminClient(pool, (client) =>
        client.query(
          `select 1 from sessions
            where workspace_id = $1 and principal_id = $2 and kind = 'admin_agent'
              and status = 'active'`,
          [member.workspaceId, member.principalId],
        ),
      );
      expect(live.rows).toEqual([]);
    });

    it('fails, sending nothing, when its person may no longer run it (switch off, demoted), even with a Handle cached', async () => {
      const member = await newTrialMember();
      const sessionId = await sessionOf(member);
      const harness = newRuntime();
      await startAdminTurn(harness, member, sessionId);
      expect(startFrames(harness.sent)).toHaveLength(1);
      harness.sent.length = 0;

      process.env.ADMIN_AGENT_ENABLED = '0';
      try {
        expectFailedWithoutFrame(harness, await startAdminTurn(harness, member, sessionId));
      } finally {
        process.env.ADMIN_AGENT_ENABLED = '1';
      }

      await withAdminClient(pool, (client) =>
        client.query(`update users set platform_role = 'user' where id = $1`, [member.userId]),
      );
      expectFailedWithoutFrame(harness, await startAdminTurn(harness, member, sessionId));
    });

    it('fails, issuing nothing, when the admin agent’s prompt cannot be read — never another agent’s prompt', async () => {
      const member = await newTrialMember();
      const sessionId = await sessionOf(member);
      const harness = newRuntime(async () => {
        throw new Error('admin-agent.yaml: missing');
      });
      expectFailedWithoutFrame(harness, await startAdminTurn(harness, member, sessionId));
      expect(await handleCount(member)).toBe(0);
    });
  },
);
