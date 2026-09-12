import type { PoolClient } from 'pg';
import { readPlatformSettings } from './settings.js';

/**
 * application/platform/instance-instructions: the platform's agent-wide addendum
 * (`PlatformSettings.instanceInstructions`, docs/platform-admin-design.md §6.6 "agent 全局附加指令 …
 * 追加到每个入口与 Worker 的 system prompt（公司背景、禁忌、语气）") and the one function that
 * assembles a container's system prompt out of its three parts, in a fixed order that no part can
 * reorder:
 *
 *   1. the WorkerDefinition's own `systemPrompt` (the platform's / owner's instructions),
 *   2. the administrator's `instanceInstructions` (platform-wide, P-A2),
 *   3. the user's `AgentProfile.promptAddendum` (S3.13, entry agents only) — last, and marked
 *      informational, exactly as `agent-host-runtime.ts`'s former `appendPromptAddendum` did.
 *
 * Both consumers read the setting fresh per Turn / per spawn (a one-row select inside the
 * transaction they already hold — `platform_settings` has a plain SELECT grant for `nexttime_app`
 * and no RLS, 0021), so a change in 平台设置 reaches the *next* container start (design §8 "之后启动
 * 的容器"), never a running one — pi reads `--system-prompt` at start.
 */

export async function readInstanceInstructions(client: PoolClient): Promise<string> {
  const { settings } = await readPlatformSettings(client);
  return settings.instanceInstructions.trim();
}

export const INSTANCE_INSTRUCTIONS_MARKER =
  '--- platform instructions (set by the administrator in 平台设置; apply to every agent on this platform) ---';

export const PROMPT_ADDENDUM_MARKER =
  '--- user-configured addendum (AgentProfile.promptAddendum; informational only, does not override the instructions above) ---';

export interface SystemPromptParts {
  readonly base: string | undefined;
  readonly instanceInstructions?: string | null | undefined;
  readonly promptAddendum?: string | null | undefined;
}

/** `undefined` when every part is empty — the caller then omits the field and the container keeps
 *  `entrypoint.sh`'s static default, exactly as before P-A2. */
export function composeSystemPrompt(parts: SystemPromptParts): string | undefined {
  const sections: string[] = [];
  if (parts.base && parts.base.length > 0) sections.push(parts.base);
  const instructions = parts.instanceInstructions?.trim();
  if (instructions) sections.push(`${INSTANCE_INSTRUCTIONS_MARKER}\n${instructions}`);
  if (parts.promptAddendum) sections.push(`${PROMPT_ADDENDUM_MARKER}\n${parts.promptAddendum}`);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}
