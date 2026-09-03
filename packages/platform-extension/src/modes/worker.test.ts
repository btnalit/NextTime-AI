import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelClient } from '../kernel-client.js';
import { type FakeKernel, startFakeKernel } from '../test-support/fake-kernel.js';
import { registerWorkerMode } from './worker.js';

/**
 * Contract tests against a minimal `ExtensionAPI` stub (same style `modes/entry.test.ts`
 * established — see that file's own doc comment for the rationale). Exercises
 * `registerWorkerMode`'s own logic (gate-tool building/naming, self-driving the turn, context
 * rendering, the result-contract post + process exit) without a real Agent loop.
 */

// biome-ignore lint/suspicious/noExplicitAny: event/handler shapes vary per pi.on() overload.
type Handler = (...args: any[]) => any;

interface FakePi {
  api: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  handlers: Map<string, Handler>;
  sendUserMessageCalls: unknown[];
}

function createFakePi(): FakePi {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler>();
  const sendUserMessageCalls: unknown[] = [];

  const api = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    }),
    sendUserMessage: vi.fn((content: unknown) => {
      sendUserMessageCalls.push(content);
    }),
  } as unknown as ExtensionAPI;

  return { api, tools, handlers, sendUserMessageCalls };
}

function fakeCtx(
  sessionFile: string | undefined = '/workspace/.pi/sessions/s1.jsonl',
): ExtensionContext {
  return {
    hasUI: false,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionFile: () => sessionFile },
  } as unknown as ExtensionContext;
}

/** Flushes the `setImmediate` `agent_settled` schedules its `process.exit(0)` call through. */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('registerWorkerMode', () => {
  let kernel: FakeKernel;
  let fake: FakePi;
  let kernelClient: KernelClient;
  // biome-ignore lint/suspicious/noExplicitAny: spying on process.exit's overloaded signature.
  let exitSpy: any;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    fake = createFakePi();
    kernelClient = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    registerWorkerMode(fake.api, { kernelClient, workspaceId: 'ws-1', taskId: 'task-1' });
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    await kernel.close();
  });

  it('registers report_result synchronously, before session_start ever runs', () => {
    expect([...fake.tools.keys()]).toEqual(['report_result']);
    const tool = fake.tools.get('report_result');
    expect(tool?.parameters).toMatchObject({ type: 'object' });
  });

  it('session_start registers one gate tool per Operation named <gate>.<op> (sanitized, no dots) and sends the kickoff message', async () => {
    kernel.setHandler('list_allowed_operations', () => ({
      ok: true,
      result: {
        operations: [
          {
            gatekeeperId: 'gk-1',
            gateName: 'docker',
            name: 'container.restart',
            operation: { params_schema: { type: 'object', properties: {} }, mode: 'execute' },
          },
        ],
      },
    }));
    const sessionStart = fake.handlers.get('session_start');
    if (!sessionStart) throw new Error('session_start handler not registered');

    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx());

    expect([...fake.tools.keys()]).toEqual(['report_result', 'docker_container_restart']);
    const gateTool = fake.tools.get('docker_container_restart');
    expect(gateTool?.label).toBe('docker.container.restart');
    expect(fake.sendUserMessageCalls).toHaveLength(1);
  });

  it('session_start degrades to zero gate tools (but still sends the kickoff) when list_allowed_operations fails', async () => {
    // no handler registered for list_allowed_operations -> fake kernel 404s.
    const sessionStart = fake.handlers.get('session_start');
    if (!sessionStart) throw new Error('session_start handler not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx());

    expect([...fake.tools.keys()]).toEqual(['report_result']);
    expect(fake.sendUserMessageCalls).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('a gate tool execute() calls request_action with {gatekeeperId, operation, params}', async () => {
    kernel.setHandler('list_allowed_operations', () => ({
      ok: true,
      result: {
        operations: [
          {
            gatekeeperId: 'gk-1',
            gateName: 'inventory',
            name: 'stock.get',
            operation: { params_schema: { type: 'object' }, mode: 'observe' },
          },
        ],
      },
    }));
    kernel.setHandler('request_action', () => ({
      ok: true,
      result: { status: 'ok', data: { quantity: 3 } },
    }));
    const sessionStart = fake.handlers.get('session_start');
    if (!sessionStart) throw new Error('session_start handler not registered');
    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx());

    const tool = fake.tools.get('inventory_stock_get');
    if (!tool) throw new Error('gate tool not registered');
    const result = await tool.execute('call-1', { sku: 'X' }, undefined, undefined, fakeCtx());

    const requestActionCall = kernel.requests.find((r) => r.capability === 'request_action');
    expect(requestActionCall?.params).toEqual({
      gatekeeperId: 'gk-1',
      operation: 'stock.get',
      params: { sku: 'X' },
    });
    expect(result.details).toEqual({ status: 'ok', data: { quantity: 3 } });
  });

  it('a gate tool returns (does not throw) the simulate text and actionRequestId on pending_approval — the loop is not blocked', async () => {
    kernel.setHandler('list_allowed_operations', () => ({
      ok: true,
      result: {
        operations: [
          {
            gatekeeperId: 'gk-1',
            gateName: 'docker',
            name: 'restart',
            operation: { params_schema: {}, mode: 'execute' },
          },
        ],
      },
    }));
    kernel.setHandler('request_action', () => ({
      ok: true,
      result: {
        status: 'pending_approval',
        actionRequestId: 'ar-1',
        simulate: { willRestart: ['container-a'] },
      },
    }));
    const sessionStart = fake.handlers.get('session_start');
    if (!sessionStart) throw new Error('session_start handler not registered');
    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx());

    const tool = fake.tools.get('docker_restart');
    if (!tool) throw new Error('gate tool not registered');
    const result = await tool.execute('call-1', {}, undefined, undefined, fakeCtx());

    const [firstPart] = result.content;
    const text = firstPart?.type === 'text' ? firstPart.text : '';
    expect(text).toContain('willRestart');
    expect(text).toContain('pending approval, actionRequestId ar-1');
  });

  it('report_result validates the contract with Zod, rejects (throws) on an invalid shape', async () => {
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');

    await expect(
      tool.execute('call-1', { summary: 123 }, undefined, undefined, fakeCtx()),
    ).rejects.toThrow(/invalid contract/);
  });

  it('report_result accepts a valid contract and returns terminate:true', async () => {
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');

    const result = await tool.execute(
      'call-1',
      { summary: 'done', findings: ['ok'] },
      undefined,
      undefined,
      fakeCtx(),
    );

    expect(result.terminate).toBe(true);
  });

  it('the context handler injects Task input (get_task) and related facts (search) as a non-persisted custom message', async () => {
    kernel.setHandler('get_task', () => ({ ok: true, result: { input: 'restart the flaky pod' } }));
    kernel.setHandler('search', () => ({ ok: true, result: { objects: [{ id: 'obj-1' }] } }));
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');

    const result = await contextHandler({ messages: [] }, fakeCtx());

    expect(result.messages).toHaveLength(1);
    const [message] = result.messages;
    expect(message.role).toBe('custom');
    expect(message.customType).toBe('nexttime-worker-context');
    expect(message.display).toBe(false);
    expect(message.content).toContain('restart the flaky pod');
    expect(message.content).toContain('Relevant facts');
    expect(message.content).toContain('No Skills are loaded yet');

    const getTaskCall = kernel.requests.find((r) => r.capability === 'get_task');
    expect(getTaskCall?.params).toEqual({ taskId: 'task-1' });
  });

  it('the context handler caches Task input across calls (one get_task round trip)', async () => {
    kernel.setHandler('get_task', () => ({ ok: true, result: { input: 'x' } }));
    kernel.setHandler('search', () => ({ ok: true, result: { objects: [] } }));
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');

    await contextHandler({ messages: [] }, fakeCtx());
    await contextHandler({ messages: [] }, fakeCtx());

    expect(kernel.requests.filter((r) => r.capability === 'get_task')).toHaveLength(1);
  });

  it('the context handler degrades to unchanged messages (and does not cache) when get_task fails', async () => {
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await contextHandler({ messages: [] }, fakeCtx());

    expect(result).toBeUndefined();
    errorSpy.mockRestore();
  });

  it('agent_settled posts the report_result-recorded contract (with sessionJsonlPath) and exits 0', async () => {
    kernel.setHandler('report_task_result', () => ({ ok: true, result: { status: 'completed' } }));
    const reportResultTool = fake.tools.get('report_result');
    if (!reportResultTool) throw new Error('report_result tool not registered');
    await reportResultTool.execute(
      'call-1',
      { summary: 'pong', findings: [] },
      undefined,
      undefined,
      fakeCtx(),
    );

    const agentSettled = fake.handlers.get('agent_settled');
    if (!agentSettled) throw new Error('agent_settled handler not registered');
    await agentSettled({}, fakeCtx('/workspace/.pi/sessions/abc.jsonl'));
    await flushImmediate();

    const reportCall = kernel.requests.find((r) => r.capability === 'report_task_result');
    expect(reportCall?.params).toMatchObject({
      summary: 'pong',
      sessionJsonlPath: '/workspace/.pi/sessions/abc.jsonl',
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('agent_settled synthesizes a fallback contract from the final assistant text when report_result was never called', async () => {
    kernel.setHandler('report_task_result', () => ({ ok: true, result: { status: 'completed' } }));
    const agentEnd = fake.handlers.get('agent_end');
    const agentSettled = fake.handlers.get('agent_settled');
    if (!agentEnd || !agentSettled) throw new Error('handlers not registered');

    agentEnd({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Nothing to report.' }] }],
    });
    await agentSettled({}, fakeCtx());
    await flushImmediate();

    const reportCall = kernel.requests.find((r) => r.capability === 'report_task_result');
    expect(reportCall?.params).toMatchObject({
      summary: 'Nothing to report.',
      findings: [],
      factsToAssert: [],
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('agent_settled still exits 0 even when report_task_result itself fails', async () => {
    // no handler registered -> fake kernel 404s.
    const agentSettled = fake.handlers.get('agent_settled');
    if (!agentSettled) throw new Error('agent_settled handler not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await agentSettled({}, fakeCtx());
    await flushImmediate();

    expect(exitSpy).toHaveBeenCalledWith(0);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('agent_settled only posts/exits once even if it somehow fires twice', async () => {
    kernel.setHandler('report_task_result', () => ({ ok: true, result: { status: 'completed' } }));
    const agentSettled = fake.handlers.get('agent_settled');
    if (!agentSettled) throw new Error('agent_settled handler not registered');

    await agentSettled({}, fakeCtx());
    await flushImmediate();
    await agentSettled({}, fakeCtx());
    await flushImmediate();

    expect(kernel.requests.filter((r) => r.capability === 'report_task_result')).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
