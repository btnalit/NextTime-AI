import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdminAgentStatusWire,
  AdminAgentStopResultWire,
  AdminAgentTargetsResultWire,
  AgentProposalTargetsWire,
  ChatWire,
  LlmRefusalScope,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG, HandleRevoked } from '../../governance/capability/index.js';
import { entryTurnRefusedOnly } from '../../governance/llm-usage/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { WS_ERROR_CODES, mapDispatchError } from '../../interfaces/ws/rpc.js';
import { withAdminClient } from '../gateway/auth.js';
import { ForbiddenError } from '../gateway/authorize.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import { setAgentRuntimeForHandlers } from '../gateway/handlers.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { findAttributableTurnForSession } from '../host-bridge/index.js';
import { type UserRow, createUser } from '../identity/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  AdminAgentRefused,
  AdminAgentRoleNotStoredError,
  AdminAgentTargetsInvalidError,
  AdminAgentTrialWorkspaceNotFoundError,
  issueAdminAgentHandle,
} from './index.js';

/**
 * application/admin-agent chat, targets and stop (S11 AA4c-1; real Postgres, auto-skip without
 * DATABASE_URL): a platform administrator's admin agent as the console reaches it — through a Chat
 * of its own in a trial workspace (core 0053), whose Turns run under the person's one
 * `admin_agent` session there; the workspaces it may propose to, chosen by that person on the
 * platform plane (governance 0036, F5); and stopping it (D6).
 *
 *  - An admin agent's Chat is private, starts only in a trial workspace and never changes kind —
 *    the database's; that its person may start a Turn now is the kernel's, on every message. Its
 *    history stays readable with the switch off, never by a person who is no longer an
 *    administrator.
 *  - Every admin agent Chat of a person in a trial workspace shares one session; its Turns record
 *    it when they start, and what the session does is attributed to them only, never to an entry
 *    Turn running beside them (and the other way round). Legacy 589 counts its refused calls.
 *  - Only a person chooses the targets, for their own admin agent: the agent reads ids, and each of
 *    the two `security definer` reads answers for its own caller only (R-1).
 *  - Stopping revokes the sessions and their Handles in one platform transaction (one audit row),
 *    then stops the running Turns; the next message opens a new session.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

interface Membership {
  readonly workspaceId: string;
  readonly principalId: string;
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
  'S11 AA4c-1 admin agent Chats, targets and stop (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let tag: string;
    let previousSwitch: string | undefined;
    /** A platform administrator, owner of the trial workspaces each test makes. */
    let admin: UserRow;
    /** Owner of the standard workspaces targets are chosen among. */
    let targetOwner: UserRow;
    let targetA: string;
    let targetB: string;
    let disabledTarget: string;

    async function newWorkspace(
      owner: UserRow,
      purpose: 'standard' | 'admin_trial',
    ): Promise<Membership> {
      const created = await createWorkspaceWithOwner(pool, {
        name: `aa4c-${purpose}-${randomUUID().slice(0, 8)}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose,
      });
      return { workspaceId: created.workspaceId, principalId: created.ownerPrincipalId };
    }

    /** A trial workspace of `admin`'s, fresh for the test. */
    const newTrial = () => newWorkspace(admin, 'admin_trial');

    async function newAdmin(): Promise<UserRow> {
      return createUser(pool, {
        login: `aa4c-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'AA4c Admin',
        platformRole: 'admin',
      });
    }

    /** `user` as a person in `workspaceId`, with `role`. */
    async function addMember(
      workspaceId: string,
      user: UserRow,
      role: 'owner' | 'member' = 'member',
    ): Promise<Membership> {
      const principalId = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, 'human', $3, $4, $5)`,
          [workspaceId, principalId, role, user.displayName, user.id],
        ),
      );
      return { workspaceId, principalId };
    }

    function person(member: Membership): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId: member.workspaceId,
          id: member.principalId,
          kind: 'human',
          role: 'owner',
          displayName: null,
        },
        session: {
          workspaceId: member.workspaceId,
          id: randomUUID(),
          principalId: member.principalId,
          kind: 'web',
          onBehalfOf: member.principalId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
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

    async function agentHandle(member: Membership) {
      const issued = await withWorkspace(pool, member, (client) =>
        issueAdminAgentHandle(client, { ...member, ttlSeconds: 600, privateKey }),
      );
      const claims = await authenticateHandle(pool, issued.token, { publicKey }, 'source');
      return { issued, caller: { channel: 'handle', claims } as ResolvedCaller };
    }

    const call = <T>(caller: ResolvedCaller, name: string, params: unknown) =>
      dispatchCapability({ pool }, caller, name, params) as Promise<T>;

    const newAdminChat = (member: Membership) =>
      call<ChatWire>(person(member), 'new_chat', { agentKind: 'admin_agent' });

    const send = (member: Membership, chatId: string, text = 'look at the platform') =>
      call<{ turnId: string }>(person(member), 'send_chat_message', { chatId, text });

    async function turnRow(member: Membership, turnId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ status: string; metadata: Record<string, unknown> }>(
          'select status, metadata from activities where workspace_id = $1 and id = $2',
          [member.workspaceId, turnId],
        ),
      );
      return result.rows[0];
    }

    async function turnStartedPayload(member: Membership, turnId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ payload: Record<string, unknown> }>(
          `select payload from outbox
            where workspace_id = $1 and event_type = 'TurnStarted' and payload ->> 'turnId' = $2`,
          [member.workspaceId, turnId],
        ),
      );
      return result.rows[0]?.payload;
    }

    async function sessionRow(sessionId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ kind: string; principal_id: string; on_behalf_of: string; status: string }>(
          'select kind, principal_id, on_behalf_of, status from sessions where id = $1',
          [sessionId],
        ),
      );
      return result.rows[0];
    }

    async function lastPlatformAudit(action: string, userId: string) {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          payload: Record<string, unknown>;
          resource_type: string | null;
          resource_id: string | null;
          workspace_id: string | null;
        }>(
          `select payload, resource_type, resource_id, workspace_id from audit_records
            where action = $1 and actor_user_id = $2
            order by created_at desc, id desc limit 1`,
          [action, userId],
        ),
      );
      return result.rows[0];
    }

    async function setStoredRole(user: UserRow, role: 'admin' | 'user'): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query('update users set platform_role = $2 where id = $1', [user.id, role]),
      );
    }

    async function withSwitchOff<T>(run: () => Promise<T>): Promise<T> {
      process.env.ADMIN_AGENT_ENABLED = '0';
      try {
        return await run();
      } finally {
        process.env.ADMIN_AGENT_ENABLED = '1';
      }
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
      admin = await createUser(pool, {
        login: `aa4c-admin-${tag}`,
        displayName: 'AA4c Admin',
        platformRole: 'admin',
      });
      targetOwner = await createUser(pool, {
        login: `aa4c-owner-${tag}`,
        displayName: 'AA4c Target Owner',
      });
      targetA = (await newWorkspace(targetOwner, 'standard')).workspaceId;
      targetB = (await newWorkspace(targetOwner, 'standard')).workspaceId;
      disabledTarget = (await newWorkspace(targetOwner, 'standard')).workspaceId;
      await withAdminClient(pool, (client) =>
        client.query(`update workspaces set status = 'disabled' where id = $1`, [disabledTarget]),
      );
      // The runtime does not know the Turns these tests start: stopping one ends it at once.
      setAgentRuntimeForHandlers({ startTurn: async () => {}, stopTurn: async () => false });
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    // -----------------------------------------------------------------------------------------
    // The admin agent's Chat (core 0053, the AA4c plan's D4)
    // -----------------------------------------------------------------------------------------

    it('core 0053: an admin agent Chat is private, in a trial workspace only, and never changes kind — whoever writes it', async () => {
      const trial = await newTrial();
      const standard = await newWorkspace(admin, 'standard');
      const insert = (member: Membership, kind: string, visibility = 'private') =>
        withAdminClient(pool, (client) =>
          client.query<{ id: string }>(
            `insert into chats (workspace_id, owner_principal_id, agent_kind, visibility)
             values ($1, $2, $3, $4) returning id`,
            [member.workspaceId, member.principalId, kind, visibility],
          ),
        );
      await expect(insert(standard, 'admin_agent')).rejects.toThrow(
        /an admin agent's Chat is started only in a trial workspace/,
      );
      await expect(insert(trial, 'admin_agent', 'workspace')).rejects.toThrow(
        /chats_admin_agent_private/,
      );
      await expect(insert(trial, 'someone_else')).rejects.toThrow(/chats_agent_kind_check/);
      const entry = (await insert(trial, 'entry')).rows[0]?.id as string;
      const adminChat = (await insert(trial, 'admin_agent')).rows[0]?.id as string;
      const setKind = (id: string, kind: string) =>
        withAdminClient(pool, (client) =>
          client.query('update chats set agent_kind = $2 where id = $1', [id, kind]),
        );
      await expect(setKind(entry, 'admin_agent')).rejects.toThrow(/agent kind never changes/);
      await expect(setKind(adminChat, 'entry')).rejects.toThrow(/agent kind never changes/);
      await expect(
        withAdminClient(pool, (client) =>
          client.query(`update chats set visibility = 'workspace' where id = $1`, [adminChat]),
        ),
      ).rejects.toThrow(/chats_admin_agent_private/);
      // Everything else of the Chat changes as it always did.
      await withAdminClient(pool, (client) =>
        client.query(`update chats set title = 'renamed' where id = $1`, [adminChat]),
      );
    });

    it('new_chat starts an admin agent Chat for a platform administrator in a trial workspace, and refuses with why everywhere else — nothing written', async () => {
      const trial = await newTrial();
      const created = await newAdminChat(trial);
      expect(created).toMatchObject({
        agentKind: 'admin_agent',
        ownerPrincipalId: trial.principalId,
      });
      const entry = await call<ChatWire>(person(trial), 'new_chat', {});
      expect(entry.agentKind).toBe('entry');
      const listed = await call<{ items: ChatWire[] }>(person(trial), 'list_chats', {});
      expect(listed.items.map((chat) => [chat.id, chat.agentKind])).toEqual(
        expect.arrayContaining([
          [created.id, 'admin_agent'],
          [entry.id, 'entry'],
        ]),
      );

      const plain = await createUser(pool, {
        login: `aa4c-plain-${randomUUID().slice(0, 8)}`,
        displayName: 'Plain Member',
      });
      const plainMember = await addMember(trial.workspaceId, plain);
      const standard = await newWorkspace(admin, 'standard');
      const adminChats = async () =>
        (
          await withAdminClient(pool, (client) =>
            client.query<{ n: number }>(
              `select count(*)::int as n from chats where agent_kind = 'admin_agent'
                and workspace_id = any($1::uuid[])`,
              [[trial.workspaceId, standard.workspaceId]],
            ),
          )
        ).rows[0]?.n;
      const before = await adminChats();
      const refusals: Array<[string, unknown]> = [
        ['not_trial_workspace', await thrownBy(newAdminChat(standard))],
        ['not_platform_admin', await thrownBy(newAdminChat(plainMember))],
        ['switched_off', await withSwitchOff(() => thrownBy(newAdminChat(trial)))],
      ];
      for (const [reason, err] of refusals) {
        expect(err, reason).toBeInstanceOf(AdminAgentRefused);
        expect(mapCapabilityError(err), reason).toEqual({
          status: 403,
          code: 'admin_agent_refused',
          message: (err as Error).message,
          details: { reason },
        });
        expect(mapDispatchError(err).code, reason).toBe(WS_ERROR_CODES.FORBIDDEN);
      }
      expect(await adminChats()).toBe(before);
    });

    it('a Turn in an admin agent Chat runs under the person’s one admin_agent session there, shared by their admin Chats and recorded on the Turn when it starts; an entry Turn records none', async () => {
      const trial = await newTrial();
      const first = await newAdminChat(trial);
      const second = await newAdminChat(trial);
      const entry = await call<ChatWire>(person(trial), 'new_chat', {});

      const { turnId } = await send(trial, first.id);
      const started = await turnRow(trial, turnId);
      const sessionId = started?.metadata.sessionId as string;
      expect(started?.metadata).toMatchObject({ sessionKind: 'admin_agent' });
      expect(await sessionRow(sessionId)).toEqual({
        kind: 'admin_agent',
        principal_id: trial.principalId,
        on_behalf_of: trial.principalId,
        status: 'active',
      });
      expect(await turnStartedPayload(trial, turnId)).toMatchObject({
        agentKind: 'admin_agent',
        sessionId,
      });

      // The other admin Chat, and the next Turn of the first: the same session.
      const { turnId: secondTurn } = await send(trial, second.id);
      expect((await turnRow(trial, secondTurn))?.metadata.sessionId).toBe(sessionId);
      await call(person(trial), 'stop_agent', { chatId: first.id });
      expect((await turnRow(trial, turnId))?.status).toBe('interrupted');
      const { turnId: again } = await send(trial, first.id);
      expect((await turnRow(trial, again))?.metadata.sessionId).toBe(sessionId);
      // The Handle the runtime will hold is issued under it too.
      expect((await agentHandle(trial)).issued.sessionId).toBe(sessionId);

      const { turnId: entryTurn } = await send(trial, entry.id);
      const entryRow = await turnRow(trial, entryTurn);
      expect(entryRow?.metadata).not.toHaveProperty('sessionKind');
      expect(entryRow?.metadata).not.toHaveProperty('sessionId');
      const entryEvent = await turnStartedPayload(trial, entryTurn);
      expect(entryEvent).not.toHaveProperty('agentKind');
      expect(entryEvent).not.toHaveProperty('sessionId');
      // Written once: the Turn's session is not changed afterwards (core 0052).
      await expect(
        withAdminClient(pool, (client) =>
          client.query(
            `update activities set metadata = metadata || jsonb_build_object('sessionId', $2::text)
              where id = $1`,
            [again, randomUUID()],
          ),
        ),
      ).rejects.toThrow();
    });

    it('D4: with the switch off, the person still reads their admin agent Chats and starts no Turn; once they are no longer an administrator, neither', async () => {
      const trial = await newTrial();
      const chat = await newAdminChat(trial);
      const entry = await call<ChatWire>(person(trial), 'new_chat', {});
      await send(trial, chat.id);
      await call(person(trial), 'stop_agent', { chatId: chat.id });
      const listIds = async () =>
        (await call<{ items: ChatWire[] }>(person(trial), 'list_chats', {})).items.map(
          (item) => item.id,
        );
      const reads = () => [
        call(person(trial), 'get_chat_history', { chatId: chat.id }),
        call(person(trial), 'list_chat_turns', { chatId: chat.id }),
        call(person(trial), 'rename_chat', { chatId: chat.id, title: 'renamed' }),
      ];

      await withSwitchOff(async () => {
        expect(await listIds()).toEqual(expect.arrayContaining([chat.id, entry.id]));
        for (const read of reads()) await expect(read).resolves.toBeDefined();
        const refused = await thrownBy(send(trial, chat.id));
        expect(refused).toBeInstanceOf(AdminAgentRefused);
        expect((refused as AdminAgentRefused).reason).toBe('switched_off');
        // The entry agent's Chat is not concerned.
        await expect(send(trial, entry.id)).resolves.toMatchObject({ turnId: expect.any(String) });
      });

      await setStoredRole(admin, 'user');
      try {
        const ids = await listIds();
        expect(ids).toContain(entry.id);
        expect(ids).not.toContain(chat.id);
        for (const read of [...reads(), send(trial, chat.id)]) {
          const refused = await thrownBy(read);
          expect(refused).toBeInstanceOf(AdminAgentRefused);
          expect((refused as AdminAgentRefused).reason).toBe('not_platform_admin');
        }
      } finally {
        await setStoredRole(admin, 'admin');
      }
      await expect(send(trial, chat.id)).resolves.toMatchObject({ turnId: expect.any(String) });
    });

    it('turn attribution: what the admin session does belongs to its Turns, what the entry session does to the entry Turns — however they interleave, running or recent', async () => {
      const trial = await newTrial();
      const adminChat = await newAdminChat(trial);
      const entryOne = await call<ChatWire>(person(trial), 'new_chat', {});
      const entryTwo = await call<ChatWire>(person(trial), 'new_chat', {});
      const entrySession = (
        await withAdminClient(pool, (client) =>
          client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'entry', $2, 'active') returning id`,
            [trial.workspaceId, trial.principalId],
          ),
        )
      ).rows[0]?.id as string;

      // An entry Turn, then an admin Turn, then another entry Turn: each newest in turn.
      const { turnId: entryFirst } = await send(trial, entryOne.id);
      const { turnId: adminTurn } = await send(trial, adminChat.id);
      const adminSession = (await turnRow(trial, adminTurn))?.metadata.sessionId as string;
      const attributed = (sessionId: string) =>
        withWorkspace(pool, trial, (client: PoolClient) =>
          findAttributableTurnForSession(client, {
            workspaceId: trial.workspaceId,
            sessionId,
            at: new Date(),
          }),
        );
      expect(await attributed(entrySession)).toEqual({ id: entryFirst, wasRunning: true });
      expect(await attributed(adminSession)).toEqual({ id: adminTurn, wasRunning: true });
      const { turnId: entrySecond } = await send(trial, entryTwo.id);
      expect(await attributed(adminSession)).toEqual({ id: adminTurn, wasRunning: true });
      // Two entry Turns running: the newest, as before AA4c.
      expect(await attributed(entrySession)).toEqual({ id: entrySecond, wasRunning: true });

      // All stopped: the recency window, each to its own.
      for (const chatId of [entryOne.id, adminChat.id, entryTwo.id]) {
        await call(person(trial), 'stop_agent', { chatId });
      }
      expect(await attributed(adminSession)).toEqual({ id: adminTurn, wasRunning: false });
      expect(await attributed(entrySession)).toEqual({ id: entrySecond, wasRunning: false });
      // Another person's admin session never reaches this person's Turns, nor the other way.
      const other = await addMember(trial.workspaceId, await newAdmin());
      const { issued: otherIssued } = await agentHandle(other);
      expect(await attributed(otherIssued.sessionId)).toBeUndefined();
    });

    it('legacy 589: an admin agent Turn whose session’s every model call was refused is said to be, by its own session’s calls only', async () => {
      const trial = await newTrial();
      const chat = await newAdminChat(trial);
      const { turnId } = await send(trial, chat.id);
      const { issued } = await agentHandle(trial);
      expect(issued.sessionId).toBe((await turnRow(trial, turnId))?.metadata.sessionId);
      let clock = Date.now();
      const meter = (outcome: 'completed' | LlmRefusalScope) => {
        clock += 1000;
        const answered = outcome === 'completed';
        return withAdminClient(pool, (client) =>
          client.query(
            `insert into llm_usage (
               workspace_id, session_id, jti, turn_id, provider, model,
               input_tokens, output_tokens, cost_usd, started_at, finished_at, status, request_id,
               refusal_scope
             ) values ($1, $2, $3, $4, 'example-provider', 'example-model', $5, $6, $7, $8, $8,
                       $9, $10, $11)`,
            [
              trial.workspaceId,
              issued.sessionId,
              issued.jti,
              turnId,
              answered ? 100 : 0,
              answered ? 20 : 0,
              answered ? 0.001 : 0,
              new Date(clock).toISOString(),
              answered ? 'completed' : 'refused',
              randomUUID(),
              answered ? null : outcome,
            ],
          ),
        );
      };
      const verdict = () =>
        withWorkspace(pool, trial, (client) =>
          entryTurnRefusedOnly(client, trial.workspaceId, turnId),
        );
      expect(await verdict()).toBeNull();
      await meter('workspace_daily_tokens');
      await meter('workspace_daily_cost');
      expect(await verdict()).toMatchObject({ refusedCalls: 2, scope: 'workspace_daily_cost' });
      await meter('completed');
      expect(await verdict()).toBeNull();
    });

    // -----------------------------------------------------------------------------------------
    // Targets (governance 0036, F5; the AA4c plan's D1–D3)
    // -----------------------------------------------------------------------------------------

    it('set_admin_agent_targets: a person chooses their admin agent’s targets in a trial workspace they are in — the whole list, one platform audit row per change, what was added and removed', async () => {
      const trial = await newTrial();
      const set = (ids: readonly string[]) =>
        call<AdminAgentTargetsResultWire>(platform(admin), 'set_admin_agent_targets', {
          trialWorkspaceId: trial.workspaceId,
          targetWorkspaceIds: ids,
        });
      const first = await set([targetB, targetA, targetA]);
      expect(first.added).toEqual([targetA, targetB].sort());
      expect(first.removed).toEqual([]);
      expect(first.targets.map((target) => target.workspaceId).sort()).toEqual(
        [targetA, targetB].sort(),
      );
      expect(first.targets[0]).toMatchObject({ status: 'active', chosenAt: expect.any(String) });
      const audit = await lastPlatformAudit('set_admin_agent_targets', admin.id);
      expect(audit).toMatchObject({
        resource_type: 'workspace',
        resource_id: trial.workspaceId,
        payload: expect.objectContaining({
          added: [targetA, targetB].sort(),
          removed: [],
        }),
      });

      const second = await set([targetB]);
      expect(second).toMatchObject({ added: [], removed: [targetA] });
      expect(second.targets.map((target) => target.workspaceId)).toEqual([targetB]);

      // What cannot be a target is refused — every one of them, by id — and nothing changes.
      const otherTrial = await newTrial();
      const unknown = randomUUID();
      const refused = await thrownBy(
        set([targetB, disabledTarget, otherTrial.workspaceId, trial.workspaceId, unknown]),
      );
      expect(refused).toBeInstanceOf(AdminAgentTargetsInvalidError);
      expect(mapCapabilityError(refused)).toMatchObject({
        status: 400,
        code: 'invalid_params',
        details: {
          targetWorkspaceIds: [disabledTarget, otherTrial.workspaceId, trial.workspaceId, unknown],
        },
      });
      expect(mapDispatchError(refused).code).toBe(WS_ERROR_CODES.INVALID_PARAMS);
      const status = await call<AdminAgentStatusWire>(
        platform(admin),
        'get_admin_agent_status',
        {},
      );
      const here = status.workspaces.find((entry) => entry.workspaceId === trial.workspaceId);
      expect(here?.targets.map((target) => target.workspaceId)).toEqual([targetB]);

      // One chosen and disabled since stays, reading disabled; it is not added again.
      const fading = (await newWorkspace(targetOwner, 'standard')).workspaceId;
      await set([targetB, fading]);
      await withAdminClient(pool, (client) =>
        client.query(`update workspaces set status = 'disabled' where id = $1`, [fading]),
      );
      const kept = await set([fading, targetB]);
      expect(kept).toMatchObject({ added: [], removed: [] });
      expect(kept.targets.find((target) => target.workspaceId === fading)?.status).toBe('disabled');
      const dropped = await set([targetB]);
      expect(dropped.removed).toEqual([fading]);
      expect(mapCapabilityError(await thrownBy(set([targetB, fading])))).toMatchObject({
        details: { targetWorkspaceIds: [fading] },
      });

      // Any person of the trial workspace, a member too; not someone who is not in it.
      const member = await newAdmin();
      await addMember(trial.workspaceId, member);
      await expect(
        call(platform(member), 'set_admin_agent_targets', {
          trialWorkspaceId: trial.workspaceId,
          targetWorkspaceIds: [targetA],
        }),
      ).resolves.toMatchObject({ added: [targetA] });
      const stranger = await newAdmin();
      const standard = await newWorkspace(admin, 'standard');
      for (const [who, trialWorkspaceId] of [
        [stranger, trial.workspaceId],
        [admin, standard.workspaceId],
        [admin, randomUUID()],
      ] as const) {
        const notFound = await thrownBy(
          call(platform(who), 'set_admin_agent_targets', {
            trialWorkspaceId,
            targetWorkspaceIds: [targetA],
          }),
        );
        expect(notFound).toBeInstanceOf(AdminAgentTrialWorkspaceNotFoundError);
        expect(mapCapabilityError(notFound)).toMatchObject({ status: 404, code: 'not_found' });
        expect(mapDispatchError(notFound).code).toBe(WS_ERROR_CODES.NOT_FOUND);
      }

      // An administrator by NEXTTIME_PLATFORM_ADMINS alone: the database reads the stored role.
      await setStoredRole(member, 'user');
      const notStored = await thrownBy(
        call(platform(member), 'set_admin_agent_targets', {
          trialWorkspaceId: trial.workspaceId,
          targetWorkspaceIds: [],
        }),
      );
      expect(notStored).toBeInstanceOf(AdminAgentRoleNotStoredError);
      expect(mapCapabilityError(notStored)).toMatchObject({
        status: 409,
        code: 'admin_role_not_stored',
      });
      expect(mapDispatchError(notStored).code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);
    });

    it('R-1: the agent reads the ids its own person chose and nothing else; another administrator’s agent in the same trial workspace reads theirs; a workspace transaction reads and writes no row', async () => {
      const trial = await newTrial();
      const otherAdmin = await newAdmin();
      const other = await addMember(trial.workspaceId, otherAdmin);
      await call(platform(admin), 'set_admin_agent_targets', {
        trialWorkspaceId: trial.workspaceId,
        targetWorkspaceIds: [targetA, targetB],
      });
      await call(platform(otherAdmin), 'set_admin_agent_targets', {
        trialWorkspaceId: trial.workspaceId,
        targetWorkspaceIds: [targetB],
      });
      const mine = await agentHandle(trial);
      const theirs = await agentHandle(other);
      expect(
        await call<AgentProposalTargetsWire>(mine.caller, 'agent_list_proposal_targets', {}),
      ).toEqual({ targetWorkspaceIds: [targetA, targetB].sort() });
      expect(
        await call<AgentProposalTargetsWire>(theirs.caller, 'agent_list_proposal_targets', {}),
      ).toEqual({ targetWorkspaceIds: [targetB] });
      // The person on the human channel has no such read: it is the agent's.
      await expect(call(person(trial), 'agent_list_proposal_targets', {})).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // Nothing an admin agent's Handle may call changes them.
      for (const name of [
        'set_admin_agent_targets',
        'stop_admin_agent',
        'get_admin_agent_status',
      ]) {
        await expect(call(mine.caller, name, {}), name).rejects.toBeInstanceOf(ForbiddenError);
      }

      // The table itself is the platform's: a workspace transaction sees no row and writes none —
      // not even a row the guard would let through.
      const fresh = (await newWorkspace(targetOwner, 'standard')).workspaceId;
      const seen = await withWorkspace(pool, trial, (client) =>
        client.query<{ n: number }>('select count(*)::int as n from admin_agent_targets'),
      );
      expect(seen.rows[0]?.n).toBe(0);
      await expect(
        withWorkspace(pool, trial, (client) =>
          client.query(
            `insert into admin_agent_targets
               (workspace_id, principal_id, target_workspace_id, chosen_by_user)
             values ($1, $2, $3, $4)`,
            [trial.workspaceId, trial.principalId, fresh, admin.id],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      // The definer read answers for the transaction's own Principal, whichever it is.
      const asOther = await withWorkspace(pool, other, (client) =>
        client.query<{ id: string }>('select admin_agent_chosen_targets() as id'),
      );
      expect(asOther.rows.map((row) => row.id)).toEqual([targetB]);
      const elsewhere = await withWorkspace(
        pool,
        { workspaceId: targetA, principalId: trial.principalId },
        (client) => client.query<{ id: string }>('select admin_agent_chosen_targets() as id'),
      );
      expect(elsewhere.rows).toEqual([]);
    });

    it('governance 0036: a row is a platform administrator’s own choice of an active standard target for their admin agent in a trial workspace — written past the kernel too — and never updated', async () => {
      const trial = await newTrial();
      const standard = await newWorkspace(admin, 'standard');
      const plain = await createUser(pool, {
        login: `aa4c-plain-${randomUUID().slice(0, 8)}`,
        displayName: 'Plain Member',
      });
      const plainMember = await addMember(trial.workspaceId, plain);
      const otherTrial = await newTrial();
      const insert = (
        member: Membership,
        targetWorkspaceId: string,
        chosenByUser: string = admin.id,
      ) =>
        withAdminClient(pool, (client) =>
          client.query(
            `insert into admin_agent_targets
               (workspace_id, principal_id, target_workspace_id, chosen_by_user)
             values ($1, $2, $3, $4)`,
            [member.workspaceId, member.principalId, targetWorkspaceId, chosenByUser],
          ),
        );
      await expect(insert(standard, targetA)).rejects.toThrow(/in a trial workspace only/);
      for (const target of [disabledTarget, otherTrial.workspaceId]) {
        await expect(insert(trial, target)).rejects.toThrow(/an active standard workspace/);
      }
      await expect(insert(trial, targetA, targetOwner.id)).rejects.toThrow(
        /chooses the targets of their own admin agent/,
      );
      await expect(insert(plainMember, targetA, plain.id)).rejects.toThrow(
        /chooses the targets of their own admin agent/,
      );
      await insert(trial, targetA);
      await expect(
        withAdminClient(pool, (client) =>
          client.query(
            `update admin_agent_targets set target_workspace_id = $3
              where workspace_id = $1 and principal_id = $2`,
            [trial.workspaceId, trial.principalId, targetB],
          ),
        ),
      ).rejects.toThrow(/never changed/);
    });

    it('get_admin_agent_status: the switch, and per trial workspace the person is in — whether the agent may start there, its targets and its open session', async () => {
      const someone = await newAdmin();
      const trial = await newWorkspace(someone, 'admin_trial');
      const disabledTrial = await newWorkspace(someone, 'admin_trial');
      await withAdminClient(pool, (client) =>
        client.query(`update workspaces set status = 'disabled' where id = $1`, [
          disabledTrial.workspaceId,
        ]),
      );
      await call(platform(someone), 'set_admin_agent_targets', {
        trialWorkspaceId: trial.workspaceId,
        targetWorkspaceIds: [targetA],
      });
      const chat = await call<ChatWire>(person(trial), 'new_chat', { agentKind: 'admin_agent' });
      const { turnId } = await send(trial, chat.id);
      const sessionId = (await turnRow(trial, turnId))?.metadata.sessionId;

      const status = await call<AdminAgentStatusWire>(
        platform(someone),
        'get_admin_agent_status',
        {},
      );
      expect(status.enabled).toBe(true);
      const byId = new Map(status.workspaces.map((entry) => [entry.workspaceId, entry]));
      expect(byId.size).toBe(2);
      expect(byId.get(trial.workspaceId)).toMatchObject({
        refusal: null,
        targets: [{ workspaceId: targetA, status: 'active' }],
        session: { sessionId, startedAt: expect.any(String) },
      });
      expect(byId.get(disabledTrial.workspaceId)).toMatchObject({
        refusal: 'workspace_disabled',
        targets: [],
        session: null,
      });
      const off = await withSwitchOff(() =>
        call<AdminAgentStatusWire>(platform(someone), 'get_admin_agent_status', {}),
      );
      expect(off.enabled).toBe(false);
      expect(off.workspaces.map((entry) => entry.refusal)).toEqual([
        'switched_off',
        'switched_off',
      ]);
      // Another administrator reads only their own.
      const stranger = await newAdmin();
      expect(
        (await call<AdminAgentStatusWire>(platform(stranger), 'get_admin_agent_status', {}))
          .workspaces,
      ).toEqual([]);
    });

    // -----------------------------------------------------------------------------------------
    // Stopping (D6)
    // -----------------------------------------------------------------------------------------

    it('stop_admin_agent revokes the session and its Handles in the platform transaction, then stops the running admin Turns — not the entry ones; the next message opens a new session', async () => {
      const trial = await newTrial();
      const chat = await newAdminChat(trial);
      const entry = await call<ChatWire>(person(trial), 'new_chat', {});
      const { turnId } = await send(trial, chat.id);
      const sessionId = (await turnRow(trial, turnId))?.metadata.sessionId as string;
      const { issued } = await agentHandle(trial);
      expect(issued.sessionId).toBe(sessionId);
      const { turnId: entryTurn } = await send(trial, entry.id);

      const stopped = await call<AdminAgentStopResultWire>(platform(admin), 'stop_admin_agent', {
        trialWorkspaceId: trial.workspaceId,
      });
      expect(stopped).toEqual({ revokedSessions: 1, stoppedTurns: 1 });
      expect((await sessionRow(sessionId))?.status).toBe('revoked');
      await expect(
        authenticateHandle(pool, issued.token, { publicKey }, 'source'),
      ).rejects.toBeInstanceOf(HandleRevoked);
      expect((await turnRow(trial, turnId))?.status).toBe('interrupted');
      expect((await turnRow(trial, entryTurn))?.status).toBe('running');
      const audit = await lastPlatformAudit('stop_admin_agent', admin.id);
      expect(audit).toMatchObject({
        resource_type: 'workspace',
        resource_id: trial.workspaceId,
        payload: expect.objectContaining({
          trialWorkspaceIds: [trial.workspaceId],
          revokedSessionIds: [sessionId],
        }),
      });

      // The Chat stays; the next message opens a new session.
      const { turnId: next } = await send(trial, chat.id);
      const nextSession = (await turnRow(trial, next))?.metadata.sessionId as string;
      expect(nextSession).not.toBe(sessionId);
      expect((await sessionRow(nextSession))?.status).toBe('active');

      // Everywhere at once: every trial workspace of the person's; only what is still open counts.
      const all = await call<AdminAgentStopResultWire>(platform(admin), 'stop_admin_agent', {});
      expect(all.revokedSessions).toBeGreaterThanOrEqual(1);
      expect((await sessionRow(nextSession))?.status).toBe('revoked');
      expect((await turnRow(trial, next))?.status).toBe('interrupted');
      await expect(
        call(platform(admin), 'stop_admin_agent', { trialWorkspaceId: trial.workspaceId }),
      ).resolves.toEqual({ revokedSessions: 0, stoppedTurns: 0 });

      // Only one's own: a trial workspace one is not in reads as none.
      const stranger = await newAdmin();
      const notFound = await thrownBy(
        call(platform(stranger), 'stop_admin_agent', { trialWorkspaceId: trial.workspaceId }),
      );
      expect(notFound).toBeInstanceOf(AdminAgentTrialWorkspaceNotFoundError);
      await expect(call(platform(stranger), 'stop_admin_agent', {})).resolves.toEqual({
        revokedSessions: 0,
        stoppedTurns: 0,
      });
      expect((await turnRow(trial, entryTurn))?.status).toBe('running');
    });
  },
);
