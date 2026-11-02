import { SystemMessageContentSchema } from '@nexttime/shared';
import { type Page, expect } from '@playwright/test';

/**
 * e2e/lib/chat-stand-ins.ts: messages the CI stack cannot produce (its agent runtime only echoes),
 * appended to a real chat's history as the socket carries it — the rest of the page is the real
 * stack. Shared by chat-goal.spec.ts (a goal's proposal and milestones, S11 GO5e-2) and
 * chat-model-refused.spec.ts (a Turn the platform refused, legacy 589).
 */

/** A chat message as `get_chat_history` returns it. */
export interface StandInMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
  readonly createdAt: string;
  readonly sequence: number;
  readonly kind?: string;
  readonly content: Record<string, unknown>;
  readonly turnId: string | null;
}

/** A system message whose content the shared schema accepts (a typo fails the test, not the page). */
export function systemMessage(
  sequence: number,
  at: string,
  content: Record<string, unknown>,
): StandInMessage {
  const parsed = SystemMessageContentSchema.parse(content);
  return {
    id: `stand-in-${sequence}`,
    role: 'system',
    text: parsed.text,
    createdAt: at,
    sequence,
    kind: parsed.kind,
    content: parsed,
    turnId: null,
  };
}

/** A message the person sent. */
export function userMessage(
  sequence: number,
  at: string,
  text: string,
  turnId: string | null = null,
): StandInMessage {
  return {
    id: `stand-in-${sequence}`,
    role: 'user',
    text,
    createdAt: at,
    sequence,
    content: { text },
    turnId,
  };
}

/** Neither a status line nor the page scrolls sideways: a long statement is cut with its whole
 *  text as the title, the line itself wraps. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const lines = page.getByTestId('system-status-line');
  for (const line of await lines.all()) {
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** Appends `extra(lastSequence)` to the last page of every chat history the page reads over the
 *  socket; every other frame passes through unchanged, both ways. */
export async function appendToChatHistory(
  page: Page,
  extra: (lastSequence: number) => readonly StandInMessage[],
): Promise<void> {
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    const historyCalls = new Set<unknown>();
    ws.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message)) as { id?: unknown; method?: string };
        if (frame.method === 'get_chat_history') historyCalls.add(frame.id);
      } catch {
        // Not JSON: forwarded as it is.
      }
      server.send(message);
    });
    server.onMessage((message) => {
      let frame: {
        id?: unknown;
        result?: { items: { sequence: number }[]; nextCursor?: string };
      };
      try {
        frame = JSON.parse(String(message));
      } catch {
        ws.send(message);
        return;
      }
      if (!historyCalls.has(frame.id) || !frame.result) {
        ws.send(message);
        return;
      }
      historyCalls.delete(frame.id);
      if (frame.result.nextCursor === undefined) {
        const last = frame.result.items.at(-1)?.sequence ?? 0;
        frame.result.items = [...frame.result.items, ...extra(last)];
      }
      ws.send(JSON.stringify(frame));
    });
  });
}

/** A fresh chat, opened from the chat list. */
export async function openNewChat(page: Page): Promise<void> {
  await page.goto('/#/work/chats');
  await page.locator('header').getByRole('button', { name: '新对话' }).click();
  await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
}
