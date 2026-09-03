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

describe('platform-extension loaded through the real pi SDK (worker mode)', () => {
  let kernel: FakeKernel;
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  // biome-ignore lint/suspicious/noExplicitAny: spying on process.exit's overloaded signature.
  let exitSpy: any;

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
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    exitSpy.mockRestore();
    await kernel.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'self-drives its one turn via sendUserMessage, registers a gate tool with real isError wiring, and posts report_task_result on report_result',
    { timeout: 10000 },
    async () => {
      kernel.setHandler('list_allowed_operations', () => ({
        ok: true,
        result: {
          operations: [
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

      const fauxProvider = registerFauxProvider();
      const model = fauxProvider.getModel();
      const capturedContexts: Context[] = [];
      fauxProvider.setResponses([
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

      // No test-initiated session.prompt() anywhere in this test — the whole turn below is driven
      // by the real extension's own session_start -> pi.sendUserMessage() call.
      await waitFor(() =>
        kernel.requests.some((request) => request.capability === 'report_task_result'),
      );

      // The tool list is exactly report_result + the one gate tool the Handle's scope allowed
      // (S2.9 acceptance: "工具列表恰好等于 Handle 内的 Operation").
      const toolNames = session.agent.state.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining(['report_result', 'inventory_get']));

      // context injection carried the Task input into the model's first call.
      expect(capturedContexts.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(capturedContexts[0]?.messages)).toContain('check stock levels');
      expect(session.messages.some((message) => message.role === 'custom')).toBe(false);

      // The gate tool's kernel failure really became isError:true through pi's real tool-call
      // wiring (not just "the promise rejected", which a fake-ExtensionAPI stub cannot prove).
      const toolEnds = events.filter(
        (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
          event.type === 'tool_execution_end',
      );
      const gateToolEnd = toolEnds.find((event) => event.toolName === 'inventory_get');
      expect(gateToolEnd?.isError).toBe(true);
      expect(JSON.stringify(gateToolEnd?.result)).toContain('no such gatekeeper');

      // report_result's terminate:true stopped the loop; agent_settled posted the contract exactly
      // once and (mocked) exited the process.
      const reportCalls = kernel.requests.filter(
        (request) => request.capability === 'report_task_result',
      );
      expect(reportCalls).toHaveLength(1);
      expect(reportCalls[0]?.params).toMatchObject({ summary: 'stock check failed' });
      await waitFor(() => exitSpy.mock.calls.length > 0);
      expect(exitSpy).toHaveBeenCalledWith(0);

      session.dispose();
      fauxProvider.unregister();
    },
  );
});
