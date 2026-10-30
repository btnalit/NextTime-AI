import { createHash } from 'node:crypto';
import { canonicalJson } from '@nexttime/gatekeeper-base';
import type {
  EvalAssertion,
  EvalCaseContent,
  EvalCaseKind,
  EvalCaseOrigin,
  EvalCasePartition,
  EvalCaseSplit,
  EvalCaseSummaryWire,
  EvalCaseWire,
  EvalFixtureProblemWire,
  EvalFixtureRule,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { shownFreeText, shownFreeTextIn } from '../../governance/redaction/index.js';
import { type FixtureGateSnapshot, declaresAbsence } from './snapshot.js';

/**
 * application/eval/case-reads: a suite's cases as people read them (S10 E3-1b) — the rows of
 * `eval_cases` (migrations/worker/0008) a suite holds at its current version, each in brief or
 * whole, and the fixture rules a fixture gate sync or removal left without a match. Shared by the
 * suite reads (`suites.ts`) and the case changes (`cases.ts`), so neither imports the other.
 */

export interface CaseRow {
  readonly id: string;
  readonly suite_id: string;
  readonly title: string;
  readonly partition: EvalCasePartition;
  readonly split: EvalCaseSplit;
  readonly mechanism: string | null;
  readonly origin: EvalCaseOrigin;
  readonly input: unknown;
  readonly fixtures: readonly EvalFixtureRule[];
  readonly assertions: readonly EvalAssertion[];
  readonly content_digest: string;
  readonly added_in_version: number;
  readonly retired_in_version: number | null;
  readonly retire_reason: string | null;
  readonly supersedes: string | null;
  readonly created_by: string;
  readonly created_at: Date;
}

export const CASE_COLUMNS = `id, suite_id, title, partition, split, mechanism, origin, input, fixtures,
  assertions, content_digest, added_in_version, retired_in_version, retire_reason, supersedes,
  created_by, created_at`;

/** A suite's live fixture gates, by Gatekeeper id, as frozen. */
export type LiveGateSnapshots = ReadonlyMap<string, FixtureGateSnapshot>;

/** The cases the suites hold at their current version (every suite of the workspace when
 *  `suiteId` is not given), oldest first. */
export async function readLiveCases(
  client: PoolClient,
  workspaceId: string,
  suiteId?: string,
): Promise<CaseRow[]> {
  const result = await client.query<CaseRow>(
    `select ${CASE_COLUMNS} from eval_cases
      where workspace_id = $1 and retired_in_version is null and ($2::uuid is null or suite_id = $2)
      order by added_in_version, created_at, id`,
    [workspaceId, suiteId ?? null],
  );
  return result.rows;
}

/** The suite's live fixture gates' snapshots, by Gatekeeper id. */
export async function readLiveGateSnapshots(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
): Promise<LiveGateSnapshots> {
  const result = await client.query<{ gatekeeper_id: string; snapshot: FixtureGateSnapshot }>(
    `select gatekeeper_id, snapshot from eval_fixture_gates
      where workspace_id = $1 and suite_id = $2 and retired_in_version is null`,
    [workspaceId, suiteId],
  );
  return new Map(result.rows.map((row) => [row.gatekeeper_id, row.snapshot]));
}

/** The rules of `fixtures` that no longer find what they answer among `gates`, and why. */
export function fixtureProblemsOf(
  fixtures: readonly EvalFixtureRule[],
  gates: LiveGateSnapshots,
): EvalFixtureProblemWire[] {
  const problems: EvalFixtureProblemWire[] = [];
  fixtures.forEach((rule, index) => {
    const gate = gates.get(rule.gatekeeperId);
    if (gate === undefined) {
      problems.push({ index, problem: 'gate_not_in_suite' });
      return;
    }
    const op = gate.operations.find((candidate) => candidate.name === rule.operation);
    if (op === undefined) {
      problems.push({ index, problem: 'operation_not_on_gate' });
      return;
    }
    if (rule.answer.kind === 'absent' && !declaresAbsence(op.operation)) {
      problems.push({ index, problem: 'absent_not_declared' });
    }
  });
  return problems;
}

/** `sha256:` over a case's fixed fields and content — the same for the same case written twice,
 *  whatever order its object keys came in. */
export function caseDigest(
  kind: EvalCaseKind,
  origin: EvalCaseOrigin,
  content: EvalCaseContent,
): string {
  const document = {
    partition: kind.partition,
    split: kind.split,
    mechanism: kind.mechanism ?? null,
    origin,
    title: content.title,
    input: content.input,
    fixtures: content.fixtures,
    assertions: content.assertions,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex')}`;
}

/** One case in brief. `gates` are the suite's live fixture gates; a retired row has no problems
 *  to report (the suite no longer holds it). */
export function caseSummaryWire(row: CaseRow, gates: LiveGateSnapshots): EvalCaseSummaryWire {
  return {
    id: row.id,
    title: shownFreeText(row.title),
    partition: row.partition,
    split: row.split,
    mechanism: row.mechanism === null ? null : shownFreeText(row.mechanism),
    origin: row.origin,
    addedInVersion: row.added_in_version,
    addedBy: row.created_by,
    addedAt: row.created_at.toISOString(),
    supersedes: row.supersedes,
    fixtureRuleCount: row.fixtures.length,
    assertionCount: row.assertions.length,
    fixtureProblems: row.retired_in_version === null ? fixtureProblemsOf(row.fixtures, gates) : [],
  };
}

/** One case whole, as every read shows free text. */
export function caseWire(
  row: CaseRow,
  gates: LiveGateSnapshots,
  supersededBy: string | null,
): EvalCaseWire {
  return {
    ...caseSummaryWire(row, gates),
    suiteId: row.suite_id,
    input: shownFreeTextIn(row.input),
    fixtures: shownFreeTextIn(row.fixtures) as EvalFixtureRule[],
    assertions: shownFreeTextIn(row.assertions) as EvalAssertion[],
    contentDigest: row.content_digest,
    retiredInVersion: row.retired_in_version,
    retireReason: row.retire_reason === null ? null : shownFreeText(row.retire_reason),
    supersededBy,
  };
}
