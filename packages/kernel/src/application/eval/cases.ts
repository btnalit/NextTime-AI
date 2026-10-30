import {
  EVAL_ASSERTION_ROOTS,
  type EvalCaseContent,
  type EvalCaseKind,
  type EvalCaseWire,
  type EvalSuiteWire,
  evalCaseKindProblem,
  evalCaseSizeProblem,
  predicateLeaves,
  visibleLines,
  visibleText,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  RedactedTextSubmittedError,
  TextCarriesCredentialsError,
  findSuspectedSecrets,
  redactedPathsIn,
  refuseCredentialText,
  refuseRedactedText,
  shownFreeText,
} from '../../governance/redaction/index.js';
import { bindingPathProblems, documentPathProblems } from '../../substrate/epistemic/index.js';
import {
  CASE_COLUMNS,
  type CaseRow,
  type LiveGateSnapshots,
  caseDigest,
  caseWire,
  readLiveGateSnapshots,
} from './case-reads.js';
import { EvalCaseNotFoundError, EvalSuiteInputError, EvalSuiteStateError } from './errors.js';
import { declaresAbsence } from './snapshot.js';
import {
  type EvalSuiteActor,
  type EvalSuiteChangeTarget,
  checkedReason,
  getEvalSuite,
  holdSuiteAt,
  nextVersion,
  readSuite,
  recordChange,
} from './suites.js';

/**
 * application/eval/cases: a suite's cases (S10 E3-1b; `@nexttime/shared` eval-case.ts says what
 * one holds) — adding one, editing one (its row retired, a new one superseding it), retiring one,
 * and reading one whole. Table: `eval_cases` (migrations/worker/0008, whose guards refuse what
 * this module never writes). Each change is a suite version, made as `suites.ts` makes every other
 * one: hold the suite at the version the person looked at, step it, write, record the change.
 *
 * What a case may hold is checked here, whatever the suite's state, before anything is written
 * (400 invalid_params, every problem named): a mechanism named exactly for a mechanism case; every
 * fixture rule on a fixture gate the suite holds and one of its frozen Operations, an `absent`
 * answer only where that Operation declares "not there" answers; every path compiling, and an
 * assertion's reading `result` or `calls` (`documentPathProblems`); nothing a reader cannot see
 * (an invisible or reordering character — a read would show it escaped, and an edit opened on that
 * read would change the case); and the whole case within bounds. No part of it may carry a
 * suspected credential or the `[redacted]` mark a read shows (the document rule a goal plan is
 * held to): the content is read back as written, and an evaluated Worker is given the input and
 * the fixture answers.
 */

export interface EvalCaseTarget extends EvalSuiteChangeTarget {
  readonly caseId: string;
}

/** Adds a case to the suite. */
export async function addEvalCase(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: EvalSuiteChangeTarget & EvalCaseKind & EvalCaseContent,
): Promise<EvalSuiteWire> {
  const kind: EvalCaseKind = {
    partition: target.partition,
    split: target.split,
    ...(target.mechanism !== undefined ? { mechanism: target.mechanism } : {}),
  };
  const content = contentOf(target);
  const kindProblem = evalCaseKindProblem(kind);
  if (kindProblem !== null) throw new EvalSuiteInputError(kindProblem);
  if (kind.mechanism !== undefined) {
    refuseCredentialText('mechanism', kind.mechanism);
    refuseRedactedText('mechanism', kind.mechanism);
    refuseUnseen('mechanism', kind.mechanism, false);
  }
  const suite = await holdSuiteAt(client, workspaceId, 'add_eval_case', target);
  checkContent(content, await readLiveGateSnapshots(client, workspaceId, suite.id));
  const version = await nextVersion(client, workspaceId, suite.id);
  const caseId = await insertCase(
    client,
    workspaceId,
    suite.id,
    actor,
    version,
    kind,
    content,
    null,
  );
  await recordChange(client, workspaceId, suite.id, version, actor, 'case_added', null, {
    caseId,
    title: content.title,
    partition: kind.partition,
    split: kind.split,
  });
  return getEvalSuite(client, workspaceId, suite.id);
}

/** Changes a case the suite holds: retires its row and adds one superseding it, the same partition,
 *  split and mechanism kept. */
export async function editEvalCase(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: EvalCaseTarget & EvalCaseContent & { readonly reason: string },
): Promise<EvalSuiteWire> {
  const reason = checkedReason(target.reason) as string;
  const content = contentOf(target);
  const suite = await holdSuiteAt(client, workspaceId, 'edit_eval_case', target);
  const current = await liveCase(client, workspaceId, suite.id, target.caseId);
  const kind: EvalCaseKind = {
    partition: current.partition,
    split: current.split,
    ...(current.mechanism !== null ? { mechanism: current.mechanism } : {}),
  };
  checkContent(content, await readLiveGateSnapshots(client, workspaceId, suite.id));
  if (caseDigest(kind, current.origin, content) === current.content_digest) {
    throw new EvalSuiteStateError(
      `case "${shownFreeText(current.title)}" already reads this way — nothing was changed`,
    );
  }
  const version = await nextVersion(client, workspaceId, suite.id);
  await retireCase(client, workspaceId, current.id, version, reason);
  const caseId = await insertCase(
    client,
    workspaceId,
    suite.id,
    actor,
    version,
    kind,
    content,
    current.id,
  );
  await recordChange(client, workspaceId, suite.id, version, actor, 'case_edited', reason, {
    caseId,
    supersedes: current.id,
    title: content.title,
    partition: kind.partition,
    split: kind.split,
  });
  return getEvalSuite(client, workspaceId, suite.id);
}

/** Takes a case out of the suite from the next version on, with a reason. */
export async function retireEvalCase(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: EvalCaseTarget & { readonly reason: string },
): Promise<EvalSuiteWire> {
  const reason = checkedReason(target.reason) as string;
  const suite = await holdSuiteAt(client, workspaceId, 'retire_eval_case', target);
  const current = await liveCase(client, workspaceId, suite.id, target.caseId);
  const version = await nextVersion(client, workspaceId, suite.id);
  await retireCase(client, workspaceId, current.id, version, reason);
  await recordChange(client, workspaceId, suite.id, version, actor, 'case_retired', reason, {
    caseId: current.id,
    title: current.title,
    partition: current.partition,
    split: current.split,
  });
  return getEvalSuite(client, workspaceId, suite.id);
}

/** One case row of the suite whole — one it holds now, or one an edit or a retirement took out. */
export async function getEvalCase(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  caseId: string,
): Promise<EvalCaseWire> {
  await readSuite(client, workspaceId, suiteId, false);
  const row = await readCase(client, workspaceId, suiteId, caseId);
  const successor = await client.query<{ id: string }>(
    'select id from eval_cases where workspace_id = $1 and supersedes = $2',
    [workspaceId, row.id],
  );
  return caseWire(
    row,
    await readLiveGateSnapshots(client, workspaceId, suiteId),
    successor.rows[0]?.id ?? null,
  );
}

// -------------------------------------------------------------------------------------------
// Internals
// -------------------------------------------------------------------------------------------

function contentOf(target: EvalCaseContent): EvalCaseContent {
  return {
    title: target.title,
    input: target.input,
    fixtures: target.fixtures,
    assertions: target.assertions,
  };
}

async function readCase(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  caseId: string,
): Promise<CaseRow> {
  const result = await client.query<CaseRow>(
    `select ${CASE_COLUMNS} from eval_cases where workspace_id = $1 and suite_id = $2 and id = $3`,
    [workspaceId, suiteId, caseId],
  );
  const row = result.rows[0];
  if (!row) throw new EvalCaseNotFoundError(caseId);
  return row;
}

/** The case row, refused unless the suite holds it now. */
async function liveCase(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  caseId: string,
): Promise<CaseRow> {
  const row = await readCase(client, workspaceId, suiteId, caseId);
  if (row.retired_in_version !== null) {
    throw new EvalSuiteStateError(
      `case "${shownFreeText(row.title)}" was taken out of the suite at version ${row.retired_in_version} — it is no longer the suite's to change`,
    );
  }
  return row;
}

async function insertCase(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
  actor: EvalSuiteActor,
  version: number,
  kind: EvalCaseKind,
  content: EvalCaseContent,
  supersedes: string | null,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into eval_cases
       (workspace_id, suite_id, title, partition, split, mechanism, origin, input, fixtures,
        assertions, content_digest, added_in_version, supersedes, created_by)
     values ($1, $2, $3, $4, $5, $6, 'human', $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      workspaceId,
      suiteId,
      content.title,
      kind.partition,
      kind.split,
      kind.mechanism ?? null,
      JSON.stringify(content.input),
      JSON.stringify(content.fixtures),
      JSON.stringify(content.assertions),
      caseDigest(kind, 'human', content),
      version,
      supersedes,
      actor.principalId,
    ],
  );
  return inserted.rows[0]?.id as string;
}

async function retireCase(
  client: PoolClient,
  workspaceId: string,
  caseId: string,
  version: number,
  reason: string,
): Promise<void> {
  await client.query(
    `update eval_cases set retired_in_version = $3, retire_reason = $4
      where workspace_id = $1 and id = $2`,
    [workspaceId, caseId, version, reason],
  );
}

/** How many problems one refusal names at most. */
const MAX_PROBLEMS = 20;

/** Refuses `content` unless every rule in the module comment holds of it, against the suite's live
 *  fixture gates. */
function checkContent(content: EvalCaseContent, gates: LiveGateSnapshots): void {
  refuseCredentialText('title', content.title);
  refuseRedactedText('title', content.title);
  refuseUnseen('title', content.title, false);
  const document = {
    input: content.input,
    fixtures: content.fixtures,
    assertions: content.assertions,
  };
  const redacted = redactedPathsIn(document);
  if (redacted.length > 0) throw new RedactedTextSubmittedError(redacted[0] as string, redacted);
  const secrets = findSuspectedSecrets(document);
  if (secrets.count > 0) {
    const paths = secrets.paths.slice(0, MAX_PROBLEMS);
    throw new TextCarriesCredentialsError(paths[0] ?? 'input', secrets.count, paths);
  }

  const problems: string[] = [];
  const size = evalCaseSizeProblem(content);
  if (size !== null) problems.push(size);
  for (const place of unseenPlaces(document, '')) {
    problems.push(`${place} holds a character a reader cannot see — write it out`);
  }
  content.fixtures.forEach((rule, index) => {
    const at = `fixtures[${index}]`;
    const gate = gates.get(rule.gatekeeperId);
    if (gate === undefined) {
      problems.push(`${at}.gatekeeperId: ${rule.gatekeeperId} is not a fixture gate of the suite`);
      return;
    }
    const op = gate.operations.find((candidate) => candidate.name === rule.operation);
    if (op === undefined) {
      problems.push(
        `${at}.operation: fixture gate "${gate.gateName}" has no Operation "${visibleText(rule.operation)}"`,
      );
    } else if (rule.answer.kind === 'absent' && !declaresAbsence(op.operation)) {
      problems.push(
        `${at}.answer: "${visibleText(rule.operation)}" does not declare answers that mean "not there" — answer with data or an error`,
      );
    }
    for (const leaf of rule.when === undefined ? [] : predicateLeaves(rule.when)) {
      for (const problem of bindingPathProblems(leaf.path)) {
        problems.push(`${at}.when: ${problem.replace('the output', "the call's params")}`);
      }
    }
  });
  content.assertions.forEach((assertion, index) => {
    for (const leaf of predicateLeaves(assertion.expect)) {
      for (const problem of documentPathProblems(leaf.path, EVAL_ASSERTION_ROOTS)) {
        problems.push(`assertions[${index}].expect: ${problem}`);
      }
    }
  });
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    throw new EvalSuiteInputError(
      `the case cannot be kept as written: ${shown.join('; ')}${problems.length > shown.length ? `; and ${problems.length - shown.length} more` : ''} — nothing was changed`,
    );
  }
}

/** Refuses one line of text holding a character a reader cannot see (`multiline` keeps line breaks
 *  and tabs). */
function refuseUnseen(field: string, text: string, multiline: boolean): void {
  if ((multiline ? visibleLines(text) : visibleText(text)) !== text) {
    throw new EvalSuiteInputError(
      `${field} holds a character a reader cannot see — write it out; nothing was changed`,
    );
  }
}

/** Where `value` holds a string (a key or a value) with a character a reader cannot see, line
 *  breaks and tabs aside. */
function unseenPlaces(value: unknown, path: string): string[] {
  if (typeof value === 'string')
    return visibleLines(value) === value ? [] : [path || '(the value)'];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unseenPlaces(item, `${path}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => {
    const at = path === '' ? key : `${path}.${key}`;
    return [...(visibleLines(key) === key ? [] : [`${at} (its name)`]), ...unseenPlaces(inner, at)];
  });
}
