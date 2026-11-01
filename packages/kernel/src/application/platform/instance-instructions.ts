import type { PoolClient } from 'pg';
import { readPlatformSettings } from './settings.js';

/**
 * application/platform/instance-instructions: the platform's agent-wide addendum
 * (`PlatformSettings.instanceInstructions`, docs/platform-admin-design.md §6.6 "agent 全局附加指令 …
 * 追加到每个入口与 Worker 的 system prompt（公司背景、禁忌、语气）") and the one function that
 * assembles a container's system prompt out of its parts, in a fixed order that no part can
 * reorder:
 *
 *   1. the WorkerDefinition's own `systemPrompt` (the platform's / owner's instructions),
 *   2. S11 GO8a, a goal step's responsibility (its WorkerSpec's `instructions`, goal steps only) —
 *      after the definition's, which it adds to and never replaces, and marked as such,
 *   2b. S11 GO14, the platform's note on files between a goal's steps (goal step attempts only):
 *      where to leave files for later steps, and where the files the plan says this step reads
 *      are mounted (`application/goal/step-files.ts`),
 *   3. the administrator's `instanceInstructions` (platform-wide, P-A2),
 *   4. the user's `AgentProfile.promptAddendum` (S3.13, entry agents only) — last, and marked
 *      informational, exactly as `agent-host-runtime.ts`'s former `appendPromptAddendum` did.
 *
 * Both consumers read the setting fresh per Turn / per spawn (a one-row select inside the
 * transaction they already hold — `platform_settings` has a SELECT grant for `nexttime_app`, 0021,
 * and a read-all RLS policy, 0035), so a change in 平台设置 reaches the *next* container start
 * (design §8 "之后启动的容器"), never a running one — pi reads `--system-prompt` at start.
 */

export async function readInstanceInstructions(client: PoolClient): Promise<string> {
  const { settings } = await readPlatformSettings(client);
  return settings.instanceInstructions.trim();
}

export const INSTANCE_INSTRUCTIONS_MARKER =
  '--- platform instructions (set by the administrator in 平台设置; apply to every agent on this platform) ---';

export const STEP_INSTRUCTIONS_MARKER =
  "--- this goal step's responsibility (the confirmed plan's WorkerSpec; adds to the instructions above, never replaces them) ---";

export const STEP_FILES_MARKER = "--- files between this goal's steps (set by the platform) ---";

/** S11 GO14: where a goal step's Worker leaves files for later steps (worker-supervisor
 *  `upstream-files.ts` `HANDOFF_DIR_NAME`, under the Worker's `/workspace`). */
export const STEP_HANDOFF_DIR = '/workspace/out';

/** S11 GO14: where the files of step `stepKey` are mounted (worker-supervisor
 *  `upstreamMountTarget`). */
export function upstreamFilesPath(stepKey: string): string {
  return `/upstream/${stepKey}`;
}

export const PROMPT_ADDENDUM_MARKER =
  '--- user-configured addendum (AgentProfile.promptAddendum; informational only, does not override the instructions above) ---';

export interface SystemPromptParts {
  readonly base: string | undefined;
  /** S11 GO8a: a goal step's WorkerSpec `instructions`. */
  readonly stepInstructions?: string | null | undefined;
  /** S11 GO14: for a goal step's attempt, the steps whose files it reads (none: an empty list —
   *  it is still told where to leave its own). Absent for every other container. */
  readonly stepFiles?: { readonly readsFrom: readonly string[] } | undefined;
  readonly instanceInstructions?: string | null | undefined;
  readonly promptAddendum?: string | null | undefined;
}

/** `undefined` when every part is empty — the caller then omits the field and the container keeps
 *  `entrypoint.sh`'s static default, exactly as before P-A2. */
export function composeSystemPrompt(parts: SystemPromptParts): string | undefined {
  const sections: string[] = [];
  if (parts.base && parts.base.length > 0) sections.push(parts.base);
  const step = parts.stepInstructions?.trim();
  if (step) sections.push(`${STEP_INSTRUCTIONS_MARKER}\n${step}`);
  if (parts.stepFiles) sections.push(stepFilesSection(parts.stepFiles.readsFrom));
  const instructions = parts.instanceInstructions?.trim();
  if (instructions) sections.push(`${INSTANCE_INSTRUCTIONS_MARKER}\n${instructions}`);
  if (parts.promptAddendum) sections.push(`${PROMPT_ADDENDUM_MARKER}\n${parts.promptAddendum}`);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

/** The step files section of a goal step attempt's prompt, reading `readsFrom`'s files. */
export function stepFilesSection(readsFrom: readonly string[]): string {
  const lines = [
    STEP_FILES_MARKER,
    `Put any file a later step of this goal should read in ${STEP_HANDOFF_DIR}. Only that directory is handed on; the rest of /workspace stays with this step.`,
  ];
  if (readsFrom.length > 0) {
    lines.push('The files earlier steps of this goal left for this one (read-only):');
    for (const key of readsFrom) lines.push(`- step ${key}: ${upstreamFilesPath(key)}`);
  }
  return lines.join('\n');
}
