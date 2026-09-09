import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelClient } from '../kernel-client.js';
import { type FakeKernel, startFakeKernel } from '../test-support/fake-kernel.js';
import { registerInteractiveMode } from './interactive.js';

/**
 * Contract tests against a minimal `ExtensionAPI` stub — same style `modes/entry.test.ts`
 * established, adapted for `interactive` mode's own contract: same tool set as entry, but no
 * turn-id correlation and no `report_turn`/`agent_start`/`agent_settled` wiring (§7.4 "默认不回传").
 * `interactive.sdk.test.ts` covers the one thing this style of test cannot: pi's real isError
 * wiring, loading the real extension module through the SDK.
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

describe('registerInteractiveMode', () => {
  let kernel: FakeKernel;
  let fake: FakePi;
  let kernelClient: KernelClient;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    fake = createFakePi();
    kernelClient = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' });
    registerInteractiveMode(fake.api, { kernelClient });
  });

  afterEach(async () => {
    await kernel.close();
  });

  it('registers the same 17 capability tools as entry mode, from the shared registry', () => {
    expect([...fake.tools.keys()]).toEqual([
      'get_object',
      'traverse',
      'search',
      'explain',
      'get_task',
      'state_at',
      'find_operations',
      'find_workers',
      'find_procedures',
      'invoke_worker',
      'request_connection',
      'record_decision',
      'propose_worker_definition',
      'propose_operation',
      'propose_skill',
      'propose_procedure',
      'propose_ontology_change',
    ]);
    const getObject = fake.tools.get('get_object');
    expect(getObject?.description).toContain('Object');
    expect(getObject?.parameters).toMatchObject({ type: 'object' });
    // Never exposed raw: the extension calls these itself, and observe_operation is reached only
    // through the projected <gate>.<op> tools (session_start test below).
    expect(fake.tools.has('get_entry_context')).toBe(false);
    expect(fake.tools.has('report_turn')).toBe(false);
    expect(fake.tools.has('observe_operation')).toBe(false);
    expect(fake.tools.has('request_action')).toBe(false);
  });

  it('subscribes only to session_start and context — no input/agent_start/agent_end/agent_settled (no Turn to correlate)', () => {
    expect([...fake.handlers.keys()].sort()).toEqual(['context', 'session_start']);
  });

  it('session_start projects only observe-class allowed Operations as <gate>.<op> tools that call observe_operation', async () => {
    kernel.setHandler('list_allowed_operations', () => ({
      ok: true,
      result: {
        items: [
          {
            gatekeeperId: 'gk-1',
            gateName: 'accept_s2_api',
            name: 'stock.get',
            operation: { mode: 'observe', params_schema: { type: 'object', properties: {} } },
          },
          {
            gatekeeperId: 'gk-2',
            gateName: 'docker',
            name: 'container.restart',
            operation: { mode: 'execute', params_schema: { type: 'object' } },
          },
        ],
      },
    }));
    kernel.setHandler('observe_operation', (request) => ({
      ok: true,
      result: { status: 'ok', data: { echo: request.params }, observedFactCount: 0 },
    }));
    const sessionStart = fake.handlers.get('session_start');
    if (!sessionStart) throw new Error('session_start handler not registered');

    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx());

    expect(fake.tools.has('accept_s2_api_stock_get')).toBe(true);
    expect(fake.tools.has('docker_container_restart')).toBe(false);
    const tool = fake.tools.get('accept_s2_api_stock_get');
    if (!tool) throw new Error('projected observe tool missing');
    expect(tool.label).toBe('accept_s2_api.stock.get');

    const result = await tool.execute('call-1', { symbol: 'X' }, undefined, undefined, fakeCtx());
    const observeCall = kernel.requests.find((r) => r.capability === 'observe_operation');
    expect(observeCall?.params).toEqual({
      gatekeeperId: 'gk-1',
      operation: 'stock.get',
      params: { symbol: 'X' },
    });
    expect(kernel.requests.some((r) => r.capability === 'request_action')).toBe(false);
    expect(result.details).toMatchObject({ status: 'ok' });
  });

  it('session_start degrades to zero gate tools when list_allowed_operations fails', async () => {
    kernel.setHandler('list_allowed_operations', () => ({
      ok: false,
      error: { code: 'forbidden', message: 'nope' },
    }));
    const before = fake.tools.size;
    const sessionStart = fake.handlers.get('session_start');
    if (!sessionStart) throw new Error('session_start handler not registered');
    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx());
    expect(fake.tools.size).toBe(before);
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

  it('invoke_worker defaults wait to false when the caller omits it', async () => {
    kernel.setHandler('invoke_worker', () => ({
      ok: true,
      result: { taskId: 'task-1', workerRunId: 'run-1' },
    }));
    const tool = fake.tools.get('invoke_worker');
    if (!tool) throw new Error('invoke_worker tool not registered');

    await tool.execute(
      'call-1',
      { definitionId: 'def-1', version: 1, input: {} },
      undefined,
      undefined,
      fakeCtx(),
    );

    const invokeCall = kernel.requests.find((r) => r.capability === 'invoke_worker');
    expect(invokeCall?.params).toMatchObject({ wait: false });
  });

  it('invoke_worker honours an explicit wait:true, with a per-call timeout computed to outlast the kernel wait', async () => {
    kernel.setHandler('invoke_worker', () => ({
      ok: true,
      result: { taskId: 'task-1', workerRunId: 'run-1', status: 'completed' },
    }));
    const tool = fake.tools.get('invoke_worker');
    if (!tool) throw new Error('invoke_worker tool not registered');
    const callSpy = vi.spyOn(kernelClient, 'call');

    await tool.execute(
      'call-1',
      { definitionId: 'def-1', version: 1, input: {}, wait: true, timeout: 45 },
      undefined,
      undefined,
      fakeCtx(),
    );

    expect(callSpy).toHaveBeenCalledWith('invoke_worker', expect.anything(), undefined, 55_000);
  });

  it('context injects get_entry_context as a non-persisted custom message', async () => {
    kernel.setHandler('get_entry_context', () => ({
      ok: true,
      result: {
        pendingApprovals: [{ actionRequestId: 'ar-1', title: 'Restart the flaky container' }],
        tasks: [],
        facts: [],
        precedents: [],
      },
    }));
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');

    const baseMessages = [{ role: 'user', content: 'hi' }];
    const outcome = await contextHandler({ messages: baseMessages }, fakeCtx());

    expect(outcome?.messages).toHaveLength(2);
    const injected = outcome?.messages[1];
    expect(injected).toMatchObject({ role: 'custom', display: false });
    expect(injected.content).toContain('Restart the flaky container');
  });

  it('context degrades to no injected message when the kernel call fails', async () => {
    kernel.setHandler('get_entry_context', () => ({
      ok: false,
      error: { code: 'internal_error', message: 'boom' },
    }));
    const contextHandler = fake.handlers.get('context');
    if (!contextHandler) throw new Error('context handler not registered');

    const outcome = await contextHandler({ messages: [] }, fakeCtx());
    expect(outcome).toBeUndefined();
  });

  it('never calls pi.appendEntry — no Turn/session-entry correlation for an interactive session', async () => {
    kernel.setHandler('get_entry_context', () => ({ ok: true, result: {} }));
    const contextHandler = fake.handlers.get('context');
    await contextHandler?.({ messages: [] }, fakeCtx());
    expect(fake.appendEntryCalls).toEqual([]);
  });
});
