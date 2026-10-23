import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { InMemoryCredentialStore, getCurrentTools } from '@earendil-works/pi-ai';
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

// The real extension module's own file path (loaded by pi's jiti-based extension loader — see
// PR body "假设": the published @earendil-works/pi-coding-agent@0.84.4 does not export
// `loadExtensionFromFactory` that its own docs/repo reference, so `additionalExtensionPaths`
// (the documented `-e`/`pi -e ./path.ts` mechanism, §"Extension Locations") is used instead to
// load the real `index.ts` — still the real module, not a mock, just via a different public hook).
const EXTENSION_PATH = join(import.meta.dirname, 'index.ts');

/**
 * The one required real-SDK test (task brief: "at least one test must load the real extension
 * module through pi's SDK ... assert the five tools are registered ... and that `context`
 * injection produces the message"). Also exercises the two things a fake-`ExtensionAPI`-stub test
 * cannot: pi's real isError wiring (kernel-client.test.ts/modes/entry.test.ts only prove the
 * extension *throws*, not that pi turns that into `isError: true`) and that the injected `context`
 * message never lands in the persisted session (non-persisted per pi semantics, §7.2).
 */

const REQUIRED_ENTRY_ENV = {
  NEXTTIME_MODE: 'entry',
  KERNEL_URL: '', // filled in per-test once the fake kernel is listening
  CAPABILITY_HANDLE: 'sdk-test-handle',
  WORKSPACE_ID: 'ws-sdk-test',
} as const;

const ENV_KEYS = Object.keys(REQUIRED_ENTRY_ENV);

describe('platform-extension loaded through the real pi SDK (entry mode)', () => {
  let kernel: FakeKernel;
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    tmpDir = mkdtempSync(join(tmpdir(), 'nexttime-platform-extension-sdk-'));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.NEXTTIME_MODE = 'entry';
    process.env.KERNEL_URL = kernel.url;
    process.env.CAPABILITY_HANDLE = REQUIRED_ENTRY_ENV.CAPABILITY_HANDLE;
    process.env.WORKSPACE_ID = REQUIRED_ENTRY_ENV.WORKSPACE_ID;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await kernel.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the five S1 tools, injects context, maps tool errors to isError, and reports each turn', async () => {
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
    kernel.setHandler('report_turn', () => ({ ok: true, result: {} }));

    // --- Faux model + a real, publicly-registered provider (mirrors @earendil-works/pi-coding-agent's
    // own test harness, entirely through public API: registerFauxProvider (pi-ai/compat) +
    // ModelRuntime.registerProvider). ---
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

    // --- Load the *real* extension module (not a mock) through the SDK's documented
    // `additionalExtensionPaths` hook (the `-e`/`pi -e ./path.ts` mechanism), with `noExtensions`
    // so nothing else on this machine's real ~/.pi or project .pi gets discovered too. ---
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

    // 1. The five S1 observe tools are registered and active.
    const toolNames = session.agent.state.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['get_object', 'traverse', 'search', 'explain', 'get_task']),
    );

    // 2. Turn 1: context injection produces the message sent to the model.
    await session.prompt('<!--nexttime:turn_id=turn-1-->\nHello, what can you help with?');

    expect(capturedContexts.length).toBeGreaterThanOrEqual(1);
    const firstCallText = JSON.stringify(capturedContexts[0]?.messages);
    expect(firstCallText).toContain('Restart the flaky container');
    expect(firstCallText).toContain('Pending approvals');

    // The injected context message is never persisted (§7.2 "non-persisted per pi semantics").
    expect(session.messages.some((message) => message.role === 'custom')).toBe(false);

    // report_turn fired once for turn 1, carrying its turn id.
    const reportsAfterTurn1 = kernel.requests.filter(
      (request) => request.capability === 'report_turn',
    );
    expect(reportsAfterTurn1).toHaveLength(1);
    expect(reportsAfterTurn1[0]?.params).toMatchObject({ turnId: 'turn-1' });

    // 3. Turn 2: the model calls get_object, the fake kernel errors, and pi maps it to isError.
    await session.prompt('<!--nexttime:turn_id=turn-2-->\nWhat do you know about obj-1?');

    const toolEnds = events.filter(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end',
    );
    const getObjectEnd = toolEnds.find((event) => event.toolName === 'get_object');
    expect(getObjectEnd?.isError).toBe(true);
    expect(JSON.stringify(getObjectEnd?.result)).toContain('no such object');

    // report_turn fired again for turn 2.
    const reportsAfterTurn2 = kernel.requests.filter(
      (request) => request.capability === 'report_turn',
    );
    expect(reportsAfterTurn2).toHaveLength(2);
    expect(reportsAfterTurn2[1]?.params).toMatchObject({ turnId: 'turn-2' });

    session.dispose();
    fauxProvider.unregister();
  });

  /**
   * 收尾波次 C3: the per-turn projection through pi's *real* tool registry and request builder —
   * what the fake-`ExtensionAPI` tests in `modes/entry.test.ts` can only assume. Each provider
   * request's tool declarations are replayed from its transcript (`getCurrentTools`, pi-ai 0.87:
   * tools travel as `toolsAdded`/`toolsRemoved` on system messages), so this asserts exactly what
   * the model was offered on each turn. Built-ins are configured the way the entry runtime does it
   * (`defaultTools` in pi's settings, `deploy/worker-runtime/entrypoint.sh`), and the session is
   * bound like `pi --mode rpc` binds it, so `session_start` runs too.
   */
  it('per-turn projection: a gate tool appears and disappears between prompts in one session, built-ins untouched', async () => {
    const builtins = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
    const gateRow = (gatekeeperId: string, gateName: string, name: string) => ({
      gatekeeperId,
      gateName,
      name,
      operation: { mode: 'observe', params_schema: { type: 'object', properties: {} } },
    });
    let items: unknown[] = [gateRow('gk-1', 'accept_s2_api', 'stock.get')];
    kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items } }));
    kernel.setHandler('get_entry_context', () => ({ ok: true, result: {} }));
    kernel.setHandler('report_turn', () => ({ ok: true, result: {} }));
    kernel.setHandler('observe_operation', () => ({
      ok: true,
      result: { status: 'ok', data: { kbs: ['ops'] } },
    }));

    const fauxProvider = registerFauxProvider();
    const model = fauxProvider.getModel();
    const offered: string[][] = [];
    const record = (context: { messages: readonly { role: string }[] }) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
    };
    fauxProvider.setResponses([
      // turn-1: one request.
      (context) => {
        record(context);
        return fauxAssistantMessage('Hello.');
      },
      // turn-2: the model calls the tool that only just appeared, then answers.
      (context) => {
        record(context);
        return fauxAssistantMessage(fauxToolCall('ragflow_kb_list', {}), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        record(context);
        return fauxAssistantMessage('One knowledge base: ops.');
      },
      // turn-3 (kernel failing): one request.
      (context) => {
        record(context);
        return fauxAssistantMessage('Still here.');
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

    const settingsManager = SettingsManager.inMemory({ defaultTools: builtins });
    const resourceLoader = new DefaultResourceLoader({
      cwd: tmpDir,
      agentDir: tmpDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [EXTENSION_PATH],
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);

    const { session } = await createAgentSession({
      cwd: tmpDir,
      agentDir: tmpDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(tmpDir),
      settingsManager,
    });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.bindExtensions({ mode: 'rpc' });

    // session_start projected the one allowed Operation.
    expect(session.getActiveToolNames()).toContain('accept_s2_api_stock_get');

    // turn-1: unchanged list — the model is offered built-ins, static tools and the gate tool.
    await session.prompt('<!--nexttime:turn_id=turn-1-->\nHi');
    expect(offered[0]).toEqual(
      expect.arrayContaining([...builtins, 'get_object', 'invoke_worker']),
    );
    expect(offered[0]).toContain('accept_s2_api_stock_get');

    // turn-2: gk-1's Operation is no longer allowed, gk-2's is — no restart, no new session.
    items = [gateRow('gk-2', 'ragflow', 'kb.list')];
    await session.prompt('<!--nexttime:turn_id=turn-2-->\nWhich knowledge bases exist?');
    for (const tools of [offered[1], offered[2]]) {
      expect(tools).toEqual(expect.arrayContaining([...builtins, 'get_object', 'ragflow_kb_list']));
      expect(tools).not.toContain('accept_s2_api_stock_get');
    }
    const kbEnd = events.find(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end' && event.toolName === 'ragflow_kb_list',
    );
    expect(kbEnd?.isError).toBe(false);
    expect(
      kernel.requests.find((request) => request.capability === 'observe_operation')?.params,
    ).toEqual({ gatekeeperId: 'gk-2', operation: 'kb.list', params: {} });
    // The change is recorded in the transcript as a system-message delta (what the host runbook
    // greps in the session JSONL): the new tool added, the old one removed, nothing else.
    const deltas = session.messages.filter(
      (message): message is Extract<typeof message, { role: 'system' }> =>
        message.role === 'system' &&
        (message.toolsAdded !== undefined || message.toolsRemoved !== undefined),
    );
    const turn2Delta = deltas.find((message) =>
      message.toolsAdded?.some((tool) => tool.name === 'ragflow_kb_list'),
    );
    expect(turn2Delta?.toolsAdded?.map((tool) => tool.name)).toEqual(['ragflow_kb_list']);
    expect(turn2Delta?.toolsRemoved?.map((tool) => tool.name)).toEqual(['accept_s2_api_stock_get']);

    // turn-3: the kernel read fails — the previous set is kept, not dropped to zero.
    kernel.setHandler('list_allowed_operations', () => ({
      ok: false,
      error: { code: 'internal', message: 'db unavailable' },
    }));
    await session.prompt('<!--nexttime:turn_id=turn-3-->\nStill there?');
    expect(offered[3]).toEqual(expect.arrayContaining([...builtins, 'ragflow_kb_list']));
    expect(offered[3]).not.toContain('accept_s2_api_stock_get');

    // One list_allowed_operations read at session_start plus one per prompt — none per request.
    expect(
      kernel.requests.filter((request) => request.capability === 'list_allowed_operations'),
    ).toHaveLength(4);

    session.dispose();
    fauxProvider.unregister();
  });

  /**
   * S11 GO5e-1: the goal tools through pi's *real* tool registry. The model is offered
   * `propose_goal` (its plan's self-containing predicate schemas included) and its call reaches the
   * kernel as written; confirming is the person's, so `confirm_goal` is never offered, and a model
   * that calls it anyway gets pi's own tool error — the kernel never hears of it.
   */
  it('offers propose_goal and passes its plan to the kernel; confirm_goal is no tool', async () => {
    kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items: [] } }));
    kernel.setHandler('get_entry_context', () => ({ ok: true, result: {} }));
    kernel.setHandler('report_turn', () => ({ ok: true, result: {} }));
    kernel.setHandler('propose_goal', () => ({
      ok: true,
      result: {
        goalRunId: 'goal-1',
        status: 'proposed',
        changed: true,
        planRevisionId: 'revision-1',
        hints: [],
      },
    }));

    const proposal = {
      statement: 'Restart the flaky container and confirm the stock API answers.',
      plan: {
        steps: [
          {
            key: 'restart',
            worker: { definitionId: '11111111-1111-4111-8111-111111111111', version: 1 },
            input: 'Restart the flaky container.',
          },
        ],
        acceptance: [
          {
            kind: 'observe_predicate',
            key: 'stock-visible',
            check: {
              gatekeeperId: '22222222-2222-4222-8222-222222222222',
              operation: 'stock.get',
              params: {},
              expect: { all: [{ path: 'symbol', op: 'eq', value: 'NXT' }] },
            },
          },
        ],
      },
      budget: { maxTokens: 200000, maxSteps: 3, maxRevisions: 1, maxWallClockSeconds: 1800 },
      idempotencyKey: 'restart-and-check',
    };

    const fauxProvider = registerFauxProvider();
    const model = fauxProvider.getModel();
    const offered: string[][] = [];
    fauxProvider.setResponses([
      (context) => {
        offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return fauxAssistantMessage(fauxToolCall('propose_goal', proposal), {
          stopReason: 'toolUse',
        });
      },
      () =>
        fauxAssistantMessage(fauxToolCall('confirm_goal', { goalRunId: 'goal-1', revision: 1 }), {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage('Proposed — please confirm it in the console under Goals.'),
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

    await session.prompt(
      '<!--nexttime:turn_id=turn-1-->\nRestart it and keep at it until the API answers.',
    );

    expect(offered[0]).toEqual(
      expect.arrayContaining(['propose_goal', 'get_goal', 'list_goals', 'get_goal_revision']),
    );
    expect(offered[0]).not.toContain('confirm_goal');

    const proposeEnd = events.find(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end' && event.toolName === 'propose_goal',
    );
    expect(proposeEnd?.isError).toBe(false);
    expect(
      kernel.requests.find((request) => request.capability === 'propose_goal')?.params,
    ).toEqual(proposal);

    const confirmEnd = events.find(
      (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
        event.type === 'tool_execution_end' && event.toolName === 'confirm_goal',
    );
    expect(confirmEnd?.isError).toBe(true);
    expect(kernel.requests.some((request) => request.capability === 'confirm_goal')).toBe(false);

    session.dispose();
    fauxProvider.unregister();
  });
});
