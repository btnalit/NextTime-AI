import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import {
  type AgentSession,
  type AgentSessionEvent,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeKernel, startFakeKernel } from './test-support/fake-kernel.js';

// The real extension module's own file path — same `additionalExtensionPaths` mechanism
// `entry.sdk.test.ts` already established (see that file's own doc comment for why).
const EXTENSION_PATH = join(import.meta.dirname, 'index.ts');

/**
 * The required real-SDK test for worker mode (task brief: "Contract tests against pi 0.84.4 like
 * S1.6's"), mirroring `entry.sdk.test.ts`'s structure. Exercises what a fake-`ExtensionAPI`-stub
 * test (`modes/worker.test.ts`) cannot: that `pi.sendUserMessage` called from `session_start`
 * genuinely self-drives a full turn through the *real* Agent loop with no external prompt driver
 * (worker containers have none, S2.8), that pi's real isError wiring applies to a gate tool the
 * same way it does to an entry observe tool, and that `report_result`'s `terminate: true` really
 * stops the loop after that tool call.
 *
 * Because the whole turn is triggered *inside* `session_start` (itself part of
 * `createAgentSession`'s own startup, before this test's own code regains control) rather than by
 * an explicit `await session.prompt(...)` call, this test cannot assume the turn has finished the
 * instant `createAgentSession` resolves — it polls for the one reliable, timing-independent
 * completion signal instead: the fake kernel actually receiving `report_task_result`.
 *
 * The second case is leftover 42's own proof (docs/STATUS.md §4 row 42): `report_result` now posts
 * inside the tool call, so a kernel `{ok:false}` must reach the model as that tool's own
 * `isError:true` result through pi's real wiring — and the model's corrected second call must land.
 */

const REQUIRED_WORKER_ENV = {
  NEXTTIME_MODE: 'worker',
  KERNEL_URL: '', // filled in per-test once the fake kernel is listening
  CAPABILITY_HANDLE: 'sdk-test-handle',
  WORKSPACE_ID: 'ws-sdk-test',
  TASK_ID: 'task-sdk-test',
} as const;

const ENV_KEYS = Object.keys(REQUIRED_WORKER_ENV);

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Boots a real `AgentSession` with the faux provider and the real extension in worker mode,
 *  and binds extensions so `session_start` fires — the whole turn is self-driven from there. */
async function startWorkerSession(
  fauxProvider: ReturnType<typeof registerFauxProvider>,
  tmpDir: string,
): Promise<{ session: AgentSession; events: AgentSessionEvent[] }> {
  const model = fauxProvider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: 'faux-key',
    api: fauxProvider.api,
    models: fauxProvider.models.map((registeredModel) => ({
      id: registeredModel.id,
      name: registeredModel.name,
      api: registeredModel.api,
      reasoning: registeredModel.reasoning,
      input: registeredModel.input,
      cost: registeredModel.cost,
      contextWindow: registeredModel.contextWindow,
      maxTokens: registeredModel.maxTokens,
      baseUrl: registeredModel.baseUrl,
    })),
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: tmpDir,
    agentDir: tmpDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    additionalExtensionPaths: [EXTENSION_PATH],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  expect(resourceLoader.getExtensions().extensions).toHaveLength(1);

  const { session } = await createAgentSession({
    cwd: tmpDir,
    agentDir: tmpDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(tmpDir),
    settingsManager: SettingsManager.inMemory(),
    noTools: 'builtin',
  });

  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  // `createAgentSession()` alone does not emit `session_start` — that only happens inside
  // `AgentSession.bindExtensions()` (agent-session.js), which the CLI/RPC mode layer calls as
  // part of its own startup (`entrypoint.sh`'s real `pi --mode rpc` goes through it); a bare SDK
  // caller must call it explicitly. `entry.sdk.test.ts` never needed this because entry mode
  // subscribes to no `session_start`-dependent behavior at all — worker mode's whole self-drive
  // mechanism (session_start -> pi.sendUserMessage()) does.
  await session.bindExtensions({ mode: 'rpc' });
  return { session, events };
}

describe('platform-extension loaded through the real pi SDK (worker mode)', () => {
  let kernel: FakeKernel;
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  // biome-ignore lint/suspicious/noExplicitAny: spying on process.exit's overloaded signature.
  let exitSpy: any;
  // Leftover 55 (docs/STATUS.md, CI run 35763937452): each test used to call `session.dispose()`
  // / `fauxProvider.unregister()` itself, after its own assertions — never reached when a test
  // throws or hits its own timeout under CI load. The leaked session kept its real, self-driven
  // Agent loop running in the background; when it eventually reached `agent_settled` and called
  // `process.exit(0)`, `exitSpy` had already been restored by *this* test's own `afterEach` and a
  // *new* spy installed by the *next* test's `beforeEach` — so the stray call landed on the next
  // test's spy and broke its call-count assertions. Tracking the live session/provider/extra spy
  // here and tearing them down from `afterEach` (which always runs, pass, fail, or timeout, before
  // the next test's `beforeEach`) closes that window regardless of how a test body exits.
  let session: AgentSession | undefined;
  let fauxProvider: ReturnType<typeof registerFauxProvider> | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: vi.spyOn's generic return type isn't worth naming here.
  let errorSpy: any;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    tmpDir = mkdtempSync(join(tmpdir(), 'nexttime-platform-extension-worker-sdk-'));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.NEXTTIME_MODE = 'worker';
    process.env.KERNEL_URL = kernel.url;
    process.env.CAPABILITY_HANDLE = REQUIRED_WORKER_ENV.CAPABILITY_HANDLE;
    process.env.WORKSPACE_ID = REQUIRED_WORKER_ENV.WORKSPACE_ID;
    process.env.TASK_ID = REQUIRED_WORKER_ENV.TASK_ID;
    // The real agent_settled handler calls process.exit(0) — must never actually kill the test
    // process (worker.test.ts's fake-stub tests spy on this too, for the same reason).
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    session = undefined;
    fauxProvider = undefined;
    errorSpy = undefined;
  });

  afterEach(async () => {
    // Leftover 55: dispose/unregister unconditionally, before anything else — see the field
    // comments above for why this must not live only at the end of each test body.
    session?.dispose();
    fauxProvider?.unregister();
    errorSpy?.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    exitSpy.mockRestore();
    await kernel.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('self-drives its one turn via sendUserMessage, registers a gate tool with real isError wiring, and posts report_task_result on report_result', async () => {
    kernel.setHandler('list_allowed_operations', () => ({
      ok: true,
      result: {
        items: [
          {
            gatekeeperId: 'gk-1',
            gateName: 'inventory',
            name: 'get',
            operation: { params_schema: { type: 'object', properties: {} } },
          },
        ],
      },
    }));
    kernel.setHandler('get_task', () => ({ ok: true, result: { input: 'check stock levels' } }));
    kernel.setHandler('search', () => ({ ok: true, result: { objects: [] } }));
    kernel.setHandler('request_action', () => ({
      ok: false,
      error: { code: 'not_found', message: 'no such gatekeeper' },
    }));
    kernel.setHandler('report_task_result', () => ({
      ok: true,
      result: { status: 'completed' },
    }));

    const localFauxProvider = registerFauxProvider();
    fauxProvider = localFauxProvider; // tracked on the outer var for `afterEach` disposal (leftover 55)
    const capturedContexts: Context[] = [];
    localFauxProvider.setResponses([
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(fauxToolCall('inventory_get', {}), { stopReason: 'toolUse' });
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall('report_result', { summary: 'stock check failed' }),
          {
            stopReason: 'toolUse',
          },
        );
      },
    ]);

    const started = await startWorkerSession(localFauxProvider, tmpDir);
    const activeSession = started.session;
    session = activeSession; // tracked on the outer var for `afterEach` disposal (leftover 55)
    const { events } = started;

    // No test-initiated session.prompt() anywhere in this test — the whole turn below is driven
    // by the real extension's own session_start -> pi.sendUserMessage() call.
    await waitFor(() =>
      kernel.requests.some((request) => request.capability === 'report_task_result'),
    );

    // The tool list is exactly report_result + the one gate tool the Handle's scope allowed
    // (S2.9 acceptance: "工具列表恰好等于 Handle 内的 Operation").
    const toolNames = activeSession.agent.state.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['report_result', 'inventory_get']));

    // context injection carried the Task input into the model's first call.
    expect(capturedContexts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(capturedContexts[0]?.messages)).toContain('check stock levels');
    expect(activeSession.messages.some((message) => message.role === 'custom')).toBe(false);

    // The gate tool's kernel failure really became isError:true through pi's real tool-call
    // wiring (not just "the promise rejected", which a fake-ExtensionAPI stub cannot prove).
    const toolEnds = events.filter(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end',
    );
    const gateToolEnd = toolEnds.find((event) => event.toolName === 'inventory_get');
    expect(gateToolEnd?.isError).toBe(true);
    expect(JSON.stringify(gateToolEnd?.result)).toContain('no such gatekeeper');

    // report_result posted the contract itself (leftover 42) and its terminate:true stopped the
    // loop; agent_settled posted nothing more and (mocked) exited the process.
    const reportCalls = kernel.requests.filter(
      (request) => request.capability === 'report_task_result',
    );
    expect(reportCalls).toHaveLength(1);
    expect(reportCalls[0]?.params).toMatchObject({ summary: 'stock check failed' });
    await waitFor(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(0);
    // session/fauxProvider disposal now happens unconditionally in `afterEach` (leftover 55).
  });

  it('a kernel rejection of report_result reaches the model as isError:true through pi’s real wiring, the corrected call lands, and the process still exits 0 (leftover 42)', async () => {
    kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items: [] } }));
    kernel.setHandler('get_task', () => ({ ok: true, result: { input: 'check stock levels' } }));
    kernel.setHandler('search', () => ({ ok: true, result: { items: [] } }));
    let reportAttempts = 0;
    kernel.setHandler('report_task_result', () => {
      reportAttempts += 1;
      if (reportAttempts === 1) {
        return {
          ok: false,
          error: { code: 'invalid_params', message: 'summary must not be empty' },
        };
      }
      return {
        ok: true,
        result: { id: 'task-sdk-test', status: 'completed', activityId: 'a', factIds: [] },
      };
    });

    const localFauxProvider = registerFauxProvider();
    fauxProvider = localFauxProvider; // tracked on the outer var for `afterEach` disposal (leftover 55)
    const capturedContexts: Context[] = [];
    localFauxProvider.setResponses([
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(fauxToolCall('report_result', { summary: 'first try' }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(fauxToolCall('report_result', { summary: 'second try' }), {
          stopReason: 'toolUse',
        });
      },
    ]);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // ditto

    const started = await startWorkerSession(localFauxProvider, tmpDir);
    session = started.session; // ditto
    const { events } = started;

    await waitFor(() => reportAttempts >= 2);
    await waitFor(() => exitSpy.mock.calls.length > 0);

    // The first report_result's kernel 400 became isError:true on that tool call (pi's own
    // wiring, not just a rejected promise), carrying the kernel's code + message for the model.
    const toolEnds = events.filter(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end' && event.toolName === 'report_result',
    );
    expect(toolEnds.map((event) => event.isError)).toEqual([true, false]);
    expect(JSON.stringify(toolEnds[0]?.result)).toContain('invalid_params');
    expect(JSON.stringify(toolEnds[0]?.result)).toContain('summary must not be empty');
    expect(JSON.stringify(toolEnds[1]?.result)).toContain('Result contract accepted');

    // The model's second call saw the error as a tool result in its own context.
    expect(JSON.stringify(capturedContexts[1]?.messages)).toContain('invalid_params');

    // Exactly two posts (the rejected one and the corrected one) — agent_settled added none —
    // and the exit code is still 0: a kernel 4xx never turns into an S2.7 requeue.
    const reportCalls = kernel.requests.filter(
      (request) => request.capability === 'report_task_result',
    );
    expect(reportCalls.map((r) => (r.params as { summary: string }).summary)).toEqual([
      'first try',
      'second try',
    ]);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    // session/fauxProvider/errorSpy cleanup now happens unconditionally in `afterEach` (leftover 55).
  });

  it('a scripted model that keeps replaying report_result against an unfixable kernel rejection does not spin: the turn ends after one attempt, agent_settled re-sends once, exit 0 (fake-llm safety)', async () => {
    kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items: [] } }));
    kernel.setHandler('get_task', () => ({ ok: true, result: { input: 'x' } }));
    kernel.setHandler('search', () => ({ ok: true, result: { items: [] } }));
    kernel.setHandler('report_task_result', () => ({
      ok: false,
      error: { code: 'illegal_transition', message: 'Task is waiting_approval' },
    }));

    const localFauxProvider = registerFauxProvider();
    fauxProvider = localFauxProvider; // tracked on the outer var for `afterEach` disposal (leftover 55)
    let modelCalls = 0;
    // deploy/fake-llm/server.mjs replays a scenario's *last* step on every further request —
    // modelled here as the same report_result call answered indefinitely.
    localFauxProvider.setResponses(
      Array.from({ length: 8 }, () => () => {
        modelCalls += 1;
        return fauxAssistantMessage(fauxToolCall('report_result', { summary: 'same' }), {
          stopReason: 'toolUse',
        });
      }),
    );
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // ditto

    const started = await startWorkerSession(localFauxProvider, tmpDir);
    session = started.session; // ditto
    const { events } = started;
    await waitFor(() => exitSpy.mock.calls.length > 0);

    const reportCalls = kernel.requests.filter(
      (request) => request.capability === 'report_task_result',
    );
    expect(reportCalls).toHaveLength(2); // the tool's attempt + agent_settled's one re-send
    expect(modelCalls).toBe(1); // the loop terminated after the first tool batch
    const toolEnds = events.filter(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end' && event.toolName === 'report_result',
    );
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]?.isError).toBe(false);
    expect(JSON.stringify(toolEnds[0]?.result)).toContain('illegal_transition');
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    // session/fauxProvider/errorSpy cleanup now happens unconditionally in `afterEach` (leftover 55).
  });
});
