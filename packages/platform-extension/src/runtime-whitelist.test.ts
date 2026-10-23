import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Whitelist start guard (STATUS leftover 422; docs/runbooks/pi-upgrade.md §2.6): runs the real
 * `deploy/worker-runtime/entrypoint.sh` and the real pinned pi against a scratch directory standing
 * in for the container's `/` (`NEXTTIME_RUNTIME_ROOT`, which the script refuses in an entry or
 * Worker container), and asserts from what pi actually sends to the model that it loads exactly
 * what the platform hands it — its system prompt, its Skills, its extension, the seven built-in
 * tools — and nothing planted in the workspace, in `$HOME`, in the old in-workspace agent
 * directory or in pi's own config directory, before start or mid-conversation. A pi upgrade that
 * adds a new kind of auto-discovered resource should fail here first.
 *
 * The extension is a stand-in (the real one needs a kernel and entry / Worker mode, which the
 * script refuses here) that registers one tool and the real `pi-agent-dir.ts` restore hook.
 *
 * Dropping any one of `--no-context-files`, `--no-extensions`, `--no-skills`,
 * `--no-prompt-templates`, `--append-system-prompt ""`, the restore hook or the rebuild at start
 * fails a test here. Three flags are defence in depth with nothing observable to assert:
 * `--no-themes` (themes only style the interactive UI), `--no-mcp` (pi's MCP client is one of the
 * built-in extensions `--no-extensions` already drops) and `--no-approve` (trust is read from the
 * rebuilt config directory, whose settings never trust a workspace).
 */

const RUNTIME_DIR = join(import.meta.dirname, '..', '..', '..', 'deploy', 'worker-runtime');
const ENTRYPOINT = join(RUNTIME_DIR, 'entrypoint.sh');
const PI_PACKAGE = realpathSync(
  join(import.meta.dirname, '..', 'node_modules', '@earendil-works', 'pi-coding-agent'),
);
const PI_CLI = join(
  PI_PACKAGE,
  (JSON.parse(readFileSync(join(PI_PACKAGE, 'package.json'), 'utf8')) as { bin: { pi: string } })
    .bin.pi,
);
const PI_AGENT_DIR_MODULE = join(import.meta.dirname, 'pi-agent-dir.ts');

const EXPECTED_TOOLS = ['bash', 'edit', 'find', 'grep', 'ls', 'platform_tool', 'read', 'write'];
const PLATFORM_PROMPT = 'PLATFORM_PROMPT_MARKER';
const FOREIGN = /PLANT|MIDLIFE|planted|midlife/;

interface CapturedRequest {
  readonly system: string;
  readonly tools: string[];
}

let root: string;
let server: Server;
let requests: CapturedRequest[];
let children: ChildProcessWithoutNullStreams[];

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const extensionSource = (tool: string) =>
  `export default function (pi) { pi.registerTool({ name: '${tool}', label: '${tool}', description: '${tool}', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'x' }] }; } }); }\n`;
const skillSource = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`;

/** A fake OpenAI-compatible provider that records every request pi sends and answers "ok". */
async function startProvider(): Promise<number> {
  requests = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as {
        messages: { role: string; content: unknown }[];
        tools?: { function: { name: string } }[];
      };
      const system = parsed.messages.find((m) => m.role === 'system' || m.role === 'developer');
      requests.push({
        system: typeof system?.content === 'string' ? system.content : JSON.stringify(system),
        tools: (parsed.tools ?? []).map((t) => t.function.name).sort(),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-echo' };
      chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] });
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** The image's own `/opt/nexttime` under `root`, plus a `pi` on PATH running the pinned CLI.
 *  `restore: false` leaves the restore hook out of the stand-in extension, so a test can show what
 *  pi's flags alone keep out. */
function layOutImage(
  port: number,
  platform: { prompt?: string; skills?: string[]; restore?: boolean },
): void {
  const opt = join(root, 'opt', 'nexttime');
  mkdirSync(opt, { recursive: true });
  copyFileSync(join(RUNTIME_DIR, 'pi-settings.json'), join(opt, 'pi-settings.json'));
  copyFileSync(
    join(RUNTIME_DIR, 'default-system-prompt.md'),
    join(opt, 'default-system-prompt.md'),
  );
  write(
    join(opt, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'source-bound',
          models: [{ id: 'fake-echo' }],
        },
      },
    }),
  );
  write(
    join(opt, 'platform-extension', 'dist', 'index.js'),
    platform.restore === false
      ? extensionSource('platform_tool')
      : `import { restorePiAgentDirOnSessionShutdown } from ${JSON.stringify(PI_AGENT_DIR_MODULE)};\n${extensionSource('platform_tool').replace('{ pi.registerTool', '{ restorePiAgentDirOnSessionShutdown(pi); pi.registerTool')}`,
  );
  mkdirSync(join(opt, 'platform'), { recursive: true });
  if (platform.prompt !== undefined)
    write(join(opt, 'platform', 'system-prompt.md'), platform.prompt);
  for (const name of platform.skills ?? []) {
    write(join(opt, 'platform', 'skills', name, 'SKILL.md'), skillSource(name));
  }
  write(join(root, 'bin', 'pi'), `#!/bin/sh\nexec node ${JSON.stringify(PI_CLI)} "$@"\n`);
  chmodSync(join(root, 'bin', 'pi'), 0o755);
}

/** Everything pi would pick up on its own if discovery were on: in the workspace (cwd and
 *  `$HOME`, persistent and agent-writable), its parent, the agent directory the runtime used to
 *  keep inside the workspace, and a stale copy of pi's config directory from an earlier start. */
function plantBeforeStart(): void {
  const ws = join(root, 'workspace');
  write(join(root, 'AGENTS.md'), 'PLANT_PARENT_AGENTS\n');
  write(join(ws, 'AGENTS.md'), 'PLANT_CWD_AGENTS\n');
  write(join(ws, 'CLAUDE.md'), 'PLANT_CWD_CLAUDE\n');
  write(join(ws, '.pi', 'SYSTEM.md'), 'PLANT_PROJECT_SYSTEM\n');
  write(join(ws, '.pi', 'APPEND_SYSTEM.md'), 'PLANT_PROJECT_APPEND\n');
  // Project settings apply only to a trusted workspace (`--no-approve`); these would narrow the
  // built-in tools.
  write(
    join(ws, '.pi', 'settings.json'),
    JSON.stringify({ extensions: ['./planted.ts'], defaultTools: ['read'] }),
  );
  write(join(ws, '.pi', 'planted.ts'), extensionSource('planted_project_tool'));
  write(join(ws, '.pi', 'extensions', 'p.ts'), extensionSource('planted_project_dir_tool'));
  write(join(ws, '.pi', 'skills', 'planted-project', 'SKILL.md'), skillSource('planted-project'));
  write(join(ws, '.pi', 'prompts', 'planted-prompt.md'), 'PLANT_PROJECT_PROMPT\n');
  write(join(ws, '.agents', 'skills', 'planted-home', 'SKILL.md'), skillSource('planted-home'));
  write(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { planted: { command: 'true' } } }));
  const oldAgentDir = join(ws, '.pi', 'agent');
  write(join(oldAgentDir, 'AGENTS.md'), 'PLANT_OLD_AGENTDIR_AGENTS\n');
  write(join(oldAgentDir, 'APPEND_SYSTEM.md'), 'PLANT_OLD_AGENTDIR_APPEND\n');
  write(join(oldAgentDir, 'extensions', 'old.ts'), extensionSource('planted_old_agentdir_tool'));
  write(join(oldAgentDir, 'skills', 'planted-old', 'SKILL.md'), skillSource('planted-old'));
  write(join(oldAgentDir, 'mcp.json'), JSON.stringify({ mcpServers: { planted: {} } }));
  write(join(oldAgentDir, 'trust.json'), JSON.stringify({ [ws]: true }));
  const staleAgentDir = join(root, 'tmp', 'pi-agent');
  write(join(staleAgentDir, 'AGENTS.md'), 'PLANT_STALE_AGENTDIR_AGENTS\n');
  write(join(staleAgentDir, 'extensions', 'stale.ts'), extensionSource('planted_stale_tool'));
  write(
    join(staleAgentDir, 'settings.json'),
    JSON.stringify({ defaultTools: ['read'], defaultProjectTrust: 'always' }),
  );
}

/** What the agent's own tools could write during a conversation: into the workspace again, and
 *  into pi's (writable) config directory — resources pi would discover there, and settings that
 *  point it at them and trust the workspace. `narrowTools` also narrows the built-in tools, which
 *  no flag covers: only the restore hook undoes that. */
function plantMidConversation({ narrowTools }: { narrowTools: boolean }): void {
  const ws = join(root, 'workspace');
  write(join(ws, 'AGENTS.md'), 'MIDLIFE_CWD_AGENTS\n');
  write(join(ws, '.pi', 'extensions', 'mid.ts'), extensionSource('midlife_project_tool'));
  const agentDir = join(root, 'tmp', 'pi-agent');
  write(join(agentDir, 'AGENTS.md'), 'MIDLIFE_AGENTDIR_AGENTS\n');
  write(join(agentDir, 'APPEND_SYSTEM.md'), 'MIDLIFE_AGENTDIR_APPEND\n');
  write(join(agentDir, 'SYSTEM.md'), 'MIDLIFE_AGENTDIR_SYSTEM\n');
  write(join(agentDir, 'extensions', 'mid.ts'), extensionSource('midlife_agentdir_tool'));
  write(join(agentDir, 'skills', 'midlife-skill', 'SKILL.md'), skillSource('midlife-skill'));
  write(join(agentDir, 'prompts', 'midlife-prompt.md'), 'MIDLIFE_PROMPT_TEMPLATE\n');
  write(
    join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { midlife: { command: 'true' } } }),
  );
  write(join(agentDir, 'trust.json'), JSON.stringify({ [ws]: true }));
  const platformSettings = JSON.parse(
    readFileSync(join(RUNTIME_DIR, 'pi-settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  write(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      ...platformSettings,
      ...(narrowTools ? { defaultTools: ['read'] } : {}),
      extensions: [join(agentDir, 'extensions', 'mid.ts')],
      skills: [join(agentDir, 'skills')],
      prompts: [join(agentDir, 'prompts')],
      defaultProjectTrust: 'always',
    }),
  );
}

interface Runtime {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[];
  request(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  prompt(message: string): Promise<void>;
}

function startEntrypoint(extraEnv: Record<string, string> = {}): Runtime {
  const ws = join(root, 'workspace');
  mkdirSync(ws, { recursive: true });
  const child = spawn('sh', [ENTRYPOINT, '--provider', 'fake', '--model', 'fake-echo'], {
    cwd: ws,
    // Only what the container would have; never this process's own proxy settings.
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: ws,
      PI_OFFLINE: '1',
      NO_PROXY: '*',
      NEXTTIME_RUNTIME_ROOT: root,
      ...extraEnv,
    },
  });
  children.push(child);
  const stdoutLines: string[] = [];
  const waiters: {
    match: (e: Record<string, unknown>) => boolean;
    resolve: (e: Record<string, unknown>) => void;
  }[] = [];
  let buffer = '';
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      stdoutLines.push(line);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const waiter of [...waiters]) {
        if (waiter.match(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const until = (match: (e: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error(`pi did not answer in time; stderr: ${stderr}`)), 30_000);
    });
  let seq = 0;
  return {
    child,
    stdoutLines,
    async request(command) {
      seq += 1;
      const id = `r${seq}`;
      const answer = until((e) => e.id === id);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      return answer;
    },
    async prompt(message) {
      const done = until((e) => e.type === 'agent_end');
      child.stdin.write(`${JSON.stringify({ type: 'prompt', message })}\n`);
      await done;
    },
  };
}

function expectOnlyPlatformResources(request: CapturedRequest | undefined, prompt: string): void {
  expect(request).toBeDefined();
  expect(request?.system).toContain(prompt);
  expect(request?.system).not.toMatch(FOREIGN);
  expect(request?.tools).toEqual(EXPECTED_TOOLS);
}

/** pi's slash commands: Skills, prompt templates and extension commands (pi's built-in
 *  extensions register some, e.g. llama.cpp's `/llama`) — only the platform's Skills. */
function expectOnlyPlatformCommands(answer: Record<string, unknown>, skills: string[]): void {
  const { commands } = answer.data as { commands: { name: string }[] };
  expect(commands.map((c) => c.name).sort()).toEqual(skills.map((name) => `skill:${name}`));
}

/** pi's config directory holds the platform's settings and models.json link, plus only the two
 *  files pi itself creates there at every runtime start (its credential and model stores). */
function expectRebuiltAgentDir(): void {
  const agentDir = join(root, 'tmp', 'pi-agent');
  for (const entry of readdirSync(agentDir)) {
    expect(['auth.json', 'models-store.json', 'models.json', 'settings.json']).toContain(entry);
  }
  expect(readFileSync(join(agentDir, 'settings.json'), 'utf8')).toBe(
    readFileSync(join(RUNTIME_DIR, 'pi-settings.json'), 'utf8'),
  );
}

function exitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => child.on('close', (code) => resolve(code)));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nexttime-runtime-whitelist-'));
  children = [];
});

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe('worker-runtime whitelist start (entrypoint.sh + real pi)', () => {
  it('loads only the platform’s prompt, Skills, extension and built-in tools — at start and in every later conversation', async () => {
    const port = await startProvider();
    layOutImage(port, { prompt: `${PLATFORM_PROMPT}\n`, skills: ['platform-demo'] });
    plantBeforeStart();
    const runtime = startEntrypoint();

    const commandsAtStart = await runtime.request({ type: 'get_commands' });
    await runtime.prompt('hi');
    expect(runtime.stdoutLines).toContain(
      'nexttime-selfcheck check=pi_resource_discovery result=off system_prompt=platform skills=1',
    );
    expectOnlyPlatformResources(requests[0], PLATFORM_PROMPT);
    expect(requests[0]?.system).toContain('platform-demo');
    expectOnlyPlatformCommands(commandsAtStart, ['platform-demo']);
    // The stale copy of pi's config directory was replaced, not reused.
    expectRebuiltAgentDir();

    plantMidConversation({ narrowTools: true });
    const switched = await runtime.request({
      type: 'switch_session',
      sessionPath: join(root, 'workspace', '.pi', 'sessions', 'next-chat.jsonl'),
    });
    expect(switched.success).toBe(true);
    await runtime.prompt('again');
    const commandsAfterSwitch = await runtime.request({ type: 'get_commands' });

    expectOnlyPlatformResources(requests.at(-1), PLATFORM_PROMPT);
    expect(requests.at(-1)?.system).toContain('platform-demo');
    expectOnlyPlatformCommands(commandsAfterSwitch, ['platform-demo']);
    // The restore hook put the directory back as entrypoint.sh built it.
    expectRebuiltAgentDir();
  }, 90_000);

  it('keeps out what the agent writes into pi’s config directory by the flags alone, without the restore hook', async () => {
    const port = await startProvider();
    layOutImage(port, {
      prompt: `${PLATFORM_PROMPT}\n`,
      skills: ['platform-demo'],
      restore: false,
    });
    plantBeforeStart();
    const runtime = startEntrypoint();

    await runtime.prompt('hi');
    plantMidConversation({ narrowTools: false });
    const switched = await runtime.request({
      type: 'switch_session',
      sessionPath: join(root, 'workspace', '.pi', 'sessions', 'next-chat.jsonl'),
    });
    expect(switched.success).toBe(true);
    await runtime.prompt('again');

    expectOnlyPlatformResources(requests.at(-1), PLATFORM_PROMPT);
    expectOnlyPlatformCommands(await runtime.request({ type: 'get_commands' }), ['platform-demo']);
  }, 90_000);

  it('falls back to the image’s default prompt when the platform wrote none, still loading nothing else', async () => {
    const port = await startProvider();
    layOutImage(port, {});
    plantBeforeStart();
    const runtime = startEntrypoint();

    await runtime.prompt('hi');
    expect(runtime.stdoutLines).toContain(
      'nexttime-selfcheck check=pi_resource_discovery result=off system_prompt=default skills=0',
    );
    const defaultPrompt = readFileSync(join(RUNTIME_DIR, 'default-system-prompt.md'), 'utf8');
    expectOnlyPlatformResources(requests[0], defaultPrompt.split('\n')[0] ?? '');
  }, 90_000);

  it.each(['entry', 'worker'])(
    'refuses to start in %s mode when the test-only root is set',
    async (mode) => {
      layOutImage(1, { prompt: `${PLATFORM_PROMPT}\n` });
      const runtime = startEntrypoint({ NEXTTIME_MODE: mode });
      expect(await exitCode(runtime.child)).toBe(1);
      expect(runtime.stdoutLines).toContain(
        'nexttime-selfcheck check=runtime_root result=fail reason=test_only_variable_set',
      );
    },
    30_000,
  );
});
