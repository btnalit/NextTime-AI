import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeAnthropic,
  type FakeAnthropicReply,
  startFakeAnthropic,
} from './test-support/fake-anthropic.js';
import { type FakeKernel, startFakeKernel } from './test-support/fake-kernel.js';

/**
 * Prompt-cache regression (v0.45.0 real-model candidate run: the entry agent's cache read stayed
 * at exactly the system prompt + tools, and every call wrote the whole conversation to the cache
 * again). Loads the real extension through pi's SDK against a fake Anthropic endpoint, so the
 * requests asserted on are the ones the vendored pi-ai (1.1.0) actually builds — including where
 * it puts `cache_control`.
 *
 * A request can only read what an earlier one wrote: the prefix up to that earlier request's
 * breakpoint. So for every pair of consecutive requests in a session this asserts that the system
 * prompt and tools are byte-identical, and that the earlier request's messages up to its
 * breakpoint are repeated byte for byte at the start of the later one — across tool calls within a
 * turn and across turns, with the entry context changing on every call.
 */

const EXTENSION_PATH = join(import.meta.dirname, 'index.ts');
const MODEL_ID = 'claude-cache-test';
const PROVIDER_ID = 'fake-anthropic';

const ENV_KEYS = [
  'NEXTTIME_MODE',
  'KERNEL_URL',
  'CAPABILITY_HANDLE',
  'WORKSPACE_ID',
  'TASK_ID',
] as const;

type Json = Record<string, unknown>;
type Block = Json & { cache_control?: unknown };
type ApiMessage = { role: string; content: string | Block[] };

function messagesOf(request: Json): ApiMessage[] {
  return request.messages as ApiMessage[];
}

/** `[messageIndex, blockIndex]` of every message-level breakpoint. */
function breakpoints(request: Json): [number, number][] {
  const found: [number, number][] = [];
  messagesOf(request).forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.cache_control !== undefined) found.push([messageIndex, blockIndex]);
    });
  });
  return found;
}

/** The request's messages up to and including its breakpoint block, without the marker itself
 *  (a breakpoint marks where a cache entry ends; it is not part of what is matched). */
function cachedPrefix(request: Json): string {
  const [point] = breakpoints(request);
  if (!point) throw new Error('request has no message-level breakpoint');
  const [messageIndex, blockIndex] = point;
  return prefixThrough(request, messageIndex, blockIndex);
}

function prefixThrough(request: Json, messageIndex: number, blockIndex: number): string {
  const messages = messagesOf(request).slice(0, messageIndex + 1);
  const copy = structuredClone(messages);
  const last = copy[copy.length - 1];
  if (last && Array.isArray(last.content)) last.content = last.content.slice(0, blockIndex + 1);
  return JSON.stringify(copy, (key, value) => (key === 'cache_control' ? undefined : value));
}

function stripMarkers(value: unknown): string {
  return JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner));
}

function textOf(message: ApiMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** Every consecutive pair: same system + tools, and the earlier cached prefix is repeated. */
function expectEachRequestReadsThePreviousWrite(requests: readonly Json[]): void {
  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1] as Json;
    const current = requests[index] as Json;
    expect(JSON.stringify(current.system)).toBe(JSON.stringify(previous.system));
    expect(JSON.stringify(current.tools)).toBe(JSON.stringify(previous.tools));
    const prefix = cachedPrefix(previous);
    const [messageIndex] = breakpoints(previous)[0] as [number, number];
    const previousMessages = messagesOf(previous);
    const blockCount = Array.isArray(previousMessages[messageIndex]?.content)
      ? (previousMessages[messageIndex]?.content as Block[]).length
      : 1;
    expect(prefixThrough(current, messageIndex, blockCount - 1)).toBe(prefix);
  }
}

async function sessionAgainst(
  anthropic: FakeAnthropic,
  tmpDir: string,
  bind = false,
): Promise<{ session: AgentSession }> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(PROVIDER_ID, {
    baseUrl: anthropic.url,
    // Synthetic: the fake endpoint never checks it.
    apiKey: 'synthetic-test-key',
    api: 'anthropic-messages',
    models: [
      {
        id: MODEL_ID,
        name: 'Cache test model',
        api: 'anthropic-messages',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 1024,
        baseUrl: anthropic.url,
      },
    ],
  });
  const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
  if (!model) throw new Error('fake model not registered');
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
  // Worker mode drives its own turn from `session_start`, which only `bindExtensions` emits (the
  // way `pi --mode rpc` starts) — see `worker.sdk.test.ts`.
  if (bind) await session.bindExtensions({ mode: 'rpc' });
  return { session };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('prompt cache: what the real pi-ai request repeats between calls', () => {
  let kernel: FakeKernel;
  let anthropic: FakeAnthropic | undefined;
  let session: AgentSession | undefined;
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  // biome-ignore lint/suspicious/noExplicitAny: spying on process.exit's overloaded signature.
  let exitSpy: any;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    tmpDir = mkdtempSync(join(tmpdir(), 'nexttime-prompt-cache-sdk-'));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.KERNEL_URL = kernel.url;
    process.env.CAPABILITY_HANDLE = 'source-bound';
    process.env.WORKSPACE_ID = 'ws-cache-test';
    // Worker mode exits the process once its result is posted; never in a test.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    session = undefined;
  });

  afterEach(async () => {
    session?.dispose();
    exitSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await kernel.close();
    await anthropic?.close();
    anthropic = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Interactive mode injects the same live context the same way (no Turn correlation).
  it.each([
    { mode: 'entry', heading: 'NextTime entry context', turnMarker: true },
    { mode: 'interactive', heading: 'NextTime interactive-session context', turnMarker: false },
  ])(
    '$mode mode: the live context stays last and uncached; every call reads what the previous one wrote, within a turn and across turns',
    async ({ mode, heading, turnMarker }) => {
      process.env.NEXTTIME_MODE = mode;
      // The context changes on every call, as live state does.
      let contextCalls = 0;
      kernel.setHandler('get_entry_context', () => {
        contextCalls += 1;
        return {
          ok: true,
          result: {
            pendingApprovals: [
              { actionRequestId: `ar-${contextCalls}`, title: `Approval ${contextCalls}` },
            ],
            tasks: [],
            facts: [],
            precedents: [],
          },
        };
      });
      kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items: [] } }));
      kernel.setHandler('get_object', () => ({ ok: true, result: { id: 'obj-1', type: 'Host' } }));
      kernel.setHandler('report_turn', () => ({ ok: true, result: {} }));

      const replies: FakeAnthropicReply[] = [
        // Turn 1: a tool call, then the answer.
        { toolUse: { name: 'get_object', input: { objectId: 'obj-1' } } },
        { text: 'obj-1 is a host.' },
        // Turn 2: a tool call, then the answer.
        { toolUse: { name: 'get_object', input: { objectId: 'obj-1' } } },
        { text: 'Still a host.' },
      ];
      anthropic = await startFakeAnthropic(replies);
      ({ session } = await sessionAgainst(anthropic, tmpDir));

      const marker = (turnId: string) => (turnMarker ? `<!--nexttime:turn_id=${turnId}-->\n` : '');
      await session.prompt(`${marker('turn-1')}What is obj-1?`);
      await session.prompt(`${marker('turn-2')}And now?`);

      const requests = anthropic.requests;
      expect(requests).toHaveLength(4);
      for (const [index, request] of requests.entries()) {
        const messages = messagesOf(request);
        // The context is the last message, with the context of this very call, and carries no
        // breakpoint.
        const last = messages[messages.length - 1];
        expect(textOf(last)).toContain(heading);
        expect(textOf(last)).toContain(`Approval ${index + 1}`);
        expect(JSON.stringify(last)).not.toContain('cache_control');
        // Exactly one message-level breakpoint, on the last block before the context.
        const points = breakpoints(request);
        expect(points).toHaveLength(1);
        const [messageIndex, blockIndex] = points[0] as [number, number];
        expect(messageIndex).toBe(messages.length - 2);
        const before = messages[messageIndex];
        expect(Array.isArray(before?.content) && blockIndex).toBe(
          Array.isArray(before?.content) ? before.content.length - 1 : false,
        );
        // No earlier context survives in the history (it is never persisted).
        for (const message of messages.slice(0, -1)) {
          expect(textOf(message)).not.toContain(heading);
        }
      }
      expectEachRequestReadsThePreviousWrite(requests);
    },
  );

  it('worker mode: the Task context sits before the kickoff, identical on every call, so the cached prefix covers it', async () => {
    process.env.NEXTTIME_MODE = 'worker';
    process.env.TASK_ID = 'task-cache-test';
    kernel.setHandler('get_task', () => ({
      ok: true,
      result: { input: 'Check obj-1 and report what it is.' },
    }));
    kernel.setHandler('search', () => ({ ok: true, result: { items: [{ id: 'fact-1' }] } }));
    kernel.setHandler('list_allowed_operations', () => ({
      ok: true,
      result: {
        items: [
          {
            gatekeeperId: 'gk-1',
            gateName: 'inventory',
            name: 'get',
            operation: { mode: 'observe', params_schema: { type: 'object', properties: {} } },
          },
        ],
      },
    }));
    kernel.setHandler('request_action', () => ({
      ok: true,
      result: { status: 'ok', data: { obj1: 'host' } },
    }));
    kernel.setHandler('report_task_result', () => ({
      ok: true,
      result: { status: 'completed' },
    }));

    anthropic = await startFakeAnthropic([
      { toolUse: { name: 'inventory_get', input: {} } },
      { toolUse: { name: 'report_result', input: { summary: 'obj-1 is a host.', findings: [] } } },
    ]);
    ({ session } = await sessionAgainst(anthropic, tmpDir, true));
    // The run is over once worker mode has (mock-)exited — waiting for that also keeps its
    // scheduled `process.exit` from landing after the spy is restored.
    await waitFor(() => exitSpy.mock.calls.length > 0);
    expect(kernel.requests.some((request) => request.capability === 'report_task_result')).toBe(
      true,
    );

    const requests = anthropic.requests;
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const messages = messagesOf(request);
      expect(textOf(messages[0])).toContain('## NextTime worker context');
      expect(textOf(messages[0])).toContain('Check obj-1');
      expect(textOf(messages[1])).toContain('Begin working on your assigned Task');
      // pi-ai's own breakpoint on the last message is a persistent block now.
      const points = breakpoints(request);
      expect(points).toHaveLength(1);
      expect(points[0]?.[0]).toBe(messages.length - 1);
    }
    expect(stripMarkers(messagesOf(requests[1] as Json)[0])).toBe(
      stripMarkers(messagesOf(requests[0] as Json)[0]),
    );
    expectEachRequestReadsThePreviousWrite(requests);
  });
});
