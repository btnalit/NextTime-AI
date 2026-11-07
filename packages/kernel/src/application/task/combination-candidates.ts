import {
  COMBINATION_MIN_ACHIEVED,
  COMBINATION_MIN_GOALS,
  COMBINATION_MIN_RATE,
  COMBINATION_WINDOW_DAYS,
  type CombinationCandidateWire,
  type CombinationCandidatesWire,
  type CombinationEvidence,
  type CombinationEvidenceWire,
  type CombinationShortfall,
  type ObjectiveOutcome,
  type PublishableStatus,
  type WorkerDefinitionKind,
  type WorkerSpec,
  WorkerSpecSchema,
  type WorkerWorkerDefinitionContent,
  WorkerWorkerDefinitionContentSchema,
  combinationShortfalls,
  mergeCombinationDefinition,
  outcomeBasisTier,
  suggestsReview,
  workerSpecFieldsOf,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  WorkerDefinitionNotFoundError,
  type WorkerDefinitionRow,
  combinationKey,
  derivedFamiliesOf,
  getWorkerDefinition,
  proposeWorkerDefinition,
  recordDefinitionDerivation,
  validateWorkerDefinitionContent,
} from '../worker/index.js';
import { type SubjectOutcome, readSubjectOutcomes } from './stats-read.js';
import { workerSpecDigest } from './step-attempt.js';
import { type CanReadGoal, labelSpecs } from './worker-definition-stats.js';

/**
 * application/task/combination-candidates (S11 GO16b; `@nexttime/shared` `combination.ts` holds
 * the rules, GO16 F1–F7 = A): which combinations of a WorkerDefinition family's versions kept
 * working (`get_combination_candidates`), and turning one into a new family's first draft
 * (`propose_definition_from_combination`). Read when asked, from the records the work already
 * left — no table of its own but the derivation the worker module keeps (`worker/0014`).
 *
 *   - The evidence: a combination's Tasks of ordinary work (`purpose` null) that ran with its
 *     WorkerSpec (`run_config_snapshot -> 'spec' ->> 'digest'`) and completed or failed within the
 *     window (GO13's hint window, `readWorkerHints`'s rule), their outcome subjects each once
 *     (`readSubjectOutcomes`, as `get_worker_definition_stats` counts), only the primary tier —
 *     the requester's word, a platform check. `goals` counts the GoalRuns of the Tasks an achieved
 *     subject covers.
 *   - The WorkerSpec's content: read from the plan entry the Task's StepRun was created from (its
 *     `plan_revision`), kept only when it parses and digests to the snapshot's digest — the same
 *     check `get_worker_definition_stats` makes for the field names. A combination none of whose
 *     entries reads so is no candidate (not guessed).
 *   - Who sees that content (F7): a goal plan is its requester's and the workspace owner's
 *     (`application/goal/views.ts`'s `goalVisibleTo`); the caller passes that rule in as
 *     `canReadGoal`, so this module never decides goal visibility itself. Without a readable
 *     source the candidate is numbers, field names and a label numbered in the response — not
 *     even the WorkerSpec's digest, as `get_worker_definition_stats` (review #493 on #1064) — and
 *     proposing it is not found.
 *
 * Proposing judges the combination again in the same transaction and refuses one that no longer
 * qualifies ({@link CombinationNotEligibleError}); it writes the draft through
 * `proposeWorkerDefinition` (the human channel's `origin`) and the derivation through
 * `recordDefinitionDerivation` — the draft is then reviewed and published like any other.
 */

/** 409 `combination_not_eligible`: the combination does not qualify now; nothing was written. */
export class CombinationNotEligibleError extends Error {
  readonly code = 'combination_not_eligible' as const;
  readonly details: {
    readonly shortfalls: readonly CombinationShortfall[];
    readonly evidence: CombinationEvidenceWire;
  };
  constructor(shortfalls: readonly CombinationShortfall[], evidence: CombinationEvidenceWire) {
    super(
      `the combination does not qualify to become a WorkerDefinition now (${shortfalls.join(', ')}) — nothing was proposed`,
    );
    this.name = 'CombinationNotEligibleError';
    this.details = { shortfalls: [...shortfalls], evidence };
  }
}

/** 404: no goal the caller can read ran the combination with a WorkerSpec that reads as its
 *  digest — as a definition nothing has. */
export class CombinationNotFoundError extends Error {
  constructor(definitionId: string, version: number, specDigest: string) {
    super(`no combination ${definitionId}@${version} with WorkerSpec ${specDigest} you can read`);
    this.name = 'CombinationNotFoundError';
  }
}

/** A plan entry a combination's WorkerSpec was read from, the digest checked. */
export interface CombinationSource {
  readonly goalRunId: string;
  readonly onBehalfOf: string;
  readonly planRevision: number;
  readonly stepKey: string;
  readonly spec: WorkerSpec;
}

/** One combination of one version, judged. */
export interface CombinationJudgement {
  readonly version: number;
  readonly specDigest: string;
  readonly evidence: CombinationEvidence;
  readonly shortfalls: readonly CombinationShortfall[];
}

interface CombinationTaskRow {
  readonly id: string;
  readonly version: number;
  readonly spec_digest: string;
  readonly created_by_activity_id: string | null;
  readonly goal_run_id: string | null;
  readonly step_run_id: string | null;
  readonly objective_outcome: ObjectiveOutcome | null;
  readonly outcome_given_at: Date | null;
}

interface FamilyVersion {
  readonly version: number;
  readonly status: PublishableStatus;
  readonly kind: WorkerDefinitionKind;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The family's published and deprecated versions, newest first. */
async function familyVersions(
  client: PoolClient,
  workspaceId: string,
  definitionId: string,
): Promise<FamilyVersion[]> {
  const result = await client.query<FamilyVersion>(
    `select version, status, kind from worker_definitions
      where workspace_id = $1 and id = $2 and status in ('published', 'deprecated')
      order by version desc`,
    [workspaceId, definitionId],
  );
  return result.rows;
}

/** `evidence` as sent. */
export function evidenceWire(evidence: CombinationEvidence): CombinationEvidenceWire {
  return {
    achieved: evidence.achieved,
    notAchieved: evidence.notAchieved,
    goals: evidence.goals,
    rate: evidence.rate,
    windowDays: COMBINATION_WINDOW_DAYS,
  };
}

const NO_EVIDENCE: CombinationEvidence = {
  achieved: 0,
  notAchieved: 0,
  goals: 0,
  rate: null,
  reviewSuggested: false,
};

/**
 * Every combination with a WorkerSpec that `versions` ran as within the window, judged (F1). A
 * version not listed in `versions` is not read; one that is not published is judged
 * `base_not_published`.
 */
export async function judgeCombinations(
  client: PoolClient,
  workspaceId: string,
  definitionId: string,
  versions: readonly FamilyVersion[],
  now: Date = new Date(),
): Promise<CombinationJudgement[]> {
  if (versions.length === 0) return [];
  const since = new Date(now.getTime() - COMBINATION_WINDOW_DAYS * DAY_MS);
  const tasks = await client.query<CombinationTaskRow>(
    `select t.id, t.worker_definition_version as version,
            t.run_config_snapshot -> 'spec' ->> 'digest' as spec_digest,
            t.created_by_activity_id, t.goal_run_id, t.step_run_id, t.objective_outcome,
            t.outcome_given_at
       from tasks t
      where t.workspace_id = $1 and t.worker_definition_id = $2
        and t.worker_definition_version = any($3::int[]) and t.purpose is null
        and t.status in ('completed', 'failed')
        and coalesce(t.completed_at, t.failed_at) >= $4
        and t.run_config_snapshot -> 'spec' ->> 'digest' is not null`,
    [workspaceId, definitionId, versions.map((row) => row.version), since],
  );
  const subjectsByTask = await readSubjectOutcomes(client, workspaceId, tasks.rows);

  const byCombination = new Map<string, CombinationTaskRow[]>();
  for (const task of tasks.rows) {
    const key = combinationKey(task.version, task.spec_digest);
    byCombination.set(key, [...(byCombination.get(key) ?? []), task]);
  }
  const judgements: CombinationJudgement[] = [];
  for (const combinationTasks of byCombination.values()) {
    const first = combinationTasks[0];
    if (!first) continue;
    // Each primary subject once; the goals of the Tasks an achieved one covers.
    const primary = new Map<string, SubjectOutcome>();
    const goals = new Set<string>();
    for (const task of combinationTasks) {
      for (const [key, subject] of subjectsByTask.get(task.id) ?? []) {
        if (outcomeBasisTier(subject.basis) !== 'primary') continue;
        primary.set(key, subject);
        if (subject.outcome === 'achieved' && task.goal_run_id) goals.add(task.goal_run_id);
      }
    }
    const subjects = [...primary.values()];
    const achieved = subjects.filter((subject) => subject.outcome === 'achieved').length;
    const notAchieved = subjects.filter((subject) => subject.outcome === 'not_achieved').length;
    const evidence: CombinationEvidence = {
      achieved,
      notAchieved,
      goals: goals.size,
      rate: achieved + notAchieved === 0 ? null : achieved / (achieved + notAchieved),
      reviewSuggested: suggestsReview(
        [...subjects].sort((a, b) => b.at.getTime() - a.at.getTime()).map((s) => s.outcome),
      ),
    };
    const base = versions.find((row) => row.version === first.version);
    judgements.push({
      version: first.version,
      specDigest: first.spec_digest,
      evidence,
      shortfalls: combinationShortfalls(evidence, base?.status === 'published'),
    });
  }
  return judgements;
}

/**
 * The plan entries `combinations` ran from, each digest-checked, newest Task first, keyed
 * {@link combinationKey} — one per (goal, revision, step).
 */
export async function readCombinationSources(
  client: PoolClient,
  workspaceId: string,
  definitionId: string,
  combinations: readonly { readonly version: number; readonly specDigest: string }[],
): Promise<Map<string, CombinationSource[]>> {
  const sources = new Map<string, CombinationSource[]>();
  if (combinations.length === 0) return sources;
  const result = await client.query<{
    version: number;
    spec_digest: string;
    goal_run_id: string;
    on_behalf_of: string;
    plan_revision: number;
    step_key: string;
    spec: unknown;
  }>(
    `select t.worker_definition_version as version,
            t.run_config_snapshot -> 'spec' ->> 'digest' as spec_digest,
            t.goal_run_id, g.on_behalf_of, t.plan_revision, s.step_key,
            jsonb_path_query_first(p.plan, '$.steps[*] ? (@.key == $key).spec',
                                   jsonb_build_object('key', s.step_key)) as spec
       from tasks t
       join unnest($3::int[], $4::text[]) as c(version, digest)
         on t.worker_definition_version = c.version
        and t.run_config_snapshot -> 'spec' ->> 'digest' = c.digest
       join step_runs s on s.workspace_id = t.workspace_id and s.id = t.step_run_id
       join plan_revisions p
         on p.workspace_id = t.workspace_id and p.goal_run_id = t.goal_run_id
        and p.revision = t.plan_revision
       join goal_runs g on g.workspace_id = t.workspace_id and g.id = t.goal_run_id
      where t.workspace_id = $1 and t.worker_definition_id = $2 and t.purpose is null
      order by t.created_at desc, t.id desc`,
    [
      workspaceId,
      definitionId,
      combinations.map((combination) => combination.version),
      combinations.map((combination) => combination.specDigest),
    ],
  );
  const seen = new Set<string>();
  for (const row of result.rows) {
    const entry = `${row.version}|${row.spec_digest}|${row.goal_run_id}|${row.plan_revision}|${row.step_key}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    const parsed = WorkerSpecSchema.safeParse(row.spec);
    if (!parsed.success || workerSpecDigest(parsed.data) !== row.spec_digest) continue;
    const key = combinationKey(row.version, row.spec_digest);
    sources.set(key, [
      ...(sources.get(key) ?? []),
      {
        goalRunId: row.goal_run_id,
        onBehalfOf: row.on_behalf_of,
        planRevision: row.plan_revision,
        stepKey: row.step_key,
        spec: parsed.data,
      },
    ]);
  }
  return sources;
}

/** A published version's content as a worker-kind definition, or `null` (an entry definition,
 *  or content that no longer parses). */
function workerContentOf(row: WorkerDefinitionRow | null): WorkerWorkerDefinitionContent | null {
  if (!row || row.kind !== 'worker') return null;
  const parsed = WorkerWorkerDefinitionContentSchema.safeParse(row.definition);
  return parsed.success ? parsed.data : null;
}

/** `get_combination_candidates`: `null` for an unknown family, an entry definition, or one with
 *  no published version. */
export async function readCombinationCandidates(
  client: PoolClient,
  workspaceId: string,
  definitionId: string,
  viewer: { readonly principalId: string; readonly canReadGoal: CanReadGoal },
  now: Date = new Date(),
): Promise<CombinationCandidatesWire | null> {
  const versions = await familyVersions(client, workspaceId, definitionId);
  if (versions.length === 0 || versions[0]?.kind !== 'worker') return null;
  if (!versions.some((row) => row.status === 'published')) return null;

  const eligible = (
    await judgeCombinations(client, workspaceId, definitionId, versions, now)
  ).filter((judgement) => judgement.shortfalls.length === 0);
  const sourcesByKey = await readCombinationSources(client, workspaceId, definitionId, eligible);
  const derivedByKey = await derivedFamiliesOf(
    client,
    workspaceId,
    definitionId,
    viewer.principalId,
  );
  const contentByVersion = new Map<number, WorkerWorkerDefinitionContent | null>();

  const listed: {
    readonly candidate: Omit<CombinationCandidateWire, 'specRef' | 'specDigest'> & {
      readonly specDigest: string;
    };
    readonly readable: boolean;
  }[] = [];
  for (const judgement of eligible) {
    const key = combinationKey(judgement.version, judgement.specDigest);
    const sources = sourcesByKey.get(key) ?? [];
    const first = sources[0];
    if (!first) continue;
    const readable = sources.find((source) => viewer.canReadGoal(source));
    let definition: Record<string, unknown> | null = null;
    if (readable) {
      if (!contentByVersion.has(judgement.version)) {
        contentByVersion.set(
          judgement.version,
          workerContentOf(
            await getWorkerDefinition(client, workspaceId, {
              definitionId,
              version: judgement.version,
            }),
          ),
        );
      }
      const base = contentByVersion.get(judgement.version) ?? null;
      if (base) {
        const { name: _name, ...merged } = mergeCombinationDefinition(base, readable.spec, '');
        definition = merged;
      }
    }
    listed.push({
      readable: readable !== undefined,
      candidate: {
        definitionId,
        version: judgement.version,
        specDigest: judgement.specDigest,
        fields: workerSpecFieldsOf(first.spec),
        evidence: evidenceWire(judgement.evidence),
        spec: readable && definition ? readable.spec : null,
        definition,
        derivedAs: derivedByKey.get(key) ?? [],
      },
    });
  }
  listed.sort(
    (a, b) =>
      b.candidate.evidence.achieved - a.candidate.evidence.achieved ||
      b.candidate.version - a.candidate.version,
  );
  // Labelled in the order sent; the digest only where a source is readable.
  const label = labelSpecs(
    new Set(listed.filter((entry) => entry.readable).map((entry) => entry.candidate.specDigest)),
  );
  const candidates = listed.map(
    ({ candidate }): CombinationCandidateWire => ({ ...candidate, ...label(candidate.specDigest) }),
  );
  return {
    definitionId,
    thresholds: {
      windowDays: COMBINATION_WINDOW_DAYS,
      minAchieved: COMBINATION_MIN_ACHIEVED,
      minGoals: COMBINATION_MIN_GOALS,
      minRate: COMBINATION_MIN_RATE,
    },
    candidates,
  };
}

export interface ProposeDefinitionFromCombinationInput {
  readonly definitionId: string;
  readonly version: number;
  readonly specDigest: string;
  readonly name: string;
}

/** What `propose_definition_from_combination` wrote, and where the content came from (the audit
 *  record's). */
export interface ProposedDefinitionFromCombination {
  readonly row: WorkerDefinitionRow;
  readonly evidence: CombinationEvidenceWire;
  readonly source: Pick<CombinationSource, 'goalRunId' | 'planRevision' | 'stepKey'>;
}

/**
 * `propose_definition_from_combination`: judges the combination again (F1), takes the WorkerSpec
 * from a goal the caller can read (F7), writes the merged content (F4) as a new family's version 1
 * draft, the caller's, and records the derivation (F5). Refuses, nothing written: an unknown base
 * version, a draft or an entry definition (`WorkerDefinitionNotFoundError`), a combination that
 * does not qualify ({@link CombinationNotEligibleError}), one with no readable source
 * ({@link CombinationNotFoundError}), content the WorkerDefinition schema refuses
 * (`WorkerDefinitionValidationError`).
 */
export async function proposeDefinitionFromCombination(
  client: PoolClient,
  workspaceId: string,
  proposer: { readonly principalId: string; readonly canReadGoal: CanReadGoal },
  input: ProposeDefinitionFromCombinationInput,
  now: Date = new Date(),
): Promise<ProposedDefinitionFromCombination> {
  const baseRow = await getWorkerDefinition(client, workspaceId, {
    definitionId: input.definitionId,
    version: input.version,
  });
  const base = baseRow && baseRow.status !== 'draft' ? workerContentOf(baseRow) : null;
  if (!baseRow || !base) {
    throw new WorkerDefinitionNotFoundError(workspaceId, input.definitionId, input.version);
  }
  const judgement = (
    await judgeCombinations(
      client,
      workspaceId,
      input.definitionId,
      [{ version: baseRow.version, status: baseRow.status, kind: baseRow.kind }],
      now,
    )
  ).find((candidate) => candidate.specDigest === input.specDigest);
  const evidence = judgement?.evidence ?? NO_EVIDENCE;
  const shortfalls =
    judgement?.shortfalls ?? combinationShortfalls(NO_EVIDENCE, baseRow.status === 'published');
  if (shortfalls.length > 0) {
    throw new CombinationNotEligibleError(shortfalls, evidenceWire(evidence));
  }
  const sources =
    (
      await readCombinationSources(client, workspaceId, input.definitionId, [
        { version: input.version, specDigest: input.specDigest },
      ])
    ).get(combinationKey(input.version, input.specDigest)) ?? [];
  const source = sources.find((candidate) => proposer.canReadGoal(candidate));
  if (!source) {
    throw new CombinationNotFoundError(input.definitionId, input.version, input.specDigest);
  }

  const definition = mergeCombinationDefinition(base, source.spec, input.name);
  validateWorkerDefinitionContent('worker', definition);
  const draft = await proposeWorkerDefinition(client, workspaceId, proposer.principalId, {
    kind: 'worker',
    definition,
    origin: 'human',
  });
  const derivedFrom = await recordDefinitionDerivation(client, workspaceId, {
    definitionId: draft.id,
    base: { definitionId: input.definitionId, version: input.version },
    specDigest: input.specDigest,
    evidence: evidenceWire(evidence),
    derivedBy: proposer.principalId,
  });
  return {
    row: { ...draft, derivedFrom },
    evidence: evidenceWire(evidence),
    source: {
      goalRunId: source.goalRunId,
      planRevision: source.planRevision,
      stepKey: source.stepKey,
    },
  };
}
