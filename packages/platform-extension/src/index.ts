import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { EXTENSION_MODE_VALUES, ExtensionModeSchema } from '@nexttime/shared';
import { KernelClient } from './kernel-client.js';
import { registerEntryMode } from './modes/entry.js';
import { registerInteractiveMode } from './modes/interactive.js';
import { registerWorkerMode } from './modes/worker.js';

export { KernelClient, KernelError } from './kernel-client.js';
export type { KernelClientOptions, KernelErrorKind, KernelErrorOptions } from './kernel-client.js';
export { registerEntryMode } from './modes/entry.js';
export type { EntryModeOptions } from './modes/entry.js';
export { registerInteractiveMode } from './modes/interactive.js';
export type { InteractiveModeOptions } from './modes/interactive.js';
export { registerWorkerMode } from './modes/worker.js';
export type { WorkerModeOptions } from './modes/worker.js';

/**
 * @nexttime/platform-extension — the single shared pi extension, driven by `NEXTTIME_MODE`
 * (entry/worker/interactive — design doc §7.4). S1 implemented `entry` mode (./modes/entry.ts);
 * S2.9 added `worker` (./modes/worker.ts); S3.6 (docs/development-tasks.md W2-B) adds
 * `interactive` (./modes/interactive.ts) — a pi/Claude-Code-like client running outside the
 * platform, holding a Handle minted by the human-channel `issue_handle` capability.
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

  const kernelUrl = readRequiredEnv('KERNEL_URL');
  const capabilityHandle = readRequiredEnv('CAPABILITY_HANDLE');
  const kernelClient = new KernelClient({ kernelUrl, capabilityHandle });

  if (mode === 'interactive') {
    // No WORKSPACE_ID: interactive mode never correlates a Turn (modes/interactive.ts's own
    // module doc comment — "默认不回传"), the one thing entry mode needs it for
    // (`pi.appendEntry('nexttime_turn', {workspaceId, ...})`). Every kernel call resolves its
    // workspace server-side from the Handle's own `ws` claim, same as every other mode.
    registerInteractiveMode(pi, { kernelClient });
    return;
  }

  const workspaceId = readRequiredEnv('WORKSPACE_ID');

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
