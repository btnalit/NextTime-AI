import { copyFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Whitelist start (STATUS leftover 422, `deploy/worker-runtime/entrypoint.sh`): the entrypoint
 * builds pi's config directory (`PI_CODING_AGENT_DIR`, under `/tmp`) from scratch at every
 * container start — the image's settings (`NEXTTIME_PI_SETTINGS`) and a link to the mounted
 * `models.json` (`NEXTTIME_PI_MODELS`), nothing else. The directory has to stay writable (pi locks
 * its settings there), so the agent's own tools can write into it too, and pi reads it again
 * whenever it replaces its session runtime: a new conversation, a resumed or forked one, a
 * reload. Each of those first shuts the current session down, so this puts the directory back
 * exactly as the entrypoint built it on every `session_shutdown`: whatever the agent wrote there
 * during one conversation never reaches the next. Only in an agent container, where the
 * entrypoint set all three variables.
 */
export function restorePiAgentDirOnSessionShutdown(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const agentDir = env.PI_CODING_AGENT_DIR;
  const settings = env.NEXTTIME_PI_SETTINGS;
  const models = env.NEXTTIME_PI_MODELS;
  if (!agentDir || !settings || !models) return;
  pi.on('session_shutdown', () => {
    try {
      rmSync(agentDir, { recursive: true, force: true });
      mkdirSync(agentDir, { recursive: true });
      copyFileSync(settings, join(agentDir, 'settings.json'));
      symlinkSync(models, join(agentDir, 'models.json'));
    } catch (err) {
      console.error(
        `@nexttime/platform-extension: restoring pi's config directory failed: ${String(err)}`,
      );
    }
  });
}
