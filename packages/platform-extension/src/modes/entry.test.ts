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
  /** pi's live active tool names, in order (`getActiveTools()`). */
  active: string[];
}

/** pi built-ins as the entry runtime configures them (`deploy/worker-runtime/entrypoint.sh`
 *  `defaultTools`): all registered, all but `powershell` active. */
const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
const ACTIVE_BUILTINS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/**
 * Models the pi 0.87.1 tool-registry semantics the projection relies on
 * (`dist/core/agent-session.js` `_refreshToolRegistry` / `setActiveToolsByName`,
 * `dist/core/extensions/loader.js` `registerTool`): registering a name new to the registry activates
 * it, re-registering an existing name replaces its definition and keeps its active state,
 * `setActiveTools` replaces the whole active set and ignores unknown names, there is no unregister.
 */
function createFakePi(): FakePi {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler>();
  const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
  const active: string[] = [...ACTIVE_BUILTINS];
  const isRegistered = (name: string) => BUILTIN_TOOLS.includes(name) || tools.has(name);

  const api = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => {
      const isNew = !isRegistered(tool.name);
      tools.set(tool.name, tool);
      if (isNew) active.push(tool.name);
    }),
    getActiveTools: vi.fn(() => [...active]),
    getAllTools: vi.fn(() => [
      ...BUILTIN_TOOLS.map((name) => ({ name, description: name, parameters: {} })),
      ...[...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    ]),
    setActiveTools: vi.fn((names: string[]) => {
      active.splice(0, active.length, ...[...new Set(names)].filter(isRegistered));
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appendEntryCalls.push({ customType, data });
      return 'fake-entry-id';
    }),
  } as unknown as ExtensionAPI;

  return { api, tools, handlers, appendEntryCalls, active };
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

  it('registers the five S1 observe tools first, then the S2 entry capabilities, all from the shared registry', () => {
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

  it('invoke_worker defaults wait to false when the caller omits it (lane-6 review P2-4, still true after the fix)', async () => {
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

  it('invoke_worker forces wait:false when the caller explicitly asks for wait:false', async () => {
    kernel.setHandler('invoke_worker', () => ({
      ok: true,
      result: { taskId: 'task-1', workerRunId: 'run-1' },
    }));
    const tool = fake.tools.get('invoke_worker');
    if (!tool) throw new Error('invoke_worker tool not registered');

    await tool.execute(
      'call-1',
      { definitionId: 'def-1', version: 1, input: {}, wait: false },
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

    const invokeCall = kernel.requests.find((r) => r.capability === 'invoke_worker');
    expect(invokeCall?.params).toEqual({
      definitionId: 'def-1',
      version: 1,
      input: {},
      wait: true,
      timeout: 45,
    });
    // 45s (unclamped, below the 90s max) + the 10s headroom.
    expect(callSpy).toHaveBeenCalledWith('invoke_worker', expect.anything(), undefined, 55_000);
  });

  it('invoke_worker wait:true with no explicit timeout is treated as the max (90s) for the computed client timeout', async () => {
    kernel.setHandler('invoke_worker', () => ({
      ok: true,
      result: { taskId: 'task-1', workerRunId: 'run-1', status: 'running' },
    }));
    const tool = fake.tools.get('invoke_worker');
    if (!tool) throw new Error('invoke_worker tool not registered');
    const callSpy = vi.spyOn(kernelClient, 'call');

    await tool.execute(
      'call-1',
      { definitionId: 'def-1', version: 1, input: {}, wait: true },
      undefined,
      undefined,
      fakeCtx(),
    );

    expect(callSpy).toHaveBeenCalledWith('invoke_worker', expect.anything(), undefined, 100_000);
  });

  it('invoke_worker wait:true clamps a caller timeout above the max down to 90s for the computed client timeout', async () => {
    kernel.setHandler('invoke_worker', () => ({
      ok: true,
      result: { taskId: 'task-1', workerRunId: 'run-1', status: 'running' },
    }));
    const tool = fake.tools.get('invoke_worker');
    if (!tool) throw new Error('invoke_worker tool not registered');
    const callSpy = vi.spyOn(kernelClient, 'call');

    await tool.execute(
      'call-1',
      { definitionId: 'def-1', version: 1, input: {}, wait: true, timeout: 999 },
      undefined,
      undefined,
      fakeCtx(),
    );

    expect(callSpy).toHaveBeenCalledWith('invoke_worker', expect.anything(), undefined, 100_000);
  });

  it('does not force wait:false on any other capability (get_task params pass through unmodified)', async () => {
    kernel.setHandler('get_task', () => ({ ok: true, result: { taskId: 'task-1' } }));
    const tool = fake.tools.get('get_task');
    if (!tool) throw new Error('get_task tool not registered');

    await tool.execute('call-1', { taskId: 'task-1' }, undefined, undefined, fakeCtx());

    const call = kernel.requests.find((r) => r.capability === 'get_task');
    expect(call?.params).toEqual({ taskId: 'task-1' });
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

  // Leftover 87: the entry agent's kernel calls carry the current Turn id as their correlation id.
  it('every kernel call after a turn marker carries that Turn id as x-correlation-id', async () => {
    kernel.setHandler('get_entry_context', () => ({ ok: true, result: {} }));
    kernel.setHandler('report_turn', () => ({ ok: true, result: {} }));
    kernel.setHandler('get_object', () => ({ ok: true, result: {} }));
    const inputHandler = fake.handlers.get('input');
    const contextHandler = fake.handlers.get('context');
    const agentSettledHandler = fake.handlers.get('agent_settled');
    if (!inputHandler || !contextHandler || !agentSettledHandler)
      throw new Error('handlers not registered');

    const turnId = '7f0c7c1e-8a44-4b6b-9f59-1b7bbcf0a3d2';
    inputHandler(
      {
        text: `<!--nexttime:turn_id=${turnId}-->
Hi`,
        source: 'rpc',
      },
      fakeCtx(),
    );
    await contextHandler({ messages: [] }, fakeCtx());
    await fake.tools
      .get('get_object')
      ?.execute('call-1', { objectId: 'o-1' }, undefined, undefined, fakeCtx());
    await agentSettledHandler({}, fakeCtx());

    expect(kernel.requests.map((r) => [r.capability, r.correlationId])).toEqual([
      ['get_entry_context', turnId],
      ['get_object', turnId],
      ['report_turn', turnId],
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

/**
 * 收尾波次 C3 — per-turn gate tool projection (`gate-tool-projection.ts`). Each case drives the real
 * `registerEntryMode` wiring (`session_start` / `input` / `before_agent_start`) against the fake pi
 * above and a fake kernel whose `list_allowed_operations` answer changes between turns, the way it
 * does on the host when a gate is enabled, an Operation is published / deprecated, or the observe
 * predicate stops listing a gate. The fake kernel only models the read model's *output*; which
 * change produced it is the kernel's business (it re-checks every call regardless).
 */
describe('registerEntryMode — per-turn gate tool projection (C3)', () => {
  const STATIC_TOOLS = [
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
  ];

  let kernel: FakeKernel;
  let fake: FakePi;
  let items: unknown[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function row(
    gatekeeperId: string,
    gateName: string,
    name: string,
    operation: Record<string, unknown> = {},
  ) {
    return {
      gatekeeperId,
      gateName,
      name,
      operation: {
        mode: 'observe',
        params_schema: { type: 'object', properties: {} },
        ...operation,
      },
    };
  }

  function handler(event: string): Handler {
    const found = fake.handlers.get(event);
    if (!found) throw new Error(`${event} handler not registered`);
    return found;
  }

  async function sessionStart(): Promise<void> {
    await handler('session_start')({ type: 'session_start', reason: 'startup' }, fakeCtx());
  }

  /** One user message: the `input` marker sets the Turn id, then pi fires `before_agent_start`. */
  async function turn(turnId: string): Promise<unknown> {
    handler('input')({ type: 'input', text: `<!--nexttime:turn_id=${turnId}-->\nhi` });
    return handler('before_agent_start')(
      { type: 'before_agent_start', prompt: 'hi', systemPrompt: '', systemPromptOptions: {} },
      fakeCtx(),
    );
  }

  function listReads(): number {
    return kernel.requests.filter((r) => r.capability === 'list_allowed_operations').length;
  }

  function logLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  function snapshotStatic(): Map<string, ToolDefinition | undefined> {
    return new Map(STATIC_TOOLS.map((name) => [name, fake.tools.get(name)]));
  }

  /** Built-ins stay active in their original order, and every static capability tool stays
   *  active with its original definition, whatever the projection did. */
  function expectUntouched(staticDefinitions: Map<string, ToolDefinition | undefined>): void {
    expect(fake.active.slice(0, ACTIVE_BUILTINS.length)).toEqual(ACTIVE_BUILTINS);
    expect(fake.active).not.toContain('powershell');
    for (const name of STATIC_TOOLS) {
      expect(fake.active).toContain(name);
      expect(fake.tools.get(name)).toBe(staticDefinitions.get(name));
    }
  }

  async function setup(toolRefreshTimeoutMs?: number): Promise<void> {
    kernel = await startFakeKernel();
    fake = createFakePi();
    items = [];
    kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items } }));
    registerEntryMode(fake.api, {
      kernelClient: new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' }),
      workspaceId: 'ws-1',
      toolRefreshTimeoutMs,
    });
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await kernel.close();
  });

  it('a newly allowed Operation (gate enabled / Operation published) becomes an active tool on the next turn, logged as added', async () => {
    await setup();
    items = [row('gk-1', 'accept_s2_api', 'stock.get')];
    await sessionStart();
    const statics = snapshotStatic();
    expect(fake.active).toContain('accept_s2_api_stock_get');

    items = [row('gk-1', 'accept_s2_api', 'stock.get'), row('gk-2', 'ragflow', 'kb.list')];
    const result = await turn('turn-2');

    expect(result).toBeUndefined(); // never overrides the system prompt or injects a message
    expect(fake.active).toEqual(
      expect.arrayContaining(['accept_s2_api_stock_get', 'ragflow_kb_list']),
    );
    expect(fake.tools.get('ragflow_kb_list')?.label).toBe('ragflow.kb.list');
    // Appended after everything already active — the declared tool prefix stays stable.
    expect(fake.active.at(-1)).toBe('ragflow_kb_list');
    expectUntouched(statics);
    expect(logLines(logSpy)).toContain(
      'nexttime-entry check=tool_projection result=changed trigger=turn turn_id=turn-2 ' +
        'added=ragflow_kb_list removed=- redefined=- gate_tools=2',
    );

    // The new tool is live: it calls observe_operation on the right gate.
    kernel.setHandler('observe_operation', () => ({ ok: true, result: { status: 'ok' } }));
    const tool = fake.tools.get('ragflow_kb_list');
    if (!tool) throw new Error('ragflow_kb_list missing');
    await tool.execute('call-1', {}, undefined, undefined, fakeCtx());
    expect(kernel.requests.find((r) => r.capability === 'observe_operation')?.params).toEqual({
      gatekeeperId: 'gk-2',
      operation: 'kb.list',
      params: {},
    });
  });

  it('an Operation the member excluded disappears from the active set on the next turn (still registered — pi has no unregister)', async () => {
    await setup();
    items = [row('gk-1', 'accept_s2_api', 'stock.get'), row('gk-2', 'ragflow', 'kb.list')];
    await sessionStart();
    const statics = snapshotStatic();

    items = [row('gk-1', 'accept_s2_api', 'stock.get')]; // gk-2 excluded on 我的智能体
    await turn('turn-2');

    expect(fake.active).toContain('accept_s2_api_stock_get');
    expect(fake.active).not.toContain('ragflow_kb_list');
    expect(fake.tools.has('ragflow_kb_list')).toBe(true);
    expectUntouched(statics);
    expect(logLines(logSpy)).toContain(
      'nexttime-entry check=tool_projection result=changed trigger=turn turn_id=turn-2 ' +
        'added=- removed=ragflow_kb_list redefined=- gate_tools=1',
    );
  });

  it("a disabled gate's tools all disappear, and come back under the same names when it is re-enabled", async () => {
    await setup();
    items = [row('gk-1', 'docker', 'compose.ls'), row('gk-1', 'docker', 'container.list')];
    await sessionStart();
    const statics = snapshotStatic();
    expect(fake.active).toEqual(
      expect.arrayContaining(['docker_compose_ls', 'docker_container_list']),
    );

    items = [];
    await turn('turn-2');
    expect(fake.active.some((name) => name.startsWith('docker_'))).toBe(false);
    expectUntouched(statics);

    items = [row('gk-1', 'docker', 'compose.ls'), row('gk-1', 'docker', 'container.list')];
    await turn('turn-3');
    expect(fake.active).toEqual(
      expect.arrayContaining(['docker_compose_ls', 'docker_container_list']),
    );
    expectUntouched(statics);
    // Re-activated, not re-registered: the definition did not change.
    const registrations = vi
      .mocked(fake.api.registerTool)
      .mock.calls.filter(([tool]) => tool.name === 'docker_compose_ls');
    expect(registrations).toHaveLength(1);
  });

  it('reads list_allowed_operations exactly once per turn, and leaves pi alone when nothing changed', async () => {
    await setup();
    items = [row('gk-1', 'accept_s2_api', 'stock.get')];
    await sessionStart();
    expect(listReads()).toBe(1);

    await turn('turn-1');
    await turn('turn-2');
    await turn('turn-3');

    expect(listReads()).toBe(4);
    expect(kernel.requests.filter((r) => r.capability !== 'list_allowed_operations')).toEqual([]);
    expect(fake.api.setActiveTools).not.toHaveBeenCalled();
    // 17 static tools + 1 gate tool, each registered once.
    expect(fake.api.registerTool).toHaveBeenCalledTimes(18);
    // Only the first projection is a change worth logging.
    expect(logLines(logSpy).filter((line) => line.includes('check=tool_projection'))).toHaveLength(
      1,
    );
  });

  it('a kernel error keeps the previous set (never drops to zero on a transient failure) and logs a warning', async () => {
    await setup();
    items = [row('gk-1', 'accept_s2_api', 'stock.get')];
    await sessionStart();
    const activeBefore = [...fake.active];

    kernel.setHandler('list_allowed_operations', () => ({
      ok: false,
      error: { code: 'internal', message: 'db unavailable' },
    }));
    await turn('turn-2');

    expect(fake.active).toEqual(activeBefore);
    expect(logLines(errorSpy)).toContain(
      'nexttime-entry check=tool_projection result=kept_previous trigger=turn turn_id=turn-2 ' +
        'reason=capability_error code=internal message="db unavailable"',
    );

    // A malformed answer is not an authoritative "nothing allowed" either.
    kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: {} }));
    await turn('turn-3');
    expect(fake.active).toEqual(activeBefore);
    expect(logLines(errorSpy).some((line) => line.includes('reason=invalid_response'))).toBe(true);

    // Recovery: the next good read applies normally.
    kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items: [] } }));
    await turn('turn-4');
    expect(fake.active).not.toContain('accept_s2_api_stock_get');
  });

  it('a slow kernel is abandoned after the refresh budget: the turn proceeds with the previous set', async () => {
    await setup(50);
    items = [row('gk-1', 'accept_s2_api', 'stock.get')];
    await sessionStart();
    const activeBefore = [...fake.active];

    kernel.setHandler('list_allowed_operations', async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { ok: true, result: { items: [] } };
    });
    const startedAt = Date.now();
    await turn('turn-2');

    expect(Date.now() - startedAt).toBeLessThan(350);
    expect(fake.active).toEqual(activeBefore);
    expect(
      logLines(errorSpy).some(
        (line) => line.includes('result=kept_previous') && line.includes('reason=timeout'),
      ),
    ).toBe(true);
    // Let the abandoned response drain before the fake kernel closes.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it('an Operation whose name would collide with a static tool takes the gatekeeperId fallback and never replaces or deactivates it', async () => {
    await setup();
    const statics = snapshotStatic();
    items = [row('gk-9', 'get', 'object')]; // `get.object` sanitizes onto the static `get_object`
    await sessionStart();

    expect(fake.active).toContain('gk-9_object');
    expect(fake.tools.get('gk-9_object')?.label).toBe('get.object');
    expectUntouched(statics);

    items = [];
    await turn('turn-2');
    expect(fake.active).not.toContain('gk-9_object');
    expectUntouched(statics);
  });

  it('names stay stable for the session: a fallback-named tool keeps its name when the gate holding the primary name goes away', async () => {
    await setup();
    items = [row('gk-1', 'netbox', 'devices.list'), row('gk-2', 'netbox', 'devices.list')];
    await sessionStart();
    expect(fake.active).toEqual(
      expect.arrayContaining(['netbox_devices_list', 'gk-2_devices_list']),
    );

    items = [row('gk-2', 'netbox', 'devices.list')];
    await turn('turn-2');
    expect(fake.active).toContain('gk-2_devices_list');
    expect(fake.active).not.toContain('netbox_devices_list');

    kernel.setHandler('observe_operation', () => ({ ok: true, result: { status: 'ok' } }));
    const tool = fake.tools.get('gk-2_devices_list');
    if (!tool) throw new Error('gk-2_devices_list missing');
    await tool.execute('call-1', {}, undefined, undefined, fakeCtx());
    expect(kernel.requests.find((r) => r.capability === 'observe_operation')?.params).toMatchObject(
      { gatekeeperId: 'gk-2' },
    );
  });

  it('a changed Operation definition is re-registered under the same name so the model sees the current description', async () => {
    await setup();
    items = [row('gk-1', 'ragflow', 'kb.list', { description: 'List knowledge bases.' })];
    await sessionStart();

    items = [row('gk-1', 'ragflow', 'kb.list', { description: 'List datasets.' })];
    await turn('turn-2');

    expect(fake.tools.get('ragflow_kb_list')?.description).toContain('List datasets.');
    expect(fake.active.filter((name) => name === 'ragflow_kb_list')).toHaveLength(1);
    expect(logLines(logSpy)).toContain(
      'nexttime-entry check=tool_projection result=changed trigger=turn turn_id=turn-2 ' +
        'added=- removed=- redefined=ragflow_kb_list gate_tools=1',
    );
  });

  it('execute-class Operations are never projected, on any turn', async () => {
    await setup();
    items = [row('gk-2', 'docker', 'container.restart', { mode: 'execute' })];
    await sessionStart();
    await turn('turn-2');
    expect(fake.tools.has('docker_container_restart')).toBe(false);
    expect(fake.active).not.toContain('docker_container_restart');
  });
});
