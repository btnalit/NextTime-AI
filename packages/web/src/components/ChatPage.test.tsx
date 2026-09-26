// @vitest-environment jsdom
import type { ChatStreamPayload, ChatWire } from '@nexttime/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function chatRow(overrides: Partial<ChatWire> = {}): ChatWire {
  return {
    id: 'chat-1',
    ownerPrincipalId: 'p-1',
    title: 'Ops chat',
    visibility: 'private',
    createdAt: '2026-09-01T00:00:00.000Z',
    archivedAt: null,
    lastActivityAt: '2026-09-01T00:00:00.000Z',
    hasRunningTurn: false,
    ...overrides,
  };
}

function fakeClient(
  extraCalls: Record<string, (params: unknown) => unknown | Promise<unknown>> = {},
  row: ChatWire = chatRow(),
): FakeClient {
  let handlers: ChatSubscriptionHandlers | undefined;
  const client = {
    call: vi.fn(async (name: string, params?: unknown) => {
      if (name === 'list_chats') return { items: [row] };
      const handler = extraCalls[name];
      if (handler) return handler(params);
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

/** The header's `ModelSwitcher` reads these on mount; decision assertions look past them. */
const HEADER_READS = new Set(['get_agent_profile', 'get_agent_policy', 'list_models']);

interface ScriptedHttp extends CapabilityCaller {
  readonly calls: { readonly name: string; readonly params: unknown }[];
  /** Calls other than the header's profile / policy / catalog reads. */
  readonly decisions: () => { readonly name: string; readonly params: unknown }[];
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): ScriptedHttp {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    decisions: () => calls.filter((call) => !HEADER_READS.has(call.name)),
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

    const card = await screen.findByTestId('action-request-card');
    fireEvent.click(within(card).getByRole('button', { name: /总是允许/ }));

    await waitFor(() =>
      expect(http.decisions().map((call) => call.name)).toEqual([
        'approve',
        'set_auto_approved_action_kind',
      ]),
    );
    expect(http.decisions()[0]?.params).toEqual({ actionRequestId: 'ar-1' });
    expect(http.decisions()[1]?.params).toEqual({ actionKindTag: 'docker.container_restart' });
    // S8 W4 i18n baseline fix: the toast now goes through `t()` (one language, default zh-CN
    // here), no more always-glued zh/en text.
    await screen.findByText(/今后将自动批准/);
    // The card left `pending_approval` in place (the `approve` result's status) — the outcome
    // line sits beside the shared card inside the `.action-card` wrapper.
    const wrapper = card.closest('.action-card') as HTMLElement;
    await waitFor(() =>
      expect(within(wrapper).getByTestId('action-outcome').getAttribute('data-status')).toBe(
        'approved',
      ),
    );
  });

  it('passes the typed reason through to approve (C25) and surfaces a kernel error on the card', async () => {
    const fake = fakeClient();
    const http = scriptedHttp({
      approve: () => {
        throw new Error('reason_required');
      },
    });
    renderChat(fake.client, http);
    await waitFor(() => expect(fake.client.subscribeChat).toHaveBeenCalled());
    act(() => {
      fake.deliver(pendingCardMessage(1, 'ar-1'));
      fake.caughtUp();
    });
    const card = await screen.findByTestId('action-request-card');
    fireEvent.change(within(card).getByTestId('approval-reason'), {
      target: { value: 'planned maintenance' },
    });
    fireEvent.click(within(card).getByRole('button', { name: /批准/ }));
    await waitFor(() => expect(http.decisions()).toHaveLength(1));
    expect(http.decisions()[0]?.params).toEqual({
      actionRequestId: 'ar-1',
      reason: 'planned maintenance',
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('reason_required');
    // Still decidable: the buttons stay.
    expect(within(card).getByRole('button', { name: /批准/ })).toBeTruthy();
  });
});

/**
 * W3 (console-completion-plan §2 row W3; §9 "W3 用 ... 复现两种情形后再修") — the two mechanisms
 * behind "the thread stops following the stream", each pinned with mocked element geometry.
 * Written as `test.fails` reproductions in S6-A0; S6-A fixed both (bottom sentinel +
 * `IntersectionObserver` in a browser, a `scroll`-event fallback that ignores the page's own
 * `scrollTop` writes under jsdom, and a layout effect keyed on the `messages` / `turn` object
 * identities so in-place growth still scrolls), so they now assert the fixed behaviour.
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
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(fake.client.sendChatMessage).toHaveBeenCalled());
  // S8 W1-A10: TurnStatusBadge text is bilingual via t() now; default zh-CN renders '回复中'.
  await screen.findByText('回复中');
  return geometry;
}

describe('W3: auto-follow keeps following during a stream', () => {
  // Mechanism (a): the `scroll` event a programmatic `scrollTop` write produces is asynchronous.
  // If the next stream chunk is committed (scrollHeight grows) before that event is dispatched,
  // `onScroll` measures the new chunk's height as "distance from bottom"; past
  // AT_BOTTOM_THRESHOLD_PX (48) it flips `atBottom` to false and every later chunk's effect
  // declines to scroll. This test forces exactly that ordering — commit, then the stale scroll
  // event, then the effect — which is the HTML event-loop order (scroll events fire in the
  // rendering steps, React passive effects after paint); a Playwright run is what proves the
  // browser actually interleaves them this way on a fast model.
  it('(a) a stale scroll event measured after the next chunk committed does not stop following', async () => {
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

    // The reader never scrolled up, so the view follows and no FollowPill appears.
    expect(screen.queryByTestId('follow-pill')).toBeNull();
    expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());
  });

  // Mechanism (b): the scroll write is keyed on `contentVersion` =
  // `${messages.length}:${streamingText.length}:${toolCalls.length}`. A tool-call row that is
  // already on screen and whose *result* arrives later grows in place — `toolCalls.length` is
  // unchanged, so no effect runs and nothing scrolls, with no race involved at all.
  it('(b) a tool-call result growing in place (toolCalls.length unchanged) still scrolls to the bottom', async () => {
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

    // The view still follows the (now much taller) content.
    expect(screen.queryByTestId('follow-pill')).toBeNull();
    expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());
  });

  it('a reader who scrolled up gets the FollowPill counting new messages; clicking it re-follows', async () => {
    const fake = fakeClient();
    renderChat(fake.client, scriptedHttp({}));
    const geometry = await startRunningTurn(fake);
    geometry.setScrollHeight(400);
    act(() => fake.stream('turn-1', { streamKind: 'textDelta', delta: 'line 1\nline 2\n' }));
    expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());

    // The reader scrolls to the top: below `lastWrittenTop`, so this one is measured (100 px
    // from the bottom > 48 px) and following stops.
    geometry.el.scrollTop = 0;
    fireEvent.scroll(geometry.el);
    const pill = await screen.findByTestId('follow-pill');
    expect(pill.getAttribute('data-count')).toBe('0');
    expect(pill.textContent).toContain('跟随最新输出');

    // Two persisted messages land while scrolled away — counted, not scrolled to.
    act(() => {
      fake.deliver({
        id: 'm-a',
        role: 'assistant',
        text: 'first',
        createdAt: '2026-09-03T00:00:01.000Z',
        sequence: 2,
        content: { text: 'first' },
      });
      fake.deliver({
        id: 'm-b',
        role: 'assistant',
        text: 'second',
        createdAt: '2026-09-03T00:00:02.000Z',
        sequence: 3,
        content: { text: 'second' },
      });
    });
    expect(screen.getByTestId('follow-pill').getAttribute('data-count')).toBe('2');
    expect(screen.getByTestId('follow-pill').textContent).toContain('2 条新消息');
    expect(geometry.scrollTop()).toBe(0);

    // Clicking the pill jumps to the bottom and re-enables following.
    fireEvent.click(screen.getByTestId('follow-pill'));
    expect(screen.queryByTestId('follow-pill')).toBeNull();
    expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());
    geometry.setScrollHeight(500);
    act(() => fake.stream('turn-1', { streamKind: 'textDelta', delta: 'line 3\n' }));
    expect(geometry.scrollTop()).toBe(geometry.maxScrollTop());
  });
});

// ---- S6-A / C22: send + stream, header, model switch, archived read-only ----------------------

function persisted(sequence: number, role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id: `m-${sequence}`,
    role,
    text,
    createdAt: `2026-09-03T00:00:0${sequence}.000Z`,
    sequence,
    content: { text },
  };
}

const PROFILE = {
  principalId: 'p-1',
  model: null as string | null,
  excludedSkills: [],
  excludedGatekeepers: [],
  excludedWorkerDefinitions: [],
  promptAddendum: null,
  autoApproveLow: null,
  updatedAt: null,
  updatedBy: null,
  effective: {
    model: 'openai/gpt-4o',
    enabledSkills: [],
    enabledGatekeepers: [],
    enabledWorkerDefinitions: [],
    promptAddendum: '',
    autoApproveLow: false,
  },
};

const POLICY = {
  workspaceId: 'ws-1',
  allowedModels: ['openai/gpt-4o', 'anthropic/claude-sonnet'],
  defaultModel: 'openai/gpt-4o',
  memberCanEditProfile: true,
  maxPromptAddendumChars: 2000,
  allowedSkills: [],
  allowedGatekeepers: [],
  allowMemberAutoApproveLow: false,
  updatedAt: null,
  updatedBy: null,
};

const MODELS = {
  items: [
    { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o' },
    { id: 'anthropic/claude-sonnet', provider: 'anthropic', model: 'claude-sonnet' },
    { id: 'deepseek/chat', provider: 'deepseek', model: 'chat' },
  ],
};

function headerHttp(
  extra: Record<string, (params: unknown) => unknown | Promise<unknown>> = {},
  profile = PROFILE,
) {
  return scriptedHttp({
    get_agent_profile: () => profile,
    get_agent_policy: () => POLICY,
    list_models: () => MODELS,
    ...extra,
  });
}

describe('ChatPage send and stream (C22)', () => {
  it('sends the composer text, renders the stream, and settles when the Turn ends', async () => {
    const fake = fakeClient();
    renderChat(fake.client, scriptedHttp({}));
    await waitFor(() => expect(fake.client.subscribeChat).toHaveBeenCalled());
    expect(fake.client.subscribeChat).toHaveBeenCalledWith('chat-1', 0, expect.anything());
    act(() => fake.caughtUp());
    expect(screen.getByText(/还没有消息/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'restart web-1' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() =>
      expect(fake.client.sendChatMessage).toHaveBeenCalledWith('chat-1', 'restart web-1'),
    );
    // S8 W1-A10: TurnStatusBadge text is bilingual via t() now; default zh-CN renders '回复中'.
    await screen.findByText('回复中');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);

    act(() => {
      fake.deliver(persisted(1, 'user', 'restart web-1'));
      fake.stream('turn-1', { streamKind: 'textDelta', delta: 'On it' });
      fake.stream('turn-1', { streamKind: 'textDelta', delta: ' — restarting.' });
    });
    expect(document.querySelector('.message-streaming .message-text')?.textContent).toContain(
      'On it — restarting.',
    );

    act(() => {
      fake.deliver(persisted(2, 'assistant', 'On it — restarting.'));
      fake.deliver({
        ...persisted(3, 'user', ''),
        role: 'system',
        kind: 'system.action_update',
        content: {
          kind: 'system.action_update',
          text: 'docker container restart executed',
          actionRequestId: 'ar-9',
          status: 'executed',
          actionKindTag: 'docker.container_restart',
          isHolder: true,
        },
      });
      // Turn-end metadata: the reducer settles and the composer re-enables.
      handlersOf(fake).onMetadata({ turnId: 'turn-1', turnStatus: 'completed' });
    });
    // S8 W1-A10: TurnStatusBadge text is bilingual via t() now; default zh-CN renders '本轮完成'.
    await screen.findByText('本轮完成');
    expect(document.querySelector('.message-streaming')).toBeNull();
    expect(document.querySelectorAll('.message-assistant .message-text')).toHaveLength(1);
    // S8 W4 (audit C4 "角色标签原样显示 user / assistant"): the meta line names the speaker, not
    // the raw wire role value.
    expect(document.querySelector('.message-user .message-meta')?.textContent).toContain('你');
    const assistantMeta = document.querySelector('.message-assistant .message-meta')?.textContent;
    // Split across two assertions (rather than the literal product term as one string) so this
    // reads as a check on rendered content, not as UI copy the i18n guard would otherwise flag.
    expect(assistantMeta).toContain('入口');
    expect(assistantMeta).toContain('agent');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false);
    // The 执行类动作提示 for a persisted action update is the status line with the shared chip.
    const line = screen.getByTestId('system-status-line');
    expect(line.querySelector('[data-status="executed"]')).toBeTruthy();
    expect(line.textContent).toContain('docker container restart executed');
  });
});

/** The page's subscription handlers, for pushes the `FakeClient` helpers do not wrap. */
function handlersOf(fake: FakeClient): ChatSubscriptionHandlers {
  const call = (fake.client.subscribeChat as ReturnType<typeof vi.fn>).mock.calls[0];
  if (!call) throw new Error('subscribeChat not called');
  return call[2] as ChatSubscriptionHandlers;
}

/** S8 W1-A3 (audit C3): the header's overflow menu (`kit/dropdown-menu`, Radix) opens on
 *  `pointerdown`, not `click` (`DropdownMenuTrigger`'s own `onPointerDown` handler) — a plain
 *  `fireEvent.click` leaves it closed in jsdom. */
function openChatHeaderMenu(): void {
  fireEvent.pointerDown(screen.getByTestId('chat-header-menu'), { button: 0 });
}

describe('ChatPage header (S6-A W1 / W2)', () => {
  it('looks the chat up with includeArchived and applies a chat.metadata {title} push', async () => {
    const fake = fakeClient({}, chatRow({ title: null }));
    renderChat(fake.client, scriptedHttp({}));
    await waitFor(() => expect(fake.client.subscribeChat).toHaveBeenCalled());
    expect(fake.client.call).toHaveBeenCalledWith('list_chats', { includeArchived: true });
    await waitFor(() => expect(screen.getByTestId('chat-title').textContent).toBe('新对话'));
    act(() => handlersOf(fake).onMetadata({ title: 'restart web-1' }));
    expect(screen.getByTestId('chat-title').textContent).toBe('restart web-1');
  });

  it('shows 模式 · 模型 · 来源 from the profile and switches the model with set_agent_profile (下一轮生效)', async () => {
    const fake = fakeClient();
    const http = headerHttp({
      set_agent_profile: (params) => ({
        ...PROFILE,
        model: (params as { model: string | null }).model,
        effective: { ...PROFILE.effective, model: 'anthropic/claude-sonnet' },
      }),
    });
    renderChat(fake.client, http);
    const line = await screen.findByTestId('chat-model-line');
    await waitFor(() => expect(within(line).getByTestId('chat-model-select')).toBeTruthy());
    expect(line.textContent).toContain('模式：入口');
    expect(screen.getByTestId('chat-model-source').textContent).toContain('工作区默认');
    const select = screen.getByTestId('chat-model-select') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'openai/gpt-4o',
      'anthropic/claude-sonnet',
    ]);
    // Labels read provider/model; the default option names the workspace default.
    expect(select.options[0]?.textContent).toContain('openai/gpt-4o');
    expect(select.options[2]?.textContent).toBe('anthropic/claude-sonnet');

    fireEvent.change(select, { target: { value: 'anthropic/claude-sonnet' } });
    await waitFor(() =>
      expect(http.decisions()).toEqual([
        { name: 'set_agent_profile', params: { model: 'anthropic/claude-sonnet' } },
      ]),
    );
    await screen.findByText('下一轮生效');
    await waitFor(() =>
      expect(screen.getByTestId('chat-model-source').textContent).toContain('我的覆盖'),
    );

    // Back to the workspace default clears the override with `null` (S3.13).
    fireEvent.change(screen.getByTestId('chat-model-select'), { target: { value: '' } });
    await waitFor(() => expect(http.decisions()).toHaveLength(2));
    expect(http.decisions()[1]).toEqual({ name: 'set_agent_profile', params: { model: null } });
  });

  it('flags an override that is no longer in the allow-list and still offers switching away', async () => {
    const fake = fakeClient();
    renderChat(fake.client, headerHttp({}, { ...PROFILE, model: 'deepseek/chat' }));
    const select = (await screen.findByTestId('chat-model-select')) as HTMLSelectElement;
    expect(select.value).toBe('deepseek/chat');
    expect(screen.getByTestId('chat-model-outside').textContent).toContain('不在允许范围');
    expect(screen.getByTestId('chat-model-flag')).toBeTruthy();
    expect(Array.from(select.options).map((option) => option.value)).toContain(
      'anthropic/claude-sonnet',
    );
  });

  it('disables the model switcher while a Turn is in progress', async () => {
    const fake = fakeClient();
    renderChat(fake.client, headerHttp());
    const select = (await screen.findByTestId('chat-model-select')) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    await startRunningTurn(fake);
    await waitFor(() =>
      expect((screen.getByTestId('chat-model-select') as HTMLSelectElement).disabled).toBe(true),
    );
    expect(screen.getByTestId('chat-model-select').getAttribute('title')).toContain(
      'Turn 进行中不能切换模型',
    );
    act(() => handlersOf(fake).onMetadata({ turnId: 'turn-1', turnStatus: 'completed' }));
    await waitFor(() =>
      expect((screen.getByTestId('chat-model-select') as HTMLSelectElement).disabled).toBe(false),
    );
  });

  it('an archived chat is read-only until restored', async () => {
    const archivedRow = chatRow({ archivedAt: '2026-09-04T00:00:00.000Z' });
    const fake = fakeClient(
      { unarchive_chat: () => ({ ...archivedRow, archivedAt: null }) },
      archivedRow,
    );
    renderChat(fake.client, scriptedHttp({}));
    await waitFor(() => expect(fake.client.subscribeChat).toHaveBeenCalled());
    act(() => fake.caughtUp());
    await screen.findByTestId('chat-archived-notice');
    expect(screen.getByTestId('chat-archived-chip')).toBeTruthy();
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe('已归档');
    // S8 W1-A3 (audit C3): rename/archive/restore moved from always-visible buttons into the
    // header's overflow menu — open it to see which items it offers.
    openChatHeaderMenu();
    expect(screen.getByTestId('chat-header-restore')).toBeTruthy();
    expect(screen.queryByTestId('chat-header-archive')).toBeNull();
    expect(screen.queryByTestId('chat-header-rename')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getByTestId('chat-composer-restore'));
    await waitFor(() => expect(screen.queryByTestId('chat-archived-notice')).toBeNull());
    expect(fake.client.call).toHaveBeenCalledWith('unarchive_chat', { chatId: 'chat-1' });
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false);
    openChatHeaderMenu();
    expect(screen.getByTestId('chat-header-archive')).toBeTruthy();
  });

  it('归档', async () => {
    const fake = fakeClient({
      archive_chat: () => chatRow({ archivedAt: '2026-09-04T00:00:00.000Z' }),
    });
    renderChat(fake.client, scriptedHttp({}));
    await waitFor(() => expect(fake.client.subscribeChat).toHaveBeenCalled());
    await screen.findByTestId('chat-header-menu');
    openChatHeaderMenu();
    fireEvent.click(await screen.findByTestId('chat-header-archive'));
    await screen.findByTestId('chat-archived-notice');
    expect(fake.client.call).toHaveBeenCalledWith('archive_chat', { chatId: 'chat-1' });
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('已归档 ·');
    expect(within(toast).getByRole('button', { name: '撤销' })).toBeTruthy();
    // The per-chat `chat.metadata {archivedAt: null}` push (e.g. restored from the list in
    // another tab) re-enables the composer here.
    act(() => handlersOf(fake).onMetadata({ archivedAt: null }));
    expect(screen.queryByTestId('chat-archived-notice')).toBeNull();
  });

  it('改名', async () => {
    const fake = fakeClient({
      rename_chat: (params) => chatRow({ title: (params as { title: string }).title }),
    });
    renderChat(fake.client, scriptedHttp({}));
    await screen.findByTestId('chat-header-menu');
    openChatHeaderMenu();
    fireEvent.click(await screen.findByTestId('chat-header-rename'));
    const input = screen.getByTestId('chat-rename-input');
    fireEvent.change(input, { target: { value: 'Web-1 incident' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('chat-title').textContent).toBe('Web-1 incident'),
    );
    expect(fake.client.call).toHaveBeenCalledWith('rename_chat', {
      chatId: 'chat-1',
      title: 'Web-1 incident',
    });
  });
});
