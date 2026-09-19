// @vitest-environment jsdom
import type { ChatStreamPayload } from '@nexttime/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, test, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import type { ChatMessage, ChatSubscriptionHandlers, WsClient } from '../lib/ws-client.js';
import { ChatPage } from './ChatPage.js';
import { ToastProvider } from './ui/Toast.js';

afterEach(cleanup);

/**
 * ChatPage.test.tsx: C8 (the "always allow" guard) and the W3 auto-follow reproduction
 * (docs/console-completion-plan.md §2 row W3, §9). The `WsClient` is a hand-rolled stub whose
 * `subscribeChat` captures the page's handlers so a test can play persisted messages, stream
 * chunks and "caught up" into the page exactly as the socket would.
 */

interface FakeClient {
  readonly client: WsClient;
  readonly deliver: (message: ChatMessage) => void;
  readonly stream: (turnId: string, payload: ChatStreamPayload) => void;
  readonly caughtUp: () => void;
}

function fakeClient(): FakeClient {
  let handlers: ChatSubscriptionHandlers | undefined;
  const client = {
    call: vi.fn(async (name: string) => {
      if (name === 'list_chats') return { items: [{ id: 'chat-1', title: 'Ops chat' }] };
      throw new Error(`unscripted ws capability ${name}`);
    }),
    subscribeChat: vi.fn(
      async (_chatId: string, _startAfter: number, h: ChatSubscriptionHandlers) => {
        handlers = h;
        return () => undefined;
      },
    ),
    sendChatMessage: vi.fn(async () => ({ messageId: 'm-user', sequence: 1, turnId: 'turn-1' })),
    stopAgent: vi.fn(async () => ({ stopped: true })),
    onActionUpdated: vi.fn(() => () => undefined),
    onActionPending: vi.fn(() => () => undefined),
    onTaskUpdated: vi.fn(() => () => undefined),
    getStatus: () => 'connected',
    onStatusChange: () => () => undefined,
  } as unknown as WsClient;
  return {
    client,
    deliver: (message) => handlers?.onMessage(message),
    stream: (turnId, payload) => handlers?.onStream(turnId, payload),
    caughtUp: () => handlers?.onCaughtUp?.(),
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function renderChat(client: WsClient, http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <ToastProvider>
        <ChatPage
          client={client}
          http={http}
          chatId="chat-1"
          onBack={vi.fn()}
          onOpenApproval={vi.fn()}
          onOpenTask={vi.fn()}
        />
      </ToastProvider>
    </PermissionsProvider>,
  );
}

function pendingCardMessage(sequence: number, actionRequestId: string): ChatMessage {
  return {
    id: `m${sequence}`,
    role: 'system',
    text: 'docker container restart requested',
    createdAt: '2026-09-03T00:00:00.000Z',
    sequence,
    kind: 'system.action_pending',
    content: {
      kind: 'system.action_pending',
      text: 'docker container restart requested',
      actionRequestId,
      gatekeeperId: 'gk-1',
      actionKindTag: 'docker.container_restart',
      resourceScope: 'web-1',
      blastRadius: 'medium',
      awaitDecision: true,
      isHolder: true,
    },
  };
}

describe('ChatPage inline approval card (C8)', () => {
  it('"always allow" writes the rule with the kind tag read from the persisted card', async () => {
    const fake = fakeClient();
    const http = scriptedHttp({
      approve: () => ({ status: 'approved' }),
      set_auto_approved_action_kind: () => ({}),
    });
    renderChat(fake.client, http);
    await waitFor(() => expect(fake.client.subscribeChat).toHaveBeenCalled());
    act(() => {
      fake.deliver(pendingCardMessage(1, 'ar-1'));
      fake.caughtUp();
    });

    const card = await screen.findByTestId('action-request-detail');
    fireEvent.click(within(card).getByRole('checkbox'));
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(http.calls.map((call) => call.name)).toEqual([
        'approve',
        'set_auto_approved_action_kind',
      ]),
    );
    expect(http.calls[1]?.params).toEqual({ actionKindTag: 'docker.container_restart' });
    await screen.findByText(/will be auto-approved from now on/);
  });
});

/**
 * W3 reproduction (console-completion-plan §2 row W3; §9 "W3 用 ... 复现两种情形后再修") — two
 * candidate mechanisms for "the thread stops following the stream", each pinned with mocked
 * element geometry. Both are `test.fails`: the assertion states the *desired* behaviour, so the
 * test passes today only because the page still exhibits the bug, and flips red the moment the
 * chat lane fixes it (bottom sentinel + `IntersectionObserver`, or ignoring self-triggered scroll
 * events) — at which point `test.fails` becomes `it`.
 *
 * Geometry: `.chat-scroll` gets own-property `clientHeight` (fixed viewport), `scrollHeight` (a
 * variable the test bumps when it "commits" content) and a `scrollTop` accessor that clamps to
 * `scrollHeight - clientHeight` the way a real element does — a write past the end lands on the
 * bottom, which is what the page's own `el.scrollTop = el.scrollHeight` relies on.
 */
interface Geometry {
  readonly el: HTMLElement;
  setScrollHeight: (px: number) => void;
  readonly scrollTop: () => number;
  readonly maxScrollTop: () => number;
}

function mockGeometry(
  el: HTMLElement,
  clientHeight: number,
  initialScrollHeight: number,
): Geometry {
  let scrollHeight = initialScrollHeight;
  let scrollTop = 0;
  const maxScrollTop = () => Math.max(0, scrollHeight - clientHeight);
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(Math.max(0, value), maxScrollTop());
    },
  });
  return {
    el,
    setScrollHeight: (px) => {
      scrollHeight = px;
    },
    scrollTop: () => scrollTop,
    maxScrollTop,
  };
}

async function startRunningTurn(fake: FakeClient): Promise<Geometry> {
  await waitFor(() => expect(fake.client.subscribeChat).toHaveBeenCalled());
  act(() => fake.caughtUp());
  const el = screen.getByTestId('chat-thread').parentElement;
  if (!el) throw new Error('expected .chat-scroll');
  const geometry = mockGeometry(el, 300, 300);
  // Only `send()` puts the reducer into `running` (a `chat.stream` for an unknown turnId is
  // ignored), so the stream is started the way the page starts it.
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'restart web' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(fake.client.sendChatMessage).toHaveBeenCalled());
  await screen.findByText('Agent is responding');
  return geometry;
}

describe('W3 reproduction: auto-follow stops during a stream', () => {
  // Mechanism (a): the `scroll` event a programmatic `scrollTop` write produces is asynchronous.
  // If the next stream chunk is committed (scrollHeight grows) before that event is dispatched,
  // `onScroll` measures the new chunk's height as "distance from bottom"; past
  // AT_BOTTOM_THRESHOLD_PX (48) it flips `atBottom` to false and every later chunk's effect
  // declines to scroll. This test forces exactly that ordering — commit, then the stale scroll
  // event, then the effect — which is the HTML event-loop order (scroll events fire in the
  // rendering steps, React passive effects after paint); a Playwright run is what proves the
  // browser actually interleaves them this way on a fast model.
  test.fails(
    '(a) a stale scroll event measured after the next chunk committed must not stop following',
    async () => {
      const fake = fakeClient();
      renderChat(fake.client, scriptedHttp({}));
      const geometry = await startRunningTurn(fake);

      // Chunk 1: two lines land, the effect writes scrollTop to the (new) bottom.
      geometry.setScrollHeight(400);
      act(() => fake.stream('turn-1', { streamKind: 'textDelta', delta: 'line 1\nline 2\n' }));
      expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());

      // Chunk 2 commits — scrollHeight grows by 100 px — and only *then* does chunk 1's scroll
      // event arrive. `onScroll` sees 500 - 100 - 300 = 100 px > 48 px and flips atBottom.
      geometry.setScrollHeight(500);
      fireEvent.scroll(geometry.el);
      act(() => fake.stream('turn-1', { streamKind: 'textDelta', delta: 'line 3\nline 4\n' }));

      // Chunk 3: with atBottom false the effect no longer writes scrollTop.
      geometry.setScrollHeight(600);
      act(() => fake.stream('turn-1', { streamKind: 'textDelta', delta: 'line 5\nline 6\n' }));

      // Desired: the reader never scrolled up, so the view follows and no "Jump to latest" appears.
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
      expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());
    },
  );

  // Mechanism (b): the scroll write is keyed on `contentVersion` =
  // `${messages.length}:${streamingText.length}:${toolCalls.length}`. A tool-call row that is
  // already on screen and whose *result* arrives later grows in place — `toolCalls.length` is
  // unchanged, so no effect runs and nothing scrolls, with no race involved at all.
  test.fails(
    '(b) a tool-call result growing in place (toolCalls.length unchanged) must still scroll to the bottom',
    async () => {
      const fake = fakeClient();
      renderChat(fake.client, scriptedHttp({}));
      const geometry = await startRunningTurn(fake);

      // The row appears (toolCalls 0 → 1): the effect writes scrollTop to the bottom.
      geometry.setScrollHeight(400);
      act(() =>
        fake.stream('turn-1', {
          streamKind: 'toolCallStarted',
          toolCallId: 'tc-1',
          name: 'docker.logs',
          args: { container: 'web-1' },
        }),
      );
      expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());

      // Its result lands — 500 px of log text — but `toolCalls.length` is still 1.
      geometry.setScrollHeight(900);
      act(() =>
        fake.stream('turn-1', {
          streamKind: 'toolCallEnded',
          toolCallId: 'tc-1',
          result: 'x'.repeat(4000),
        }),
      );

      // Desired: the view still follows the (now much taller) content.
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
      expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());
    },
  );
});
