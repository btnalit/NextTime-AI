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

/** Contract fixtures that pass `WorkerResultContractSchema` (packages/shared/src/worker-result.ts)
 *  — object refs are `{objectType, identity: record}`, evidence carries `content: record`, a
 *  proposal carries a full `OperationSchema` and a uuid `gatekeeperId`. */
const hostRef = { objectType: 'Host', identity: { hostname: 'h1' } };
const serviceRef = { objectType: 'Service', identity: { name: 's1' } };
const MADE_UP_GATEKEEPER_ID = '00000000-0000-4000-8000-00000000abcd';
const sampleOperation = {
  name: 'x.y',
  binding: { kind: 'http', method: 'GET', path: '/x' },
  params_schema: { type: 'object' },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: true,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

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
        items: [
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
        items: [
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
        items: [
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
        id: 'ar-1',
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
    // Leftover 43: the point-of-use half of ops-runner.yaml's "以 ActionRequest 状态为准" contract.
    expect(text).toContain('not executed yet');
    expect(text).toContain('cite this actionRequestId');
    expect(text).toContain('never report it as failed or not done');
  });

  it('report_result validates the contract with Zod, rejects (throws) on an invalid shape', async () => {
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');

    await expect(
      tool.execute('call-1', { summary: 123 }, undefined, undefined, fakeCtx()),
    ).rejects.toThrow(/invalid contract/);
  });

  it('report_result posts the contract synchronously (leftover 42) — sessionJsonlPath from the tool ctx — and returns terminate:true with the kernel’s answer', async () => {
    kernel.setHandler('report_task_result', () => ({
      ok: true,
      result: { id: 'task-1', status: 'completed', activityId: 'act-1', factIds: [] },
    }));
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await tool.execute(
      'call-1',
      { summary: 'done', findings: ['ok'] },
      undefined,
      undefined,
      fakeCtx('/workspace/.pi/sessions/abc.jsonl'),
    );

    expect(result.terminate).toBe(true);
    const [firstPart] = result.content;
    const text = firstPart?.type === 'text' ? firstPart.text : '';
    expect(text).toContain('Result contract accepted');
    expect(text).toContain('Task task-1 is completed');
    const reportCall = kernel.requests.find((r) => r.capability === 'report_task_result');
    expect(reportCall?.params).toEqual({
      summary: 'done',
      findings: ['ok'],
      sessionJsonlPath: '/workspace/.pi/sessions/abc.jsonl',
    });
    // No factsToAssert/proposedOperations/evidence in the contract → nothing the kernel could
    // refuse per entry → no get_task read-back round trip.
    expect(kernel.requests.filter((r) => r.capability === 'get_task')).toHaveLength(0);
    logSpy.mockRestore();
  });

  it('report_result surfaces a kernel rejection as a thrown (isError) tool result the model can act on; a corrected call then posts (leftover 42)', async () => {
    let attempt = 0;
    kernel.setHandler('report_task_result', () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          error: { code: 'invalid_params', message: 'factsToAssert[0].linkType: must be a string' },
        };
      }
      return {
        ok: true,
        result: { id: 'task-1', status: 'completed', activityId: 'act-1', factIds: [] },
      };
    });
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      tool.execute('call-1', { summary: 'first' }, undefined, undefined, fakeCtx()),
    ).rejects.toThrow(/invalid_params: factsToAssert\[0\]\.linkType.*call report_result again/);

    const second = await tool.execute(
      'call-2',
      { summary: 'corrected' },
      undefined,
      undefined,
      fakeCtx(),
    );
    expect(second.terminate).toBe(true);

    const reportCalls = kernel.requests.filter((r) => r.capability === 'report_task_result');
    expect(reportCalls.map((r) => (r.params as { summary: string }).summary)).toEqual([
      'first',
      'corrected',
    ]);

    // agent_settled: nothing left to post (the corrected call was accepted), still exits 0 once.
    const agentSettled = fake.handlers.get('agent_settled');
    if (!agentSettled) throw new Error('agent_settled handler not registered');
    await agentSettled({}, fakeCtx());
    await flushImmediate();
    expect(kernel.requests.filter((r) => r.capability === 'report_task_result')).toHaveLength(2);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('report_result tells the model not to re-send on a 403/409-class rejection, and agent_settled still exits 0 after re-trying the pending contract once (never a non-zero exit)', async () => {
    kernel.setHandler('report_task_result', () => ({
      ok: false,
      error: { code: 'illegal_transition', message: 'Task is waiting_approval' },
    }));
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      tool.execute('call-1', { summary: 'x' }, undefined, undefined, fakeCtx()),
    ).rejects.toThrow(/illegal_transition: Task is waiting_approval.*do not re-send/);

    const agentSettled = fake.handlers.get('agent_settled');
    if (!agentSettled) throw new Error('agent_settled handler not registered');
    await agentSettled({}, fakeCtx());
    await flushImmediate();

    // The tool's own attempt + agent_settled's fallback re-send of the same pending contract.
    expect(kernel.requests.filter((r) => r.capability === 'report_task_result')).toHaveLength(2);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('report_result echoes factsRejected / proposedOperationsRejected / evidenceDropped read back from get_task (S5.6 #208 / #211 per-entry refusals, I16 included)', async () => {
    kernel.setHandler('report_task_result', () => ({
      ok: true,
      result: { id: 'task-1', status: 'completed', activityId: 'act-1', factIds: ['fact-a'] },
    }));
    kernel.setHandler('get_task', () => ({
      ok: true,
      result: {
        id: 'task-1',
        status: 'completed',
        result: {
          summary: 's',
          factIds: ['fact-a'],
          factsRejected: [
            {
              index: 1,
              linkType: 'runs_on',
              reason: 'meta_ontology_type',
              detail: 'ObjectType "Gatekeeper" is platform meta-ontology (I16)',
            },
            {
              index: 2,
              linkType: 'depends_on',
              reason: 'link_type_not_allowed',
              sourceType: 'Host',
              targetType: 'Service',
              expected: ['hosts'],
            },
          ],
          proposedOperationsRejected: [
            { index: 0, gatekeeperId: MADE_UP_GATEKEEPER_ID, reason: 'gatekeeper_not_found' },
          ],
          evidenceDropped: [1],
        },
      },
    }));
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await tool.execute(
      'call-1',
      {
        summary: 'restarted',
        factsToAssert: [
          { linkType: 'hosts', source: hostRef, target: serviceRef },
          {
            linkType: 'runs_on',
            source: hostRef,
            target: { objectType: 'Gatekeeper', identity: { name: 'docker' } },
          },
          { linkType: 'depends_on', source: hostRef, target: serviceRef },
        ],
        evidence: [
          { kind: 'command', content: { stdout: 'restarted' } },
          { kind: 'command', content: { stdout: 'x' }, factIndex: 9 },
        ],
        proposedOperations: [{ gatekeeperId: MADE_UP_GATEKEEPER_ID, operation: sampleOperation }],
      },
      undefined,
      undefined,
      fakeCtx(),
    );

    expect(result.terminate).toBe(true);
    const [firstPart] = result.content;
    const text = firstPart?.type === 'text' ? firstPart.text : '';
    expect(text).toContain('1 of 3 factsToAssert written as Facts');
    expect(text).toContain('Refused by the platform');
    expect(text).toContain(
      'factsToAssert[1] (runs_on): meta_ontology_type — ObjectType "Gatekeeper" is platform meta-ontology (I16)',
    );
    expect(text).toContain(
      'factsToAssert[2] (depends_on): link_type_not_allowed — expected ["hosts"]',
    );
    expect(text).toContain(
      `proposedOperations[0] (gatekeeperId ${MADE_UP_GATEKEEPER_ID}): gatekeeper_not_found`,
    );
    expect(text).toContain('evidence[1]: dropped');
    expect(kernel.requests.filter((r) => r.capability === 'get_task')).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('report_result still terminates with an accepted result when the get_task read-back fails (the echo is best-effort)', async () => {
    kernel.setHandler('report_task_result', () => ({
      ok: true,
      result: { id: 'task-1', status: 'completed', activityId: 'act-1', factIds: [] },
    }));
    // no get_task handler → 404
    const tool = fake.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await tool.execute(
      'call-1',
      {
        summary: 'x',
        factsToAssert: [{ linkType: 'hosts', source: hostRef, target: serviceRef }],
      },
      undefined,
      undefined,
      fakeCtx(),
    );

    expect(result.terminate).toBe(true);
    const [firstPart] = result.content;
    const text = firstPart?.type === 'text' ? firstPart.text : '';
    expect(text).toContain('Result contract accepted');
    expect(text).not.toContain('Refused');
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('report_result on a network failure records the contract and terminates; agent_settled then re-sends it and exits 0', async () => {
    const unreachable = new KernelClient({
      kernelUrl: 'http://127.0.0.1:1',
      capabilityHandle: 'h',
      timeoutMs: 500,
    });
    const fake2 = createFakePi();
    registerWorkerMode(fake2.api, {
      kernelClient: unreachable,
      workspaceId: 'ws-1',
      taskId: 'task-1',
    });
    const tool = fake2.tools.get('report_result');
    if (!tool) throw new Error('report_result tool not registered');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await tool.execute('call-1', { summary: 'x' }, undefined, undefined, fakeCtx());
    expect(result.terminate).toBe(true);
    const [firstPart] = result.content;
    const text = firstPart?.type === 'text' ? firstPart.text : '';
    expect(text).toContain('could not be reached');

    const agentSettled = fake2.handlers.get('agent_settled');
    if (!agentSettled) throw new Error('agent_settled handler not registered');
    await agentSettled({}, fakeCtx());
    await flushImmediate();
    // The fallback re-send also fails (still unreachable) — logged, and the exit is still 0.
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith('nexttime-worker check=report_task_result result=fail');
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('the context handler injects Task input (get_task) and related facts (search) as a non-persisted custom message', async () => {
    kernel.setHandler('get_task', () => ({ ok: true, result: { input: 'restart the flaky pod' } }));
    kernel.setHandler('search', () => ({ ok: true, result: { items: [{ id: 'obj-1' }] } }));
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
    expect(message.content).not.toContain('### Skills');

    const getTaskCall = kernel.requests.find((r) => r.capability === 'get_task');
    expect(getTaskCall?.params).toEqual({ taskId: 'task-1' });
  });

  it('the context handler caches Task input across calls (one get_task round trip)', async () => {
    kernel.setHandler('get_task', () => ({ ok: true, result: { input: 'x' } }));
    kernel.setHandler('search', () => ({ ok: true, result: { items: [] } }));
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

  it('agent_settled after an accepted report_result posts nothing more and still exits 0 exactly once (the exit must not depend on the post having happened here)', async () => {
    kernel.setHandler('report_task_result', () => ({ ok: true, result: { status: 'completed' } }));
    const reportResultTool = fake.tools.get('report_result');
    if (!reportResultTool) throw new Error('report_result tool not registered');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await reportResultTool.execute(
      'call-1',
      { summary: 'pong', findings: [] },
      undefined,
      undefined,
      fakeCtx('/workspace/.pi/sessions/abc.jsonl'),
    );

    const agentSettled = fake.handlers.get('agent_settled');
    if (!agentSettled) throw new Error('agent_settled handler not registered');
    await agentSettled({}, fakeCtx('/workspace/.pi/sessions/abc.jsonl'));
    await flushImmediate();

    const reportCalls = kernel.requests.filter((r) => r.capability === 'report_task_result');
    expect(reportCalls).toHaveLength(1);
    expect(reportCalls[0]?.params).toMatchObject({
      summary: 'pong',
      sessionJsonlPath: '/workspace/.pi/sessions/abc.jsonl',
    });
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
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
