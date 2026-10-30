import { z } from 'zod';
import { OPERATION_NAME_MAX } from './action-description.js';
import { type PredicateJsonValue, PredicateSchema, isPredicateJsonValue } from './predicate.js';

/**
 * eval-case (S10 E3-1b; docs/s10-evolution-plan-2026-10-04.md §3.1 EvalSuite, §3.3 I-E4, §5.5,
 * §5.6 用例集详情): one case of an evaluation suite, as a person writes it and the kernel keeps it.
 *
 *   - **Fixed when written, never changed** (E3-1 fork 6): its `partition` — `regression` (the
 *     ratchet: kept passing), `mechanism` (aimed at one failure mechanism, named by `mechanism`) or
 *     `full` (the confirmation run) — and its `split`, `dev` or `holdout` (§5.5 封闭: an agent sees
 *     verdicts on `dev` only, never a `holdout` case's content). An edit keeps all three; another
 *     partition or split is another case. `origin` is `human` (E3-1 writes only those).
 *   - `input` — what the evaluated Worker is given, as `invoke_worker` takes a Task's input.
 *   - `fixtures` — how every call the Worker makes to the suite's fixture gates is answered (E3-1
 *     fork 4 = a): an ordered list of rules, each for one Operation of one fixture gate, with an
 *     optional `when` judged on the call's params; the first rule that matches answers — with
 *     `data` (the result the gate would return; for an execute-class Operation, the simulated
 *     outcome: nothing is ever executed), `absent` (the gate confirms what the call names is not
 *     there — only for an observe-class Operation that declares such answers, as in production) or
 *     an `error`. A call no rule matches is answered with a fixed "the fixture has no answer"
 *     error, recorded on the run (E3-2).
 *   - `assertions` — what makes the case pass (fork 5 = a): each a `Predicate` judged on the
 *     document `{result, calls}` — `result` the Worker's result contract as reported
 *     (`report_task_result`: `summary`, `output`, …), `calls` every fixture call it made, in order,
 *     each an {@link EvalCallRecord}. The case passes when every assertion is satisfied.
 *
 * A person sees all of it; an agent none of it (I-E4) — the kernel keeps it in `eval_cases`, read
 * and written through human-channel capabilities only.
 */

export const EVAL_CASE_PARTITION_VALUES = ['regression', 'mechanism', 'full'] as const;
export const EvalCasePartitionSchema = z.enum(EVAL_CASE_PARTITION_VALUES);
export type EvalCasePartition = z.infer<typeof EvalCasePartitionSchema>;

export const EVAL_CASE_SPLIT_VALUES = ['dev', 'holdout'] as const;
export const EvalCaseSplitSchema = z.enum(EVAL_CASE_SPLIT_VALUES);
export type EvalCaseSplit = z.infer<typeof EvalCaseSplitSchema>;

/** Where a case came from. E3-1 writes only cases people wrote. */
export const EVAL_CASE_ORIGIN_VALUES = ['human'] as const;
export const EvalCaseOriginSchema = z.enum(EVAL_CASE_ORIGIN_VALUES);
export type EvalCaseOrigin = z.infer<typeof EvalCaseOriginSchema>;

/** The longest title, in characters. */
export const EVAL_CASE_TITLE_MAX = 120;
/** The longest mechanism tag, in characters. */
export const EVAL_CASE_MECHANISM_MAX = 120;
/** The largest input, serialized as JSON, in bytes. */
export const EVAL_CASE_INPUT_MAX_BYTES = 16_384;
/** The largest `data` one fixture answer holds, serialized as JSON, in bytes. */
export const EVAL_FIXTURE_DATA_MAX_BYTES = 16_384;
/** The longest error message a fixture answers with, in characters. */
export const EVAL_FIXTURE_ERROR_MAX = 500;
/** How many fixture rules one case has at most. */
export const EVAL_CASE_MAX_FIXTURE_RULES = 64;
/** How many assertions one case has at most (at least one). */
export const EVAL_CASE_MAX_ASSERTIONS = 16;
/** The longest note an assertion carries, in characters. */
export const EVAL_ASSERTION_NOTE_MAX = 200;
/** The largest whole case (title, input, fixtures, assertions), serialized as JSON, in bytes. */
export const EVAL_CASE_MAX_BYTES = 65_536;

/** The fields an assertion reads at the root of the document it is judged on. */
export const EVAL_ASSERTION_ROOTS = ['result', 'calls'] as const;

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const JsonValueSchema = z.custom<PredicateJsonValue>(
  (value) => value !== undefined && isPredicateJsonValue(value),
  { message: 'must be a JSON value' },
);

const FixtureDataSchema = JsonValueSchema.refine(
  (data) => jsonBytes(data) <= EVAL_FIXTURE_DATA_MAX_BYTES,
  { message: `data is larger than ${EVAL_FIXTURE_DATA_MAX_BYTES} bytes` },
);

/** How a matching call is answered. */
export const EvalFixtureAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('data'), data: FixtureDataSchema }).strict(),
  z.object({ kind: z.literal('absent') }).strict(),
  z
    .object({
      kind: z.literal('error'),
      message: z.string().trim().min(1).max(EVAL_FIXTURE_ERROR_MAX),
    })
    .strict(),
]);
export type EvalFixtureAnswer = z.infer<typeof EvalFixtureAnswerSchema>;
export type EvalFixtureAnswerKind = EvalFixtureAnswer['kind'];

/** One rule: which call it answers and how. `when`, when given, is judged on the call's params
 *  (its paths read the params object: `container`, `filters.name`). */
export const EvalFixtureRuleSchema = z
  .object({
    gatekeeperId: z.guid(),
    operation: z.string().min(1).max(OPERATION_NAME_MAX),
    when: PredicateSchema.optional(),
    answer: EvalFixtureAnswerSchema,
  })
  .strict();
export type EvalFixtureRule = z.infer<typeof EvalFixtureRuleSchema>;

/** One thing the case requires of a run, and an optional note saying what it checks. */
export const EvalAssertionSchema = z
  .object({
    expect: PredicateSchema,
    note: z.string().trim().min(1).max(EVAL_ASSERTION_NOTE_MAX).optional(),
  })
  .strict();
export type EvalAssertion = z.infer<typeof EvalAssertionSchema>;

/** What a person writes of a case and may change in an edit — the fields, for a capability's
 *  params to spread. The whole case is bounded too ({@link evalCaseSizeProblem}). */
export const evalCaseContentFields = {
  title: z.string().trim().min(1).max(EVAL_CASE_TITLE_MAX),
  input: JsonValueSchema.refine(
    (input) => input !== null && !(typeof input === 'string' && input.trim() === ''),
    { message: 'the input says what the Worker is asked to do — it cannot be empty' },
  ).refine((input) => jsonBytes(input) <= EVAL_CASE_INPUT_MAX_BYTES, {
    message: `the input is larger than ${EVAL_CASE_INPUT_MAX_BYTES} bytes`,
  }),
  fixtures: z.array(EvalFixtureRuleSchema).max(EVAL_CASE_MAX_FIXTURE_RULES),
  assertions: z.array(EvalAssertionSchema).min(1).max(EVAL_CASE_MAX_ASSERTIONS),
};
export const EvalCaseContentSchema = z.object(evalCaseContentFields).strict();
export type EvalCaseContent = z.infer<typeof EvalCaseContentSchema>;

/** Why `content` is too large to keep, or `null`. */
export function evalCaseSizeProblem(content: EvalCaseContent): string | null {
  return jsonBytes(content) > EVAL_CASE_MAX_BYTES
    ? `a case is larger than ${EVAL_CASE_MAX_BYTES} bytes`
    : null;
}

/** The fields fixed when a case is written — for a capability's params to spread. `mechanism` is
 *  given exactly when `partition` is `mechanism` ({@link evalCaseKindProblem}). */
export const evalCaseKindFields = {
  partition: EvalCasePartitionSchema,
  split: EvalCaseSplitSchema,
  mechanism: z.string().trim().min(1).max(EVAL_CASE_MECHANISM_MAX).optional(),
};
export const EvalCaseKindSchema = z.object(evalCaseKindFields).strict();
export type EvalCaseKind = z.infer<typeof EvalCaseKindSchema>;

/** Why `kind` does not hold together, or `null`. */
export function evalCaseKindProblem(kind: EvalCaseKind): string | null {
  return (kind.partition === 'mechanism') === (kind.mechanism !== undefined)
    ? null
    : 'a mechanism case names the mechanism it aims at; no other case names one';
}

/** How an evaluated run's fixture call was answered: by a rule's `data`, `absent` or `error`, or
 *  `unanswered` — no rule matched. */
export const EVAL_CALL_ANSWER_VALUES = ['data', 'absent', 'error', 'unanswered'] as const;
export type EvalCallAnswer = (typeof EVAL_CALL_ANSWER_VALUES)[number];

/** One element of `calls` in the document an assertion is judged on (E3-2 records them). */
export interface EvalCallRecord {
  readonly gatekeeperId: string;
  /** The fixture gate's name, as the Worker's tool list showed it. */
  readonly gate: string;
  readonly operation: string;
  readonly mode: 'observe' | 'execute';
  readonly params: Record<string, unknown>;
  readonly answer: EvalCallAnswer;
}

// ----- call counts ----------------------------------------------------------------------------

/** A string as a JMESPath JSON literal (`` `"…"` ``). A backtick in it is written as JSON's
 *  `\u0060`, not JMESPath's `` \` `` escape, which jmespath 0.16 undoes only once per literal. */
function jmespathLiteral(value: string): string {
  return `\`${JSON.stringify(value).replace(/`/g, '\\u0060')}\``;
}

/**
 * The path that counts a run's calls of one Operation of one fixture gate — what the case editor
 * writes for 「调用过 / 没有调用 / 至多 n 次」 (with `gte 1`, `eq 0`, `lte n`), and
 * {@link parseEvalCallCountPath} reads back.
 */
export function evalCallCountPath(gatekeeperId: string, operation: string): string {
  return `length(calls[?gatekeeperId==${jmespathLiteral(gatekeeperId)} && operation==${jmespathLiteral(operation)}])`;
}

const CALL_COUNT_PATH =
  /^length\(calls\[\?gatekeeperId==`("[0-9a-f-]{36}")` && operation==`(".*")`\]\)$/;

/** The gate and Operation an {@link evalCallCountPath} counts, or `null` for any other path. */
export function parseEvalCallCountPath(
  path: string,
): { readonly gatekeeperId: string; readonly operation: string } | null {
  const match = CALL_COUNT_PATH.exec(path);
  if (!match) return null;
  try {
    const gatekeeperId = JSON.parse(match[1] as string) as unknown;
    const operation = JSON.parse(match[2] as string) as unknown;
    if (typeof gatekeeperId !== 'string' || typeof operation !== 'string') return null;
    return evalCallCountPath(gatekeeperId, operation) === path ? { gatekeeperId, operation } : null;
  } catch {
    return null;
  }
}

/** The path to one top-level field of the Worker's `output` (`result.output.<field>`), the name
 *  quoted when it is not a plain identifier. */
export function evalOutputFieldPath(field: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field)
    ? `result.output.${field}`
    : `result.output.${JSON.stringify(field)}`;
}

/** The field an {@link evalOutputFieldPath} reads, or `null` for any other path. */
export function parseEvalOutputFieldPath(path: string): string | null {
  if (!path.startsWith('result.output.')) return null;
  const rest = path.slice('result.output.'.length);
  let field: unknown = rest;
  if (rest.startsWith('"')) {
    try {
      field = JSON.parse(rest);
    } catch {
      return null;
    }
  }
  if (typeof field !== 'string' || field === '') return null;
  return evalOutputFieldPath(field) === path ? field : null;
}

/** The path to the Worker's result summary. */
export const EVAL_SUMMARY_PATH = 'result.summary';
