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
  readVisibleSkillDrafts,
  skillDraftDigest,
} from '../worker/index.js';
import {
  type ResolvedRunSkills,
  type TrialDraftRef,
  readDefinitionContent,
  resolvePinnedSkillsInline,
  resolveSkillsInline,
  resolveTrialDraftsInline,
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
 * S11 GO8b (I-G8): a person who could publish the drafts approves one trial of the step
 * (`application/goal/trial-approvals.ts`, goal/0013) — the advancer hands the step's approvals in
 * (`trialApprovals`), and its first attempt is admitted with the first one whose drafts are the
 * ones its WorkerSpec names now ({@link stepTrialDrafts}), each still that content: the draft
 * versions mount beside its published Skills, and the snapshot records the approval and the drafts
 * (`trial`). The retries of that attempt mount the same drafts while each is unchanged
 * ({@link resolveTrialDraftsInline}); a draft discarded, proposed again or deprecated refuses them
 * (`unavailable`). An approval that no longer matches admits nothing: the step waits for a person
 * again (`needs_approval`, said so).
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
      /** Legacy 544, `skills` of a later attempt: the Skill versions it would mount and cannot, each
       *  「name v<version>」 ({@link pinnedSkillsRefusal}). */
      readonly skillRefs?: readonly string[];
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
      /** S11 GO8b, `skill_draft`: what a trial of the step would mount ({@link stepTrialDrafts}). */
      readonly trial?: StepTrialDrafts;
    }
  /** An I18 quota: `concurrency_exceeded` clears by itself, `daily_cost_exceeded` with the day. */
  | { readonly kind: 'quota'; readonly code: QuotaViolationCode; readonly detail: string }
  /** The evaluation seal pauses every agent acting for the requester until the workspace owner
   *  releases it (S10 E3-2c). The detail never says where the seal's refusals were. */
  | { readonly kind: 'paused'; readonly detail: string };

/** S11 GO8b: one draft Skill version a trial of a step mounts — with its name and proposer, as a
 *  hint and an approval name it. */
export interface StepTrialDraft extends TrialDraftRef {
  readonly name: string;
  readonly proposedBy: string;
}

/** S11 GO8b: what one trial of a step would mount — its draft refs each naming exactly one draft
 *  (`drafts`, in the WorkerSpec's order) — or why there is no single trial to approve. */
export type StepTrialDrafts =
  | { readonly kind: 'drafts'; readonly drafts: readonly StepTrialDraft[] }
  | { readonly kind: 'none'; readonly detail: string };

/** S11 GO8b: an approval of a trial of the step, as the advancer hands it in — the drafts it
 *  approved. */
export interface StepTrialApprovalCandidate {
  readonly approvalId: string;
  readonly drafts: readonly TrialDraftRef[];
}

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
  /** S11 GO8b: for the step's first attempt, the approvals of a trial of it made for this StepRun
   *  and its WorkerSpec, newest first (`application/goal/trial-approvals.ts`); the first whose
   *  drafts match admits the attempt. Ignored for a later attempt (its snapshot says). */
  readonly trialApprovals?: readonly StepTrialApprovalCandidate[];
}

/** Everything {@link startStepAttemptTask} needs after the creating transaction commits. */
export interface PreparedStepAttempt {
  readonly task: TaskRow;
  readonly spawn: Omit<SpawnWorkerRunInput, 'task'>;
}

export type CreateStepAttemptResult =
  | {
      readonly kind: 'created';
      readonly attempt: PreparedStepAttempt;
      /** S11 GO8b: the approval a first attempt was admitted with (`null`: none) — the caller
       *  names this StepRun on it, in the same transaction, when it does not yet. */
      readonly trialApprovalId: string | null;
    }
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
      trial: await stepTrialDrafts(client, workspaceId, parent.viewer, skills.drafts),
    });
  }
  return refusals;
}

/** P-A2: whether the workspace's `allowedModels` lets `model` run (`[]`: unrestricted). */
function modelAllowed(allowedModels: readonly string[], model: string): boolean {
  return allowedModels.length === 0 || allowedModels.includes(model);
}

/**
 * S11 GO8b: the draft versions one trial of a step would mount — for each of `draftRefs` (the
 * WorkerSpec's Skills that are only drafts for `viewer`, the requester: `classifySkillRefs`), the
 * one draft it names. None when a ref names several drafts (two families' drafts under one name —
 * name it by id), when two drafts share a name or a published Skill already has a draft's name (a
 * Worker mounts Skills by name, so one name is one Skill — and such a draft could not be
 * published either). Reads only.
 */
export async function stepTrialDrafts(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftViewer,
  draftRefs: readonly string[],
): Promise<StepTrialDrafts> {
  const byRef = await readVisibleSkillDrafts(client, workspaceId, viewer, draftRefs);
  const drafts: StepTrialDraft[] = [];
  for (const ref of new Set(draftRefs)) {
    const rows = byRef.get(ref) ?? [];
    const [row] = rows;
    if (rows.length !== 1 || !row) {
      return {
        kind: 'none',
        detail:
          rows.length === 0
            ? `Skill "${ref}" is not a draft the requester may see`
            : `"${ref}" names ${rows.length} draft Skills — name the one to try by its id`,
      };
    }
    if (drafts.some((draft) => draft.skillId === row.id)) continue;
    if (drafts.some((draft) => draft.name === row.name)) {
      return { kind: 'none', detail: `two draft Skills it names are both called "${row.name}"` };
    }
    drafts.push({
      skillId: row.id,
      version: row.version,
      draftDigest: skillDraftDigest(row),
      name: row.name,
      proposedBy: row.proposedBy,
    });
  }
  const taken = await client.query<{ name: string }>(
    `select distinct name from skills
      where workspace_id = $1 and status = 'published' and name = any($2::text[])`,
    [workspaceId, drafts.map((draft) => draft.name)],
  );
  const [name] = taken.rows;
  if (name) {
    return {
      kind: 'none',
      detail: `a published Skill is already called "${name.name}", so the draft by that name is not tried`,
    };
  }
  return { kind: 'drafts', drafts };
}

/** S11 GO8b: whether an approval's drafts are exactly the ones a trial of the step would mount
 *  now — the same versions with the same content. */
export function trialDraftsMatch(
  approved: readonly TrialDraftRef[],
  current: readonly TrialDraftRef[],
): boolean {
  const key = (draft: TrialDraftRef) => `${draft.skillId}@${draft.version}#${draft.draftDigest}`;
  const now = new Set(current.map(key));
  const then = new Set(approved.map(key));
  return now.size === then.size && [...then].every((entry) => now.has(entry));
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
  if (modelAllowed(parent.allowedModels, model)) return null;
  return {
    kind: 'admission',
    verdict: 'rejected',
    reason: 'model_not_allowed',
    detail: `the step's WorkerSpec sets model "${model}", which this workspace does not allow`,
    model,
  };
}

/**
 * S11 GO8b: the approval that admits a first attempt whose admission refused `refusal` — only a
 * `skill_draft` refusal (every other reason is worse and comes first), and only an approval whose
 * drafts are the trial's now ({@link trialDraftsMatch}). `none`: there is nothing a trial approval
 * could admit, or no approval; `stale`: there are approvals, none matching.
 */
function approvedTrial(
  refusal: StepAttemptRefusal,
  approvals: readonly StepTrialApprovalCandidate[],
): StepTrialApprovalCandidate | 'none' | 'stale' {
  if (refusal.kind !== 'admission' || refusal.reason !== 'skill_draft') return 'none';
  if (approvals.length === 0) return 'none';
  const current = refusal.trial;
  if (current?.kind !== 'drafts') return 'stale';
  return approvals.find((approval) => trialDraftsMatch(approval.drafts, current.drafts)) ?? 'stale';
}

/**
 * Legacy 544: why a later attempt cannot mount the Skill versions its first attempt pinned —
 * published ones no longer published (`published`), or the drafts of a trial a person approved
 * changed, discarded or deprecated since (`trial`) — with each version named as a person reads it
 * (`skillRefs`, 「name v<version>」: its family's name; one whose rows are all gone — a draft
 * discarded — the name it had where the caller knew it, `knownNames`, else its id), so the pause
 * and the hint name them. Reads only.
 */
export async function pinnedSkillsRefusal(
  client: PoolClient,
  workspaceId: string,
  pinned: 'published' | 'trial',
  refs: readonly { readonly skillId: string; readonly version: number }[],
  knownNames: ReadonlyMap<string, string> = new Map(),
): Promise<StepAttemptRefusal> {
  const named = await client.query<{ id: string; name: string }>(
    `select distinct on (id) id, name from skills
      where workspace_id = $1 and id = any($2::uuid[])
      order by id, version desc`,
    [workspaceId, [...new Set(refs.map((ref) => ref.skillId))]],
  );
  const names = new Map(named.rows.map((row) => [row.id, row.name] as const));
  const ids = refs.map((skill) => `${skill.skillId}@${skill.version}`).join(', ');
  return {
    kind: 'unavailable',
    reason: 'skills',
    detail:
      pinned === 'published'
        ? `Skill version(s) no longer published: ${ids}`
        : `draft Skill version(s) the trial was approved for were changed, discarded or deprecated since: ${ids}`,
    skillRefs: refs.map(
      (ref) =>
        `${names.get(ref.skillId) ?? knownNames.get(ref.skillId) ?? ref.skillId} v${ref.version}`,
    ),
  };
}

/**
 * Legacy 544: whether a later attempt after `previous` (its last attempt's snapshot) could mount
 * the Skills that attempt pinned, as {@link createStepAttemptTask} mounts them — its published
 * versions, then the drafts of its approved trial — for a paused run's check (`application/goal`'s
 * `planAuthorityHints`; `knownNames` as {@link pinnedSkillsRefusal}'s). `null` when it could.
 * Reads only.
 */
export async function previousAttemptSkillsRefusal(
  client: PoolClient,
  workspaceId: string,
  previous: RunConfigSnapshot,
  knownNames: ReadonlyMap<string, string> = new Map(),
): Promise<StepAttemptRefusal | null> {
  const pinned = await resolvePinnedSkillsInline(client, workspaceId, previous.skills);
  if (pinned.kind === 'unavailable') {
    return pinnedSkillsRefusal(client, workspaceId, 'published', pinned.refs, knownNames);
  }
  const trial = previous.v === 2 ? (previous.trial ?? null) : null;
  if (!trial) return null;
  const drafts = await resolveTrialDraftsInline(client, workspaceId, trial.drafts);
  return drafts.kind === 'unavailable'
    ? pinnedSkillsRefusal(client, workspaceId, 'trial', drafts.refs, knownNames)
    : null;
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
  // S11 GO8b: the trial a person approved — the approval admitting the first attempt, or the one
  // the previous attempt ran (`trial` of its snapshot).
  let trial: { readonly approvalId: string; readonly drafts: readonly TrialDraftRef[] } | null =
    null;
  if (!input.previous) {
    const [refusal] = await workerSpecComponentRefusals(
      client,
      workspaceId,
      parent,
      input.spec,
      offered,
    );
    if (refusal) {
      const approval = approvedTrial(refusal, input.trialApprovals ?? []);
      if (approval === 'none') return refused(refusal);
      if (approval === 'stale') {
        return refused({
          ...refusal,
          detail: `${refusal.detail} — the approval of its trial does not match it any more (a draft changed, or another one is named), so a person approves again`,
        });
      }
      trial = approval;
    }
  } else {
    // A later attempt reuses its first attempt's Skills; its model is checked as it stands now.
    const refusal = workerSpecModelRefusal(parent, input.spec, offered);
    if (refusal) return refused(refusal);
    trial = input.previous.v === 2 ? (input.previous.trial ?? null) : null;
  }

  let skills: ResolvedRunSkills;
  if (input.previous) {
    const pinned = await resolvePinnedSkillsInline(client, workspaceId, input.previous.skills);
    if (pinned.kind === 'unavailable') {
      return refused(await pinnedSkillsRefusal(client, workspaceId, 'published', pinned.refs));
    }
    skills = pinned.skills;
  } else {
    skills = await resolveSkillsInline(
      client,
      workspaceId,
      input.spec?.skills ?? content.skills ?? [],
    );
  }
  if (trial) {
    const drafts = await resolveTrialDraftsInline(client, workspaceId, trial.drafts);
    if (drafts.kind === 'unavailable') {
      return refused(await pinnedSkillsRefusal(client, workspaceId, 'trial', drafts.refs));
    }
    skills = { ...skills, skillsInline: [...skills.skillsInline, ...drafts.skillsInline] };
  }

  // Legacy 543 (P-A2): a later attempt keeps its first attempt's model — but one taken from the
  // requester's AgentProfile (neither the WorkerSpec nor the WorkerDefinition sets a model) is held
  // to `allowedModels` as it stands now, the cap that model is under: narrowed past it, the attempt
  // falls back the way the profile's model does on any new run (the entry model, when allowed).
  // A WorkerSpec's model is refused instead (`workerSpecModelRefusal`); a WorkerDefinition's own
  // model is not under the cap on a first attempt either.
  let model: string | undefined;
  let modelFallback: { readonly from: string; readonly to: string | null } | null = null;
  if (input.previous) {
    model = input.previous.model ?? undefined;
    if (
      model !== undefined &&
      input.spec?.model === undefined &&
      content.model === undefined &&
      !modelAllowed(parent.allowedModels, model)
    ) {
      const fallback =
        (await readEffectiveAgentProfile(client, workspaceId, requesterId)).model || undefined;
      modelFallback = { from: model, to: fallback ?? null };
      model = fallback;
    }
  } else {
    model =
      input.spec?.model ??
      content.model ??
      ((await readEffectiveAgentProfile(client, workspaceId, requesterId)).model || undefined);
  }
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
    ...(trial
      ? {
          trial: {
            approvalId: trial.approvalId,
            drafts: trial.drafts.map((draft) => ({
              skillId: draft.skillId,
              version: draft.version,
              draftDigest: draft.draftDigest,
            })),
          },
        }
      : {}),
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
      // GO8b: the trial a person approved, and the draft versions it mounts.
      ...(trial
        ? {
            trial: {
              approvalId: trial.approvalId,
              drafts: trial.drafts.map((draft) => `${draft.skillId}@${draft.version}`),
            },
          }
        : {}),
      // Legacy 543: the model the previous attempt ran on is no longer allowed, and this one's.
      ...(modelFallback !== null ? { modelFallback } : {}),
    },
  });

  const definitionName =
    typeof definition.definition.name === 'string' ? definition.definition.name : definition.id;
  return {
    kind: 'created',
    trialApprovalId: !input.previous && trial ? trial.approvalId : null,
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
