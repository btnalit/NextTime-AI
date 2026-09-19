import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ChatNotFoundError } from '../chat/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/chat-lifecycle.integration.test: DB-gated (auto-skip without DATABASE_URL)
 * end-to-end test for the S6-A chat lifecycle capabilities (docs/console-completion-plan.md §4
 * "Chat 生命周期", §5.1, §6): `archive_chat` / `unarchive_chat` / `rename_chat`, `list_chats
 * {includeArchived}`, the auto-title `send_chat_message` writes, and the ownership rule —
 * driven through `dispatchCapability` so authorization, `paramsSchema`, the dispatch audit row
 * and (under `KERNEL_VALIDATE_RESULTS=1`) the registered `resultSchema` are all exercised.
 *
 * The "someone else's chat" negative paths come in two shapes, both asserted here:
 *   - a *private* chat of another member is invisible under RLS (`chats_visibility`,
 *     migrations/core/0003) → `ChatNotFoundError` (404) — existence is never leaked;
 *   - a `visibility = 'workspace'` chat (seeded directly; no capability sets it today) is visible
 *     but not owned → `ForbiddenError` (403), unless the caller is the workspace owner archiving.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
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

interface ChatWire {
  id: string;
  ownerPrincipalId: string;
  title: string | null;
  archivedAt: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'S6-A chat lifecycle: archive_chat / unarchive_chat / rename_chat / list_chats{includeArchived} (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberAId: string;
    let memberBId: string;

    async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, 'human', role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** No capability sets `visibility = 'workspace'` today (`new_chat` always writes `private`);
     *  seeded directly (admin) to reach the "visible but not owned" branch of the ownership rule. */
    async function adminSetWorkspaceVisibility(chatId: string): Promise<void> {
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            "update chats set visibility = 'workspace' where workspace_id = $1 and id = $2",
            [workspaceId, chatId],
          ),
        { skipRoleSwitch: true },
      );
    }

    async function auditActions(chatId: string): Promise<readonly string[]> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const result = await client.query<{ action: string }>(
          `select action from audit_records
           where workspace_id = $1 and resource_type = 'chat' and resource_id = $2
           order by created_at asc, id asc`,
          [workspaceId, chatId],
        );
        return result.rows.map((row) => row.action);
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'chat-lifecycle-test-workspace',
          ]);
        },
        { skipRoleSwitch: true },
      );
      ownerId = await adminInsertPrincipal('owner', 'owner');
      memberAId = await adminInsertPrincipal('member', 'member-a');
      memberBId = await adminInsertPrincipal('member', 'member-b');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('archive → hidden from list_chats by default, visible with includeArchived, unarchive restores; wire rows carry archivedAt; audit rows chat.archive/chat.unarchive', async () => {
      const memberA = humanCaller(workspaceId, memberAId, 'member');
      const chat = (await dispatchCapability({ pool }, memberA, 'new_chat', {
        title: 'lifecycle',
      })) as ChatWire;
      expect(chat.archivedAt).toBeNull();

      const archived = (await dispatchCapability({ pool }, memberA, 'archive_chat', {
        chatId: chat.id,
      })) as ChatWire;
      expect(typeof archived.archivedAt).toBe('string');

      const defaultList = (await dispatchCapability({ pool }, memberA, 'list_chats', {})) as {
        items: ChatWire[];
      };
      expect(defaultList.items.some((c) => c.id === chat.id)).toBe(false);

      const withArchived = (await dispatchCapability({ pool }, memberA, 'list_chats', {
        includeArchived: true,
      })) as { items: ChatWire[] };
      expect(withArchived.items.find((c) => c.id === chat.id)?.archivedAt).toBe(
        archived.archivedAt,
      );

      const restored = (await dispatchCapability({ pool }, memberA, 'unarchive_chat', {
        chatId: chat.id,
      })) as ChatWire;
      expect(restored.archivedAt).toBeNull();
      const afterRestore = (await dispatchCapability({ pool }, memberA, 'list_chats', {})) as {
        items: ChatWire[];
      };
      expect(afterRestore.items.some((c) => c.id === chat.id)).toBe(true);

      // Domain rows (chat.*) plus dispatch.ts's per-capability rows, all on resource chat/<id>.
      // Compared as a multiset: a domain row and its dispatch row are written in one transaction
      // and share `created_at` (`now()` is transaction-start time), so their relative order is
      // not defined.
      const actions = await auditActions(chat.id);
      expect([...actions].sort()).toEqual(
        ['new_chat', 'chat.archive', 'archive_chat', 'chat.unarchive', 'unarchive_chat'].sort(),
      );
    });

    it('rename_chat: normalizes, is audited as chat.rename, and is never overwritten by the auto-title of the first message', async () => {
      const memberA = humanCaller(workspaceId, memberAId, 'member');
      const chat = (await dispatchCapability({ pool }, memberA, 'new_chat', {})) as ChatWire;
      expect(chat.title).toBeNull();

      const renamed = (await dispatchCapability({ pool }, memberA, 'rename_chat', {
        chatId: chat.id,
        title: '  Quarterly \n review ',
      })) as ChatWire;
      expect(renamed.title).toBe('Quarterly review');

      await dispatchCapability({ pool }, memberA, 'send_chat_message', {
        chatId: chat.id,
        text: 'this text must not become the title',
      });
      const list = (await dispatchCapability({ pool }, memberA, 'list_chats', {})) as {
        items: ChatWire[];
      };
      expect(list.items.find((c) => c.id === chat.id)?.title).toBe('Quarterly review');

      expect(await auditActions(chat.id)).toContain('chat.rename');

      // A blank title is refused by paramsSchema (400 invalid_params), never written.
      await expect(
        dispatchCapability({ pool }, memberA, 'rename_chat', { chatId: chat.id, title: '   ' }),
      ).rejects.toMatchObject({ name: 'InvalidCapabilityParamsError' });
    });

    it('auto-title: the first user message of an untitled chat becomes its title (40 code points); explain(turn) keeps resolving after the chat is archived', async () => {
      const memberA = humanCaller(workspaceId, memberAId, 'member');
      const chat = (await dispatchCapability({ pool }, memberA, 'new_chat', {})) as ChatWire;
      const text = `Please summarize ${'the report '.repeat(10)}`;
      const sent = (await dispatchCapability({ pool }, memberA, 'send_chat_message', {
        chatId: chat.id,
        text,
      })) as { turnId: string };

      const list = (await dispatchCapability({ pool }, memberA, 'list_chats', {})) as {
        items: ChatWire[];
      };
      const title = list.items.find((c) => c.id === chat.id)?.title ?? '';
      expect(Array.from(title)).toHaveLength(40);
      expect(text.startsWith(title)).toBe(true);

      await dispatchCapability({ pool }, memberA, 'archive_chat', { chatId: chat.id });

      // docs/console-completion-plan.md §4: "归档只影响列表可见性，... explain(turn) 继续可解析".
      const explained = (await dispatchCapability({ pool }, memberA, 'explain', {
        nodeId: sent.turnId,
      })) as { nodeType: string; activity: { id: string; chatId: string | null } };
      expect(explained.nodeType).toBe('activity');
      expect(explained.activity.id).toBe(sent.turnId);
      // History reads are untouched by archiving too.
      const history = (await dispatchCapability({ pool }, memberA, 'get_chat_history', {
        chatId: chat.id,
      })) as { items: unknown[] };
      expect(history.items).toHaveLength(1);
    });

    it("another member's private chat is 404 (RLS, existence never leaked); a workspace-visible chat of another member is 403 for archive and rename", async () => {
      const memberA = humanCaller(workspaceId, memberAId, 'member');
      const memberB = humanCaller(workspaceId, memberBId, 'member');
      const privateChat = (await dispatchCapability({ pool }, memberA, 'new_chat', {})) as ChatWire;

      await expect(
        dispatchCapability({ pool }, memberB, 'archive_chat', { chatId: privateChat.id }),
      ).rejects.toBeInstanceOf(ChatNotFoundError);
      await expect(
        dispatchCapability({ pool }, memberB, 'rename_chat', {
          chatId: privateChat.id,
          title: 'x',
        }),
      ).rejects.toBeInstanceOf(ChatNotFoundError);

      const sharedChat = (await dispatchCapability({ pool }, memberA, 'new_chat', {})) as ChatWire;
      await adminSetWorkspaceVisibility(sharedChat.id);

      await expect(
        dispatchCapability({ pool }, memberB, 'archive_chat', { chatId: sharedChat.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        dispatchCapability({ pool }, memberB, 'unarchive_chat', { chatId: sharedChat.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        dispatchCapability({ pool }, memberB, 'rename_chat', {
          chatId: sharedChat.id,
          title: 'hijack',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Nothing was written or archived by the refused calls.
      const list = (await dispatchCapability({ pool }, memberA, 'list_chats', {})) as {
        items: ChatWire[];
      };
      const row = list.items.find((c) => c.id === sharedChat.id);
      expect(row?.archivedAt).toBeNull();
      expect(row?.title).toBeNull();
    });

    it("the workspace owner may archive/unarchive another member's visible chat (audited with the actor), but not rename it", async () => {
      const memberA = humanCaller(workspaceId, memberAId, 'member');
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const chat = (await dispatchCapability({ pool }, memberA, 'new_chat', {
        title: 'shared',
      })) as ChatWire;
      await adminSetWorkspaceVisibility(chat.id);

      const archived = (await dispatchCapability({ pool }, owner, 'archive_chat', {
        chatId: chat.id,
      })) as ChatWire;
      expect(archived.ownerPrincipalId).toBe(memberAId);
      expect(typeof archived.archivedAt).toBe('string');

      const memberList = (await dispatchCapability({ pool }, memberA, 'list_chats', {})) as {
        items: ChatWire[];
      };
      expect(memberList.items.some((c) => c.id === chat.id)).toBe(false);

      await expect(
        dispatchCapability({ pool }, owner, 'rename_chat', { chatId: chat.id, title: 'renamed' }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const restored = (await dispatchCapability({ pool }, owner, 'unarchive_chat', {
        chatId: chat.id,
      })) as ChatWire;
      expect(restored.archivedAt).toBeNull();

      const actor = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ actor_principal_id: string }>(
          `select actor_principal_id from audit_records
           where workspace_id = $1 and resource_id = $2 and action = 'chat.archive'`,
          [workspaceId, chat.id],
        ),
      );
      expect(actor.rows.map((r) => r.actor_principal_id)).toEqual([ownerId]);
    });
  },
);
