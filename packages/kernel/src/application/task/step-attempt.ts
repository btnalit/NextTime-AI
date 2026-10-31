import { createHash } from 'node:crypto';
import { canonicalJson } from '@nexttime/gatekeeper-base';
import type { CapabilityScope, OutputSchema, WorkerSpec } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import {
  readAgentProfile,
  readEffectiveAgentProfile,
} from '../../governance/agent-profile/index.js';
import { WORKER_CEILING_CAPABILITIES, entryScope } from '../../governance/capability/index.js';
import { hasActiveSealHold } from '../eval-seal/index.js';
import { entryGatekeeperIds, readExecuteAccess } from '../gates/execute-access.js';
import {
  composeSystemPrompt,
  readInstanceInstructions,
} from '../platform/instance-instructions.js';
import { resolveActiveRuntimeImage } from '../platform/runtime.js';
import {
  type DraftViewer,
  type WorkerDefinitionRow,
  classifySkillRefs,
  getWorkerDefinition,
} from '../worker/index.js';
import {
  type ResolvedRunSkills,
  readDefinitionContent,
  resolvePinnedSkillsInline,
  resolveSkillsInline,
} from './definition-content.js';
import type { RunConfigSnapshot } from './goal-step.js';
import { computeChildHandleScope, defaultWorkerCapabilities } from './handle-mint.js';
import { failTaskAndReapWorkerRuns } from './lifecycle.js';
import { normalizeObserveScope } from './observe-scope.js';
import type { ReworkOf } from './output-contract.js';
import { assertTaskQuotas, lockTaskQuotas } from './quota-check.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { type SpawnWorkerRunInput, spawnWorkerRun } from './spawn.js';
import { recordTaskTransition } from './transition-log.js';
import {
  InvokeWorkerAttenuationError,
  InvokeWorkerValidationError,
  QuotaExceededError,
  type QuotaViolationCode,
  TASK_ROW_COLUMNS,
  type TaskRow,
  mapTaskRow,
} from './types.js';

/**
 * application/task/step-attempt (S11 GO2; plan §4.4, I-G1, I-G7): the goal advancer's way to start
 * one attempt of a step — the same Task the `invoke_worker` path creates (`invoke.ts`), created in
 * two halves around the advancer's transaction:
 *
 *   1. {@link createStepAttemptTask} runs inside the transaction that moves the StepRun
 *      `ready → running` (I-G1: the attempt's Task and its StepRun transition commit together, or
 *      neither does). It resolves what the attempt runs with, checks the requester's authority and
 *      I18 quotas under the same per-principal lock as `invoke_worker`, and inserts the Task
 *      `queued` with its goal step, attempt number and configuration snapshot. It writes nothing
 *      when it refuses.
 *   2. {@link startStepAttemptTask} runs after that commit: it spawns the WorkerRun and moves the
 *      Task to `running`, exactly as `invokeWorkerCreate`'s tail does (the Worker's Handle must be
 *      committed before the container uses it — see `invoke.ts`'s module doc comment). A kernel
 *      that dies between the two leaves a `queued` Task, which the reaper fails `spawn_lost`; the
 *      advancer then sees a transient failure and starts the next attempt.
 *
 * Authority (I-G7): the parent of the attempt's Handle is the requester's entry scope **now** —
 * `entryScope` over `entryGatekeeperIds(readExecuteAccess(...))`, what their entry agent would be
 * minted with this minute — never a scope captured at confirmation. A step's Handle carries no
 * `invoke_worker` / `find_workers` unless its plan entry says `nested` (§4.4: teams are the
 * advancer's). Unlike `invoke_worker`, which leaves out an observe-only gate the caller does not
 * hold, an attempt whose WorkerDefinition declares a gate the requester can no longer act on does
 * not start: the plan the requester confirmed needs it, so the goal pauses `authority_lost` for a
 * person (scenario S9) instead of running a narrower Worker than the one planned.
 *
 * Pinned configuration (§4.4 "新尝试读快照"): the first attempt resolves the WorkerDefinition version
 * the plan names, the Skills it uses (latest published, as `invoke_worker` does), the model (the
 * definition's, else the requester's effective one) and the platform runtime image; a later attempt
 * reuses those from the previous attempt's snapshot. A version that is no longer published — the
 * definition or any Skill — refuses the attempt (`unavailable`). The platform's instance
 * instructions are read fresh for every attempt (platform policy, not the step's configuration);
 * the snapshot keeps the composed prompt's digest so a reviewer can tell attempts apart.
 *
 * The attempt's Task budget is the workspace default capped by what is left of the goal's
 * (`tokenCap`, `durationCapSec`), so one attempt cannot spend far past the GoalRun's I-G6 budget.
 *
 * S11 GO8a (plan §3.1, I-G8): a plan entry may carry a WorkerSpec (`spec`) — the definition as a
 * base with what the step sets differently. Its `capabilities` and `gates` replace the
 * definition's declaration before the Handle is narrowed, so they meet the same check as a
 * definition's: within the Worker ceiling and the requester's scope now, an execute-class one or a
 * gate they lack refusing the attempt (`authority_lost`) — a WorkerSpec only ever narrows what the
 * attempt may hold. Its components are admitted when the first attempt starts
 * ({@link workerSpecComponentRefusals}, the one rule the confirmation card's hints apply too):
 * every Skill it names published (a draft one waits for a person — `needs_approval`, approved by
 * S11 GO8b; a deprecated one is refused), its model one the llm-proxy catalog offers and the
 * workspace allows (legacy 302's rule for a WorkerDefinition's model, and `allowedModels`); then its
 * `instructions` follow the definition's prompt (`composeSystemPrompt`), its `tokenBudget` caps the
 * attempt's, and its `observeScope` is the Task's observation scope (S11 GO11). The snapshot keeps
 * the WorkerSpec's digest (version 2): a later attempt starts only for the same WorkerSpec — a
 * revision that changes it is a new StepRun, admitted afresh — and reuses the Skills the first one
 * resolved without admitting them again; its authority and its model ({@link
 * workerSpecModelRefusal}: offered and allowed now) are checked every time.
 *
 * S10 E3-2c (legacy 514): no attempt starts while the evaluation seal pauses the agents acting for
 * the requester (`paused`) — the Worker start would be refused anyway (`spawnWorkerRun`), and that
 * failure would read transient and spend the step's attempts. A person decides once the workspace
 * owner released the pause; nothing resumes by itself.
 */

export type StepAttemptRefusal =
  /** The requester cannot start this step now: disabled, no longer allowed to start Workers
   *  (`requester`), missing a gate the step's WorkerDefinition declares (`gates`, listed in
   *  `gatekeeperIds`) or an execute-class capability it declares (`capability`) — I-G7. */
  | {
      readonly kind: 'authority_lost';
      readonly reason: 'requester' | 'gates' | 'capability';
      readonly detail: string;
      readonly gatekeeperIds?: readonly string[];
      /** `capability`: the execute-class capabilities the requester does not hold. */
      readonly capabilityNames?: readonly string[];
    }
  /** What the step is pinned to cannot run: the WorkerDefinition (`definition`) or a Skill version
   *  (`skills`) is no longer published — or, for its first attempt, a Skill its WorkerSpec names
   *  is not there — or the requester's own AgentProfile excludes the definition (`excluded`), or
   *  the step's WorkerSpec is not the one its first attempt was admitted with (`spec` — a revision
   *  that changes it starts a new StepRun, so this never happens but by a defect). A person
   *  decides. */
  | {
      readonly kind: 'unavailable';
      readonly reason: 'definition' | 'skills' | 'excluded' | 'spec';
      readonly detail: string;
    }
  /** S11 GO8a (I-G8): what the step's WorkerSpec admits does not run as it is — it names Skills
   *  that are only drafts (`skill_draft`, `needs_approval`: a person approves one trial, S11 GO8b,
   *  never the platform by itself), Skills whose versions were all deprecated (`skill_deprecated`,
   *  `rejected`), a model the llm-proxy catalog does not offer (`model_not_offered`, `rejected`) or
   *  one the workspace does not allow (`model_not_allowed`, `rejected`). */
  | {
      readonly kind: 'admission';
      readonly verdict: 'needs_approval' | 'rejected';
      readonly reason: WorkerSpecAdmissionReason;
      readonly detail: string;
      /** `skill_draft` / `skill_deprecated`: the Skills, as the WorkerSpec names them. */
      readonly skillRefs?: readonly string[];
      /** `model_not_offered` / `model_not_allowed`: the model the WorkerSpec sets. */
      readonly model?: string;
    }
  /** An I18 quota: `concurrency_exceeded` clears by itself, `daily_cost_exceeded` with the day. */
  | { readonly kind: 'quota'; readonly code: QuotaViolationCode; readonly detail: string }
  /** The evaluation seal pauses every agent acting for the requester until the workspace owner
   *  releases it (S10 E3-2c). The detail never says where the seal's refusals were. */
  | { readonly kind: 'paused'; readonly detail: string };

/** Why a WorkerSpec's admission does not say `run` — see {@link StepAttemptRefusal}. */
export type WorkerSpecAdmissionReason =
  | 'skill_draft'
  | 'skill_deprecated'
  | 'model_not_offered'
  | 'model_not_allowed';

export interface CreateStepAttemptInput {
  readonly goalRunId: string;
  readonly stepRunId: string;
  readonly planRevision: number;
  /** The attempt number this Task carries — the StepRun's `attempt_count` after this start. */
  readonly stepAttempt: number;
  readonly worker: { readonly definitionId: string; readonly version: number };
  /** S11 GO8a: the plan entry's WorkerSpec (`null`: it sets none). */
  readonly spec: WorkerSpec | null;
  readonly input: unknown;
  readonly nested: boolean;
  /** S11 GO5d-1: the step's output schema the attempt's result is held to (`null`: none). */
  readonly outputSchema: OutputSchema | null;
  /** S11 GO5d-1: the previous attempt this one redoes, when that one ended without an accepted
   *  result (`output-contract.ts`); `null` otherwise. */
  readonly reworkOf: ReworkOf | null;
  /** The previous attempt's snapshot; `null` for the first attempt. */
  readonly previous: RunConfigSnapshot | null;
  /** What is left of the goal's token budget — `null` when nothing caps it. */
  readonly tokenCap: number | null;
  /** What is left of the goal's wall-clock budget, in seconds. */
  readonly durationCapSec: number;
  /** S11 GO8a: the model ids a WorkerSpec's `model` may name — the llm-proxy catalog, read only
   *  when the step's WorkerSpec sets a model (unreadable: it throws, and the advance with it).
   *  Absent: the catalog is not checked, `allowedModels` still is. */
  readonly modelCatalog?: () => Promise<ReadonlySet<string>>;
}

/** Everything {@link startStepAttemptTask} needs after the creating transaction commits. */
export interface PreparedStepAttempt {
  readonly task: TaskRow;
  readonly spawn: Omit<SpawnWorkerRunInput, 'task'>;
}

export type CreateStepAttemptResult =
  | { readonly kind: 'created'; readonly attempt: PreparedStepAttempt }
  | { readonly kind: 'refused'; readonly refusal: StepAttemptRefusal };

/** Why an attempt does not start while the evaluation seal pauses the requester's agents — the
 *  same whichever refusals opened the pause. */
export const STEP_ATTEMPT_PAUSED_DETAIL =
  'the evaluation seal paused the agents acting for the requester, so no Worker starts for them until the workspace owner releases the pause';

/** Capabilities a step's Handle carries only when its plan entry declares `nested`. */
const DERIVATION_CAPABILITIES: ReadonlySet<string> = new Set(['invoke_worker', 'find_workers']);

/** Whether the requester, their platform user or their workspace is disabled — the predicate
 *  `application/gateway/handle-auth.ts` applies to every Handle acting for them (a missing row is
 *  disabled). A Worker minted for a disabled requester could not authenticate anyway. */
async function requesterDisabled(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query<{ disabled: boolean }>(
    `select (p.disabled_at is not null
             or coalesce(u.status = 'disabled', false)
             or w.status = 'disabled') as disabled
       from principals p
       join workspaces w on w.id = p.workspace_id
       left join users u on u.id = p.user_id
      where p.workspace_id = $1 and p.id = $2`,
    [workspaceId, principalId],
  );
  return result.rows[0]?.disabled ?? true;
}

/** The parent scope of a step's Handle — see the module doc comment (I-G7) — with who reads the
 *  Skill registry for the requester and the models their workspace allows (S11 GO8a). */
interface StepParent {
  readonly scope: CapabilityScope;
  readonly viewer: DraftViewer;
  /** AgentPolicy `allowedModels` (`[]`: unrestricted). */
  readonly allowedModels: readonly string[];
}

async function stepParentScope(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  nested: boolean,
): Promise<StepParent | { readonly refusal: StepAttemptRefusal }> {
  if (await requesterDisabled(client, workspaceId, requesterId)) {
    return {
      refusal: { kind: 'authority_lost', reason: 'requester', detail: 'the requester is disabled' },
    };
  }
  const access = await readExecuteAccess(client, workspaceId, requesterId);
  if (access.role === undefined) {
    return {
      refusal: {
        kind: 'authority_lost',
        reason: 'requester',
        detail: 'the requester no longer exists',
      },
    };
  }
  const gatekeeperIds = entryGatekeeperIds(access);
  const entry = entryScope(
    gatekeeperIds.length > 0 ? { resources: { gatekeeper: [...gatekeeperIds] } } : {},
    { role: access.role },
  );
  if (!entry.capabilities.includes('invoke_worker')) {
    return {
      refusal: {
        kind: 'authority_lost',
        reason: 'requester',
        detail: `the requester's role (${access.role}) no longer starts Workers`,
      },
    };
  }
  return {
    scope: {
      capabilities: nested
        ? entry.capabilities
        : entry.capabilities.filter((name) => !DERIVATION_CAPABILITIES.has(name)),
      resources: entry.resources,
    },
    viewer: { principalId: requesterId, role: access.role },
    allowedModels: access.policy.allowedModels,
  };
}

/** S11 GO8a: the digest a RunConfigSnapshot keeps of a step's WorkerSpec (`null`: none). */
export function workerSpecDigest(spec: WorkerSpec | null): string | null {
  return spec === null ? null : sha256(canonicalJson(spec));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What an attempt of a step would run with as far as authority goes — see
 *  {@link resolveStepAuthority}. */
export interface StepAuthority {
  readonly kind: 'ok';
  readonly definition: WorkerDefinitionRow;
  readonly content: ReturnType<typeof readDefinitionContent>;
  readonly declaredCapabilities: readonly string[];
  readonly declaredGates: readonly string[];
  /** The parent of the attempt's Handle: the requester's entry scope now (I-G7), with who reads
   *  the Skill registry for them and the models their workspace allows. */
  readonly parent: StepParent;
  readonly childScope: CapabilityScope;
}

/**
 * I-G7: whether the requester may start an attempt of a step pinned to `ref` now, and the Handle
 * scope it would get — the WorkerDefinition published and worker-kind, not excluded by the
 * requester's AgentProfile, the requester enabled and allowed to start Workers, holding every gate
 * the definition declares and every execute-class capability it declares
 * (`computeChildHandleScope`). The one definition both {@link createStepAttemptTask} and the
 * confirmation card's check (`application/goal`'s `planAuthorityHints`, S11 GO5c) use. Reads only.
 *
 * S11 GO8a: the step's WorkerSpec (`spec`) replaces the definition's declared `capabilities` and
 * `gates` with its own when it sets them — declared needs, narrowed the same way (the Worker
 * ceiling, the requester's scope now), so a WorkerSpec cannot reach past either.
 */
export async function resolveStepAuthority(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  ref: { readonly definitionId: string; readonly version: number },
  nested: boolean,
  spec: WorkerSpec | null = null,
): Promise<StepAuthority | { readonly kind: 'refused'; readonly refusal: StepAttemptRefusal }> {
  const refused = (refusal: StepAttemptRefusal) => ({ kind: 'refused' as const, refusal });
  const definition = await getWorkerDefinition(client, workspaceId, ref);
  const refText = `${ref.definitionId}@${ref.version}`;
  if (!definition || definition.kind !== 'worker' || definition.status !== 'published') {
    return refused({
      kind: 'unavailable',
      reason: 'definition',
      detail: definition
        ? `WorkerDefinition ${refText} is ${definition.status === 'published' ? `${definition.kind}-kind` : definition.status}`
        : `WorkerDefinition ${refText} does not exist`,
    });
  }

  const agentProfile = await readAgentProfile(client, workspaceId, requesterId);
  if (agentProfile?.excludedWorkerDefinitions.includes(ref.definitionId)) {
    return refused({
      kind: 'unavailable',
      reason: 'excluded',
      detail: `the requester's AgentProfile excludes WorkerDefinition ${ref.definitionId}`,
    });
  }

  const content = readDefinitionContent(definition.definition);
  const declaredCapabilities =
    spec?.capabilities ??
    content.capabilities ??
    defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES);
  const declaredGates = spec?.gates ?? content.gates ?? [];

  const parent = await stepParentScope(client, workspaceId, requesterId, nested);
  if ('refusal' in parent) return refused(parent.refusal);
  const heldGates = new Set(parent.scope.resources.gatekeeper ?? []);
  const missingGates = declaredGates.filter((gate) => !heldGates.has(gate));
  if (missingGates.length > 0) {
    return refused({
      kind: 'authority_lost',
      reason: 'gates',
      detail: `the requester can no longer act on gatekeeper(s) ${missingGates.join(', ')}`,
      gatekeeperIds: missingGates,
    });
  }
  let childScope: CapabilityScope;
  try {
    childScope = computeChildHandleScope({
      parentAuthority: parent.scope,
      declaredCapabilities,
      declaredGates,
    });
  } catch (err) {
    if (err instanceof InvokeWorkerAttenuationError || err instanceof InvokeWorkerValidationError) {
      const capabilityNames =
        err instanceof InvokeWorkerAttenuationError ? err.capabilities : ([] as const);
      return refused({
        kind: 'authority_lost',
        reason: 'capability',
        detail: err.message,
        ...(capabilityNames.length > 0 ? { capabilityNames: [...capabilityNames] } : {}),
      });
    }
    throw err;
  }
  return {
    kind: 'ok',
    definition,
    content,
    declaredCapabilities,
    declaredGates,
    parent,
    childScope,
  };
}

/**
 * S11 GO8a (I-G8): what keeps a step's WorkerSpec from running with the components it names, worst
 * first — empty when its admission says `run` as far as components go (its gates and capabilities
 * are the requester's authority, {@link resolveStepAuthority}):
 *   1. Skills not there for the requester (a draft someone else proposed included) — `unavailable`;
 *   2. Skills whose versions were all deprecated — `rejected` (`skill_deprecated`);
 *   3. a model the llm-proxy catalog does not offer, or outside the workspace's AgentPolicy
 *      `allowedModels` — `rejected` ({@link workerSpecModelRefusal});
 *   4. Skills that are only drafts the requester may see — `needs_approval` (`skill_draft`).
 * The first one is why an attempt does not start; the confirmation card hints every one. A step
 * without a WorkerSpec, or one that sets neither Skills nor a model, has none: the definition's
 * own Skills mount as before (published ones, best effort). Reads only.
 */
export async function workerSpecComponentRefusals(
  client: PoolClient,
  workspaceId: string,
  parent: Pick<StepParent, 'viewer' | 'allowedModels'>,
  spec: WorkerSpec | null,
  offered: ReadonlySet<string> | null,
): Promise<readonly StepAttemptRefusal[]> {
  if (spec === null) return [];
  const refusals: StepAttemptRefusal[] = [];
  const skills = spec.skills
    ? await classifySkillRefs(client, workspaceId, parent.viewer, spec.skills)
    : null;
  if (skills && skills.missing.length > 0) {
    refusals.push({
      kind: 'unavailable',
      reason: 'skills',
      detail: `the step's WorkerSpec names Skill(s) that are not there: ${skills.missing.join(', ')}`,
    });
  }
  if (skills && skills.deprecated.length > 0) {
    refusals.push({
      kind: 'admission',
      verdict: 'rejected',
      reason: 'skill_deprecated',
      detail: `the step's WorkerSpec names Skill(s) whose versions were all deprecated: ${skills.deprecated.join(', ')}`,
      skillRefs: skills.deprecated,
    });
  }
  const model = workerSpecModelRefusal(parent, spec, offered);
  if (model) refusals.push(model);
  if (skills && skills.drafts.length > 0) {
    refusals.push({
      kind: 'admission',
      verdict: 'needs_approval',
      reason: 'skill_draft',
      detail: `the step's WorkerSpec names Skill(s) that are only drafts, which a person approves for a trial before the step starts: ${skills.drafts.join(', ')}`,
      skillRefs: skills.drafts,
    });
  }
  return refusals;
}

/**
 * S11 GO8a (I-G8): why a WorkerSpec's model does not run now — `rejected` either way:
 *   - `model_not_offered`: the llm-proxy catalog (`offered`; `null`: not checked) does not offer
 *     it — the rule legacy 302 holds a WorkerDefinition's model to when it is published, and what
 *     the plan was validated against when it was proposed, confirmed or revised;
 *   - `model_not_allowed`: the workspace's AgentPolicy `allowedModels` leaves it out (an empty list
 *     allows every model the catalog offers).
 * Unlike its Skills, checked for every attempt (review #493 on #853): a model the catalog dropped,
 * or an admin narrowed `allowedModels` past, after the first attempt started is not spawned again.
 */
export function workerSpecModelRefusal(
  parent: Pick<StepParent, 'allowedModels'>,
  spec: WorkerSpec | null,
  offered: ReadonlySet<string> | null,
): StepAttemptRefusal | null {
  const model = spec?.model;
  if (model === undefined) return null;
  if (offered !== null && !offered.has(model)) {
    return {
      kind: 'admission',
      verdict: 'rejected',
      reason: 'model_not_offered',
      detail: `the step's WorkerSpec sets model "${model}", which the llm-proxy catalog does not offer`,
      model,
    };
  }
  if (parent.allowedModels.length === 0 || parent.allowedModels.includes(model)) return null;
  return {
    kind: 'admission',
    verdict: 'rejected',
    reason: 'model_not_allowed',
    detail: `the step's WorkerSpec sets model "${model}", which this workspace does not allow`,
    model,
  };
}

/**
 * Half 1 — see the module doc comment. Runs in the caller's transaction (`client`, bound to the
 * requester's workspace). Returns `refused` without writing anything; throws only on a database
 * error or an unreadable model catalog (`modelCatalog`; the caller's transaction then rolls back
 * whole).
 */
export async function createStepAttemptTask(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  input: CreateStepAttemptInput,
): Promise<CreateStepAttemptResult> {
  const refused = (refusal: StepAttemptRefusal): CreateStepAttemptResult => ({
    kind: 'refused',
    refusal,
  });

  if (await hasActiveSealHold(client, workspaceId, requesterId)) {
    return refused({ kind: 'paused', detail: STEP_ATTEMPT_PAUSED_DETAIL });
  }

  const ref = input.previous
    ? { definitionId: input.previous.definition.id, version: input.previous.definition.version }
    : input.worker;
  const specDigest = workerSpecDigest(input.spec);
  if (input.previous) {
    // GO8a invariant: a later attempt runs the WorkerSpec its first attempt was admitted with. A
    // revision that changes the entry supersedes the StepRun (`samePlanEntry`), so the new one
    // starts at attempt 1 and is admitted afresh; a mismatch here is a defect, never a reuse.
    const admitted = input.previous.v === 2 ? (input.previous.spec?.digest ?? null) : null;
    if (admitted !== specDigest) {
      return refused({
        kind: 'unavailable',
        reason: 'spec',
        detail:
          "the step's WorkerSpec is not the one its first attempt was admitted with, so no later attempt starts from that one",
      });
    }
  }
  const authority = await resolveStepAuthority(
    client,
    workspaceId,
    requesterId,
    ref,
    input.nested,
    input.spec,
  );
  if (authority.kind === 'refused') return refused(authority.refusal);
  const { definition, content, declaredCapabilities, declaredGates, parent, childScope } =
    authority;
  const offered =
    input.spec?.model !== undefined && input.modelCatalog ? await input.modelCatalog() : null;
  if (!input.previous) {
    const [refusal] = await workerSpecComponentRefusals(
      client,
      workspaceId,
      parent,
      input.spec,
      offered,
    );
    if (refusal) return refused(refusal);
  } else {
    // A later attempt reuses its first attempt's Skills; its model is checked as it stands now.
    const refusal = workerSpecModelRefusal(parent, input.spec, offered);
    if (refusal) return refused(refusal);
  }

  let skills: ResolvedRunSkills;
  if (input.previous) {
    const pinned = await resolvePinnedSkillsInline(client, workspaceId, input.previous.skills);
    if (pinned.kind === 'unavailable') {
      return refused({
        kind: 'unavailable',
        reason: 'skills',
        detail: `Skill version(s) no longer published: ${pinned.refs
          .map((skill) => `${skill.skillId}@${skill.version}`)
          .join(', ')}`,
      });
    }
    skills = pinned.skills;
  } else {
    skills = await resolveSkillsInline(
      client,
      workspaceId,
      input.spec?.skills ?? content.skills ?? [],
    );
  }

  const model = input.previous
    ? (input.previous.model ?? undefined)
    : (input.spec?.model ??
      content.model ??
      ((await readEffectiveAgentProfile(client, workspaceId, requesterId)).model || undefined));
  const image = input.previous
    ? (input.previous.image ?? undefined)
    : await resolveActiveRuntimeImage(client);
  const systemPrompt = composeSystemPrompt({
    base: content.systemPrompt,
    stepInstructions: input.spec?.instructions,
    instanceInstructions: await readInstanceInstructions(client),
  });

  await lockTaskQuotas(client, workspaceId, requesterId);
  let quotas: Awaited<ReturnType<typeof assertTaskQuotas>>;
  try {
    quotas = await assertTaskQuotas(client, workspaceId, requesterId, ref.definitionId, 1);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return refused({ kind: 'quota', code: err.code, detail: err.message });
    }
    throw err;
  }

  // The least of the workspace default, what is left of the goal's and the WorkerSpec's own cap.
  const caps = [quotas.defaultTokenBudget, input.tokenCap, input.spec?.tokenBudget ?? null].filter(
    (cap): cap is number => cap !== null,
  );
  const tokenBudget = caps.length === 0 ? null : Math.min(...caps);
  // GO11: the gates the step's Task may observe — only narrowing what the requester's agent may.
  const observeScope = input.spec?.observeScope
    ? normalizeObserveScope(input.spec.observeScope)
    : null;
  const durationLimitSec = Math.max(
    1,
    Math.min(quotas.defaultDurationLimitSec, Math.floor(input.durationCapSec)),
  );

  const snapshot: RunConfigSnapshot = {
    v: 2,
    definition: { id: definition.id, version: definition.version },
    skills: skills.loadedSkills.map((skill) => ({
      skillId: skill.skillId,
      version: skill.version,
    })),
    model: model ?? null,
    image: image ?? null,
    systemPromptDigest: systemPrompt === undefined ? null : sha256(systemPrompt),
    handle: {
      capabilities: [...childScope.capabilities],
      gatekeepers: [...(childScope.resources.gatekeeper ?? [])],
    },
    budget: { tokenBudget, durationLimitSec },
    spec: specDigest === null ? null : { digest: specDigest },
  };

  const inserted = await client.query(
    `insert into tasks (
       workspace_id, status, on_behalf_of, created_by_activity_id, worker_definition_id,
       worker_definition_version, input, token_budget, duration_limit_sec,
       goal_run_id, step_run_id, plan_revision, step_attempt, run_config_snapshot,
       output_schema, rework_of, observe_scope
     ) values ($1, 'queued', $2, null, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb,
       $13::jsonb, $14::jsonb, $15::uuid[])
     returning ${TASK_ROW_COLUMNS}`,
    [
      workspaceId,
      requesterId,
      definition.id,
      definition.version,
      JSON.stringify(input.input ?? null),
      tokenBudget,
      durationLimitSec,
      input.goalRunId,
      input.stepRunId,
      input.planRevision,
      input.stepAttempt,
      JSON.stringify(snapshot),
      input.outputSchema === null ? null : JSON.stringify(input.outputSchema),
      input.reworkOf === null ? null : JSON.stringify(input.reworkOf),
      observeScope,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('createStepAttemptTask: tasks INSERT ... RETURNING produced no row');
  const task = mapTaskRow(row);
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId: requesterId,
    action: 'task.queue',
    taskId: task.id,
    resultingStatus: 'queued',
    extraAuditPayload: {
      goalRunId: input.goalRunId,
      stepRunId: input.stepRunId,
      stepAttempt: input.stepAttempt,
      ...(input.reworkOf !== null ? { reworkOfTaskId: input.reworkOf.taskId } : {}),
      // GO8a: which WorkerSpec the attempt was admitted with, and what of it was set.
      ...(input.spec !== null
        ? { workerSpec: { digest: specDigest, fields: Object.keys(input.spec).sort() } }
        : {}),
    },
  });

  const definitionName =
    typeof definition.definition.name === 'string' ? definition.definition.name : definition.id;
  return {
    kind: 'created',
    attempt: {
      task,
      spawn: {
        parentWorkerRunId: null,
        depth: 1,
        attempt: 1,
        onBehalfOf: requesterId,
        parentAuthority: parent.scope,
        parentClaimsForLineage: undefined,
        declaredCapabilities,
        declaredGates,
        model,
        systemPrompt,
        definitionName,
        skillsInline: skills.skillsInline,
        loadedSkills: skills.loadedSkills,
        egressDeny: content.egressDeny,
        image,
      },
    },
  };
}

/**
 * Half 2 — after the creating transaction committed. Spawns the WorkerRun and moves the Task
 * `queued → running`; a spawn failure fails the Task `spawn_failed` and reaps what the spawn left
 * (the same path as `invokeWorkerCreate`). Never throws for a spawn failure: the Task's
 * `TaskUpdated` wakes the advancer, which treats it as a transient failure of the attempt. Returns
 * whether the Task is now running.
 */
export async function startStepAttemptTask(
  deps: TaskRuntimeDeps,
  workspaceId: string,
  attempt: PreparedStepAttempt,
): Promise<boolean> {
  const { task, spawn } = attempt;
  try {
    await spawnWorkerRun(deps, workspaceId, { ...spawn, task });
  } catch {
    await failTaskAndReapWorkerRuns(deps, workspaceId, spawn.onBehalfOf, task.id, 'spawn_failed');
    return false;
  }
  return withWorkspace(
    deps.pool,
    { workspaceId, principalId: spawn.onBehalfOf },
    async (client) => {
      // Status-guarded, as in `invokeWorkerCreate`: a cancel that landed meanwhile keeps its status,
      // and the reaper's duration scan ends the orphaned run.
      const updated = await client.query(
        "update tasks set status = 'running' where workspace_id = $1 and id = $2 and status = 'queued'",
        [workspaceId, task.id],
      );
      if ((updated.rowCount ?? 0) === 0) return false;
      await recordTaskTransition(client, workspaceId, {
        actorPrincipalId: spawn.onBehalfOf,
        action: 'task.start',
        taskId: task.id,
        resultingStatus: 'running',
      });
      return true;
    },
  );
}
