import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { EXTENSION_MODE_VALUES, ExtensionModeSchema } from '@nexttime/shared';
import { KernelClient } from './kernel-client.js';
import { registerEntryMode } from './modes/entry.js';
import { registerWorkerMode } from './modes/worker.js';

export { KernelClient, KernelError } from './kernel-client.js';
export type { KernelClientOptions, KernelErrorKind, KernelErrorOptions } from './kernel-client.js';
export { registerEntryMode } from './modes/entry.js';
export type { EntryModeOptions } from './modes/entry.js';
export { registerWorkerMode } from './modes/worker.js';
export type { WorkerModeOptions } from './modes/worker.js';

/**
 * @nexttime/platform-extension — the single shared pi extension, driven by `NEXTTIME_MODE`
 * (entry/worker/interactive — design doc §7.4). S1 implemented only `entry` mode
 * (./modes/entry.ts); S2.9 adds `worker` (./modes/worker.ts); `interactive` (S3.6) still throws a
 * clear "not implemented yet" error on activation, so a misconfigured container fails loudly
 * instead of silently registering nothing.
 */
export const VERSION = '0.1.0';

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `@nexttime/platform-extension: required environment variable ${name} is not set`,
    );
  }
  return value;
}

/** pi extension default export (docs/extensions.md "Quick Start"): `pi -e platform-extension`
 * calls this once per session with the live `ExtensionAPI`. */
export default function platformExtension(pi: ExtensionAPI): void {
  const parsedMode = ExtensionModeSchema.safeParse(process.env.NEXTTIME_MODE);
  if (!parsedMode.success) {
    throw new Error(
      `@nexttime/platform-extension: NEXTTIME_MODE must be one of ${EXTENSION_MODE_VALUES.join(', ')}, got ` +
        `${JSON.stringify(process.env.NEXTTIME_MODE)}`,
    );
  }
  const mode = parsedMode.data;

  if (mode === 'interactive') {
    throw new Error(
      `@nexttime/platform-extension: NEXTTIME_MODE="interactive" is not implemented yet; see ` +
        'docs/development-tasks.md S3.6.',
    );
  }

  const kernelUrl = readRequiredEnv('KERNEL_URL');
  const capabilityHandle = readRequiredEnv('CAPABILITY_HANDLE');
  const workspaceId = readRequiredEnv('WORKSPACE_ID');

  const kernelClient = new KernelClient({ kernelUrl, capabilityHandle });

  if (mode === 'worker') {
    // S2.8's task-mode spawn spec (packages/worker-supervisor) injects TASK_ID/WORKER_RUN_ID
    // alongside KERNEL_URL/CAPABILITY_HANDLE/WORKSPACE_ID — see that package's own env-var
    // contract; this mode never runs without them.
    const taskId = readRequiredEnv('TASK_ID');
    registerWorkerMode(pi, { kernelClient, workspaceId, taskId });
    return;
  }

  // Documented mechanism (see modes/entry.ts's TURN_ID_MARKER doc comment, and PR body "假设"):
  // NEXTTIME_TURN_ID seeds the turn id used only until the first `input` event carries a fresher
  // one via the RPC `prompt` payload's leading marker line.
  const initialTurnId = process.env.NEXTTIME_TURN_ID || undefined;

  registerEntryMode(pi, { kernelClient, workspaceId, initialTurnId });
}
