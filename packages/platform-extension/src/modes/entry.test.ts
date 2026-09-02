import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelClient } from '../kernel-client.js';
import { type FakeKernel, startFakeKernel } from '../test-support/fake-kernel.js';
import { registerEntryMode } from './entry.js';

/**
 * Contract tests against a minimal `ExtensionAPI` stub (task brief: "a direct invocation of the
 * extension against a minimal ExtensionAPI stub if driving a real pi session is impractical").
 * The stub captures every `pi.on(...)`/`pi.registerTool(...)` call so handlers can be invoked
 * directly with synthetic events — this exercises registerEntryMode's own logic (tool building,
 * turn-id correlation, context rendering, error handling) without needing a real Agent loop.
 * `entry.sdk.test.ts` covers the one thing this style of test cannot: pi's real isError wiring.
 */

// biome-ignore lint/suspicious/noExplicitAny: event/handler shapes vary per pi.on() overload.
type Handler = (...args: any[]) => any;

interface FakePi {
  api: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  handlers: Map<string, Handler>;
  appendEntryCalls: Array<{ customType: string; data: unknown }>;
}

function createFakePi(): FakePi {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler>();
  const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];

  const api = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appendEntryCalls.push({ customType, data });
      return 'fake-entry-id';
    }),
  } as unknown as ExtensionAPI;

  return { api, tools, handlers, appendEntryCalls };
}

function fakeCtx(hasUI = false): ExtensionContext {
  return { hasUI, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
}

describe('registerEntryMode', () => {
  let kernel: FakeKernel;
  let fake: FakePi;
  let kernelClient: KernelClient;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    fake = createFakePi();
    kernelClient = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' });
    registerEntryMode(fake.api, { kernelClient, workspaceId: 'ws-1' });
  });

  afterEach(async () => {
    await kernel.close();
  });

  it('registers exactly the five S1 observe tools, derived from the shared registry', () => {
    expect([...fake.tools.keys()]).toEqual([
      'get_object',
      'traverse',
      'search',
      'explain',
      'get_task',
    ]);
    const getObject = fake.tools.get('get_object');
    expect(getObject?.description).toContain('Object');
    expect(getObject?.parameters).toMatchObject({ type: 'object' });
  });

  it('a tool execute() calls the kernel and returns the result as content/details on success', async () => {
    kernel.setHandler('get_object', () => ({
      ok: true,
      result: { objectId: 'obj-1', kind: 'Host' },
    }));
    const tool = fake.tools.get('get_object');
    if (!tool) throw new Error('get_object tool not registered');

    const result = await tool.execute(
      'call-1',
      { objectId: 'obj-1' },
      undefined,
      undefined,
      fakeCtx(),
    );

    expect(result.details).toEqual({ objectId: 'obj-1', kind: 'Host' });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ objectId: 'obj-1', kind: 'Host' }, null, 2) },
    ]);
    expect(kernel.requests[0]?.params).toEqual({ objectId: 'obj-1' });
  });

  it('a tool execute() rejects (does not swallow) when the kernel returns {ok:false}', async () => {
    kernel.setHandler('get_object', () => ({
      ok: false,
      error: { code: 'not_found', message: 'no such object' },
    }));
    const tool = fake.tools.get('get_object');
    if (!tool) throw new Error('get_object tool not registered');

    await expect(
      tool.execute('call-1', { objectId: 'missing' }, undefined, undefined, fakeCtx()),
    ).rejects.toThrow('no such object');
  });

  it('the input handler strips a turn_id marker and transforms the text', () => {
    const inputHandler = fake.handlers.get('input');
    if (!inputHandler) throw new Error('input handler not registered');

    const result = inputHandler(
      { text: '<!--nexttime:turn_id=turn-42-->\nWhat is X?', source: 'rpc' },
      fakeCtx(),
    );

    expect(result).toEqual({ action: 'transform', text: 'What is X?' });
  });

  it('the input handler leaves unmarked text untouched', () => {
    const inputHandler = fake.handlers.get('input');
    if (!inputHandler) throw new Error('input handler not registered');

    const result = inputHandler({ text: 'plain text, no marker', source: 'rpc' }, fakeCtx());

    expect(result).toBeUndefined();
  });

  it('agent_start appends a nexttime_turn session entry carrying the current turn id', () => {
    const inputHandler = fake.handlers.get('input');
    const agentStartHandler = fake.handlers.get('agent_start');
    if (!inputHandler || !agentStartHandler) throw new Error('handlers not registered');

    inputHandler({ text: '<!--nexttime:turn_id=turn-7-->\nHi', source: 'rpc' }, fakeCtx());
    agentStartHandler({}, fakeCtx());

    expect(fake.appendEntryCalls).toEqual([
      { customType: 'nexttime_turn', data: { turnId: 'turn-7', workspaceId: 'ws-1' } },
    ]);
  });

  it('agent_settled POSTs report_turn with the turn id and the last assistant text as summary', async () => {
    kernel.setHandler('report_turn', () => ({ ok: true, result: {} }));
    const inputHandler = fake.handlers.get('input');
    const agentEndHandler = fake.handlers.get('agent_end');
    const agentSettledHandler = fake.handlers.get('agent_settled');
    if (!inputHandler || !agentEndHandler || !agentSettledHandler)
      throw new Error('handlers not registered');

    inputHandler(
      { text: '<!--nexttime:turn_id=turn-9-->\nSummarize this', source: 'rpc' },
      fakeCtx(),
    );
    agentEndHandler(
      {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Here is the summary.' }] },
        ],
      },
      fakeCtx(),
    );
    await agentSettledHandler({}, fakeCtx());

    const reportCall = kernel.requests.find((request) => request.capability === 'report_turn');
    expect(reportCall?.params).toEqual({ turnId: 'turn-9', summary: 'Here is the summary.' });
  });

  it('agent_end can fire more than once per Turn; agent_settled reports only the latest summary, once', async () => {
    kernel.setHandler('report_turn', () => ({ ok: true, result: {} }));
    const inputHandler = fake.handlers.get('input');
    const agentEndHandler = fake.handlers.get('agent_end');
    const agentSettledHandler = fake.handlers.get('agent_settled');
    if (!inputHandler || !agentEndHandler || !agentSettledHandler)
      throw new Error('handlers not registered');

    inputHandler({ text: '<!--nexttime:turn_id=turn-retry-->\nHi', source: 'rpc' }, fakeCtx());
    agentEndHandler(
      { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'first attempt' }] }] },
      fakeCtx(),
    );
    agentEndHandler(
      { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final attempt' }] }] },
      fakeCtx(),
    );
    await agentSettledHandler({}, fakeCtx());

    const reportCalls = kernel.requests.filter((request) => request.capability === 'report_turn');
    expect(reportCalls).toHaveLength(1);
    expect(reportCalls[0]?.params).toEqual({ turnId: 'turn-retry', summary: 'final attempt' });
  });

  it('agent_settled with no known turn id skips report_turn instead of throwing', async () => {
    const agentSettledHandler = fake.handlers.get('agent_settled');
    if (!agentSettledHandler) throw new Error('agent_settled handler not registered');

    await expect(agentSettledHandler({}, fakeCtx())).resolves.toBeUndefined();
    expect(kernel.requests.filter((request) => request.capability === 'report_turn')).toHaveLength(
      0,
    );
  });

  it('the context handler injects a non-persisted custom message built from get_entry_context', async () => {
    kernel.setHandler('get_entry_context', () => ({
      ok: true,
      result: {
        pendingApprovals: [{ actionRequestId: 'ar-1', title: 'Restart container' }],
        tasks: [{ taskId: 't-1', status: 'running' }],
        facts: [],
        precedents: [],
      },
    }));
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');

    const result = await contextHandler({ messages: [] }, fakeCtx());

    expect(result.messages).toHaveLength(1);
    const [message] = result.messages;
    expect(message.role).toBe('custom');
    expect(message.customType).toBe('nexttime-entry-context');
    expect(message.display).toBe(false);
    expect(message.content).toContain('Pending approvals');
    expect(message.content).toContain('Restart container');
    expect(message.content).toContain('Running tasks');
  });

  it('the context handler degrades to unchanged messages when the kernel call fails', async () => {
    // No handler registered for get_entry_context -> fake kernel returns a 404 capability_error.
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await contextHandler({ messages: [] }, fakeCtx());

    expect(result).toBeUndefined();
    errorSpy.mockRestore();
  });

  it('the context handler omits the message when get_entry_context has nothing to report', async () => {
    kernel.setHandler('get_entry_context', () => ({
      ok: true,
      result: { pendingApprovals: [], tasks: [], facts: [], precedents: [] },
    }));
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');

    const result = await contextHandler({ messages: [] }, fakeCtx());

    expect(result).toBeUndefined();
  });
});
