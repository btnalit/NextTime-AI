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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeKernel, startFakeKernel } from './test-support/fake-kernel.js';

/**
 * The real-SDK test for `interactive` mode (same pattern `entry.sdk.test.ts` established, task
 * brief S3.6: "tests with the real pi SDK pattern the repo already uses"). Loads the real
 * `index.ts` extension module through pi's own `additionalExtensionPaths` hook, with
 * `NEXTTIME_MODE=interactive` and no `WORKSPACE_ID` (interactive mode does not require it — see
 * `modes/interactive.ts`'s own module doc comment). Proves the same two things `entry.sdk.test.ts`
 * proves that a fake-`ExtensionAPI`-stub test cannot — pi's real `isError` wiring, and that the
 * injected `context` message never lands in the persisted session — plus interactive mode's own
 * distinguishing behavior: no `report_turn` call ever fires, even across multiple prompts (§7.4
 * "默认不回传").
 */

const EXTENSION_PATH = join(import.meta.dirname, 'index.ts');

const REQUIRED_INTERACTIVE_ENV = {
  NEXTTIME_MODE: 'interactive',
  KERNEL_URL: '', // filled in per-test once the fake kernel is listening
  CAPABILITY_HANDLE: 'sdk-test-interactive-handle',
} as const;

const ENV_KEYS = [...Object.keys(REQUIRED_INTERACTIVE_ENV), 'WORKSPACE_ID'] as const;

describe('platform-extension loaded through the real pi SDK (interactive mode)', () => {
  let kernel: FakeKernel;
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    tmpDir = mkdtempSync(join(tmpdir(), 'nexttime-platform-extension-interactive-sdk-'));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.NEXTTIME_MODE = 'interactive';
    process.env.KERNEL_URL = kernel.url;
    process.env.CAPABILITY_HANDLE = REQUIRED_INTERACTIVE_ENV.CAPABILITY_HANDLE;
    // Interactive mode needs no WORKSPACE_ID (modes/interactive.ts's own module doc comment) —
    // explicitly unset it so a value leaked from another test/the ambient shell never makes this
    // one accidentally pass. Computed-key delete via the ENV_KEYS loop var (not a literal
    // `delete process.env.WORKSPACE_ID`) matches this file's own `afterEach` below and
    // index.test.ts's cleanup loop, for the same reason: assigning `undefined` would coerce to
    // the *string* "undefined" via `process.env`'s setter, not truly unset the var.
    for (const key of ENV_KEYS) {
      if (!(key in REQUIRED_INTERACTIVE_ENV)) delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await kernel.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the entry-equivalent tools, injects context, maps tool errors to isError, and never reports a Turn', async () => {
    kernel.setHandler('get_entry_context', () => ({
      ok: true,
      result: {
        pendingApprovals: [{ actionRequestId: 'ar-1', title: 'Restart the flaky container' }],
        tasks: [],
        facts: [],
        precedents: [],
      },
    }));
    kernel.setHandler('get_object', () => ({
      ok: false,
      error: { code: 'not_found', message: 'no such object' },
    }));

    const fauxProvider = registerFauxProvider();
    const model = fauxProvider.getModel();
    const capturedContexts: Context[] = [];
    fauxProvider.setResponses([
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage('Sure, I will look into it.');
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(fauxToolCall('get_object', { objectId: 'obj-1' }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage('Could not find obj-1.');
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

    // 1. The same tool set entry mode registers.
    const toolNames = session.agent.state.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['get_object', 'traverse', 'search', 'explain', 'get_task']),
    );

    // 2. Turn 1: context injection produces the message sent to the model — no turn_id marker
    // prefix needed (interactive mode never extracts one).
    await session.prompt('Hello, what can you help with?');

    expect(capturedContexts.length).toBeGreaterThanOrEqual(1);
    const firstCallText = JSON.stringify(capturedContexts[0]?.messages);
    expect(firstCallText).toContain('Restart the flaky container');
    expect(firstCallText).toContain('Pending approvals');

    // The injected context message is never persisted (§7.2 "non-persisted per pi semantics").
    expect(session.messages.some((message) => message.role === 'custom')).toBe(false);

    // 3. Turn 2: the model calls get_object, the fake kernel errors, and pi maps it to isError.
    await session.prompt('What do you know about obj-1?');

    const toolEnds = events.filter(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end',
    );
    const getObjectEnd = toolEnds.find((event) => event.toolName === 'get_object');
    expect(getObjectEnd?.isError).toBe(true);
    expect(JSON.stringify(getObjectEnd?.result)).toContain('no such object');

    // 4. §7.4 "默认不回传" — across both turns, report_turn is never called.
    expect(kernel.requests.some((request) => request.capability === 'report_turn')).toBe(false);

    session.dispose();
    fauxProvider.unregister();
  });
});
