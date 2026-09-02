import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { EXTENSION_MODE_VALUES, ExtensionModeSchema } from '@nexttime/shared';
import { KernelClient } from './kernel-client.js';
import { registerEntryMode } from './modes/entry.js';

export { KernelClient, KernelError } from './kernel-client.js';
export type { KernelClientOptions, KernelErrorKind, KernelErrorOptions } from './kernel-client.js';
export { registerEntryMode } from './modes/entry.js';
export type { EntryModeOptions } from './modes/entry.js';

/**
 * @nexttime/platform-extension — the single shared pi extension, driven by `NEXTTIME_MODE`
 * (entry/worker/interactive — design doc §7.4). S1 implements only `entry` mode
 * (./modes/entry.ts); `worker` (S2.9) and `interactive` (S3.6) throw a clear
 * "not implemented in S1" error on activation, so a misconfigured container fails loudly instead
 * of silently registering nothing.
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

  if (mode !== 'entry') {
    const followUpTask = mode === 'worker' ? 'S2.9' : 'S3.6';
    throw new Error(
      `@nexttime/platform-extension: NEXTTIME_MODE="${mode}" is not implemented in S1 (only "entry" is ` +
        `available); see docs/development-tasks.md S1.6/${followUpTask}.`,
    );
  }

  const kernelUrl = readRequiredEnv('KERNEL_URL');
  const capabilityHandle = readRequiredEnv('CAPABILITY_HANDLE');
  const workspaceId = readRequiredEnv('WORKSPACE_ID');
  // Documented mechanism (see modes/entry.ts's TURN_ID_MARKER doc comment, and PR body "假设"):
  // NEXTTIME_TURN_ID seeds the turn id used only until the first `input` event carries a fresher
  // one via the RPC `prompt` payload's leading marker line.
  const initialTurnId = process.env.NEXTTIME_TURN_ID || undefined;

  const kernelClient = new KernelClient({ kernelUrl, capabilityHandle });

  registerEntryMode(pi, { kernelClient, workspaceId, initialTurnId });
}
