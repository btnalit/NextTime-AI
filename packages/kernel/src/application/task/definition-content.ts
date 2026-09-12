import type { PoolClient } from 'pg';
import type { TaskSkillInlineMountInput } from '../../adapters/supervisor-client/index.js';
import { renderSkillMarkdownFile, resolvePublishedSkills } from '../worker/index.js';

/**
 * application/task/definition-content: reads a WorkerDefinition's own content fields
 * (`capabilities`/`gates`/`model`/`skills`) and resolves `skills` to mountable content — shared by
 * `invoke.ts`'s initial spawn and `lifecycle.ts`'s requeue path (P2-10 fix, review job 652a4abc:
 * "requeue omits skillsInline and model"). A standalone file, not exported from either of those
 * two, so `lifecycle.ts` can use it without creating an `invoke.ts` ⇄ `lifecycle.ts` import cycle
 * (`spawn.ts`'s own module doc comment has the full "why a cycle here is a real depcruise
 * violation, not just untidy" rationale — the same reasoning applies to this split).
 */

/** The WorkerDefinition content fields `invoke_worker`/requeue need — a structural subset of
 *  `packages/shared/src/worker-definition.ts`'s `WorkerWorkerDefinitionContent`, read from the
 *  already-parsed `definition` jsonb (this module trusts `publishWorkerDefinition`'s own
 *  `validateWorkerDefinitionContent` call already shaped it correctly at publish time — no
 *  re-validation here). */
export interface WorkerDefinitionContentShape {
  readonly capabilities?: readonly string[];
  readonly gates?: readonly string[];
  readonly model?: string;
  /** P-A2: the WorkerDefinition's own `systemPrompt` (`packages/shared/src/worker-definition.ts`,
   *  required at publish time) — until P-A2 nothing delivered it to the one-shot container, which
   *  ran `entrypoint.sh`'s static default; now `invoke.ts` / `lifecycle.ts` compose it with the
   *  platform's `instanceInstructions` (`application/platform`'s `composeSystemPrompt`) into
   *  `SpawnWorkerRunInput.systemPrompt`. */
  readonly systemPrompt?: string;
  /** `WorkerDefinition --uses--> Skill` (design doc §5.1.2; `packages/shared/src/worker-
   *  definition.ts`'s `skills` field, "published Skill names/ids this WorkerDefinition uses") —
   *  resolved to mountable content by `resolveSkillsInline` below (S2.14 deliverable 4). */
  readonly skills?: readonly string[];
  /** feat/egress-definition-lists: `packages/shared/src/worker-definition.ts`'s `egressDeny`
   *  (now valid on `kind='worker'` content too, not entry-only) — forwarded verbatim by
   *  `spawn.ts`'s callers (`invoke.ts`, `lifecycle.ts`) into `SpawnWorkerRunInput.egressDeny`,
   *  which narrows the spawned WorkerRun container's own egress on top of the platform's fixed
   *  deny list. */
  readonly egressDeny?: readonly string[];
}

export function readDefinitionContent(definition: unknown): WorkerDefinitionContentShape {
  if (!definition || typeof definition !== 'object') return {};
  const record = definition as Record<string, unknown>;
  return {
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((c): c is string => typeof c === 'string')
      : undefined,
    gates: Array.isArray(record.gates)
      ? record.gates.filter((g): g is string => typeof g === 'string')
      : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
    systemPrompt:
      typeof record.systemPrompt === 'string' && record.systemPrompt.length > 0
        ? record.systemPrompt
        : undefined,
    skills: Array.isArray(record.skills)
      ? record.skills.filter((s): s is string => typeof s === 'string')
      : undefined,
    egressDeny: Array.isArray(record.egressDeny)
      ? record.egressDeny.filter((d): d is string => typeof d === 'string')
      : undefined,
  };
}

/**
 * Resolves a WorkerDefinition's declared `skills[]` (id-or-name refs) to **published** Skill rows
 * and renders each into pi's on-disk `SKILL.md` format (S2.14 deliverable 4) — the payload
 * `worker-supervisor`'s `/task/spawn` writes to the Task's workspace directory before the
 * container starts (`skillsInline`, `adapters/supervisor-client/index.ts`'s own doc comment has
 * the full "why inline content, not a host-path bind mount" rationale). A `skills[]` entry that
 * does not resolve to a published Skill is silently skipped — same "best effort, never blocks the
 * caller" convention `application/task/handle-mint.ts`'s `computeChildHandleScope` gate-narrowing
 * uses for a non-execute-class need the caller doesn't hold: a WorkerDefinition referencing a
 * Skill that was since deprecated (or never published) should not make every future
 * `invoke_worker`/requeue call fail.
 */
export async function resolveSkillsInline(
  client: PoolClient,
  workspaceId: string,
  skillRefs: readonly string[],
): Promise<readonly TaskSkillInlineMountInput[]> {
  if (skillRefs.length === 0) return [];
  const skills = await resolvePublishedSkills(client, workspaceId, skillRefs);
  return skills.map((skill) => ({
    name: skill.name,
    files: { 'SKILL.md': renderSkillMarkdownFile(skill) },
  }));
}
