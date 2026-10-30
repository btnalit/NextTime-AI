import {
  EVAL_CASE_INPUT_MAX_BYTES,
  EVAL_CASE_MAX_ASSERTIONS,
  EVAL_CASE_MAX_FIXTURE_RULES,
  EVAL_FIXTURE_DATA_MAX_BYTES,
  EVAL_SUMMARY_PATH,
  type EvalAssertion,
  type EvalCaseContent,
  type EvalCasePartition,
  type EvalCaseSplit,
  type EvalCaseWire,
  type EvalFixtureAnswerKind,
  type EvalFixtureGateWire,
  type EvalFixtureOperationWire,
  type EvalFixtureProblemKind,
  type EvalFixtureRule,
  type Predicate,
  PredicateSchema,
  evalCallCountPath,
  evalOutputFieldPath,
  parseEvalCallCountPath,
  parseEvalOutputFieldPath,
} from '@nexttime/shared';
import { type FieldErrors, fieldErrorsFromIssues } from './catalog.js';
import type { ErrorOverrides } from './errors.js';
import { shownName, writeErrors } from './evaluation.js';
import { actionKindTagText } from './format.js';
import { predicateSentence } from './goals.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import {
  type PredicateDraft,
  type PredicateOp,
  type PredicateValueKind,
  emptyPredicateDraft,
  predicateDraftFrom,
  predicateDraftProblems,
  predicateFromDraft,
  predicateValueDraft,
  predicateValueKinds,
  predicateValueOf,
  predicateValueProblem,
} from './predicate-draft.js';

/**
 * lib/eval-cases (S10 E3-1b): a suite's case as the case editor holds it while a person writes it,
 * and as the case's view says it. A case (`@nexttime/shared` eval-case.ts) is a title, the kind
 * fixed when it is written (partition, split, mechanism), the input the Worker is given, ordered
 * fixture rules answering the Worker's calls to the suite's fixture gates, and assertions judged
 * on `{result, calls}`.
 *
 * Nothing that can be picked is typed: a rule's gate and Operation, the parameter a rule's
 * condition reads and an assertion's gate and Operation come from the suite's fixture gates (their
 * frozen definitions); the common assertions are templates the editor writes as predicates and
 * reads back (`assertionDraftOf`) — 结果摘要包含、输出字段等于、调用过、没有调用、至多 n 次. What a
 * template or a one-parameter condition cannot say is a predicate in `lib/predicate-draft`'s
 * editor (conditions, groups, or JSON), so editing a case never drops what it said.
 *
 * Errors are keyed by place, as `lib/catalog`'s forms key theirs: `input`, and `<uid>.<part>` for
 * a rule's or an assertion's own field — a predicate's errors under `<uid>.when` / `<uid>.expect`
 * by the predicate's own paths (`errorsUnder`).
 */

// ----- labels ---------------------------------------------------------------------------------

export function partitionHint(partition: EvalCasePartition, t: Translate): string {
  switch (partition) {
    case 'regression':
      return t(
        '已经做对的行为，之后的版本要一直通过（回归棘轮）。',
        'Behaviour already right, which later versions must keep passing (the regression ratchet).',
      );
    case 'mechanism':
      return t(
        '针对一种失败机制（写在「机制」里），用来验证这个机制的修复。',
        'Aimed at one failure mechanism (named under Mechanism), to verify a fix for it.',
      );
    case 'full':
      return t('确认时整套跑的用例。', 'Run as a whole set for confirmation.');
  }
}

/** How many characters in a row of a holdout case's text (normalized: NFKC, lower case, blanks
 *  folded) the kernel treats as a copy of it and withholds from agents — `SEAL_SPAN_CHARS` in the
 *  kernel's `application/eval-seal/span-index.ts` (S10 E3-1c). */
export const HOLDOUT_SEAL_SPAN_CHARS = 40;

/** Legacy 516 (#813's note): holdout text is withheld from agents wherever it turns up, so a stock
 *  phrase or a passage copied from real data in a holdout case also stops the same text in real
 *  work. Fixture answer data is not indexed, so it is not named. */
export function holdoutTextNotice(t: Translate): string {
  const n = HOLDOUT_SEAL_SPAN_CHARS;
  return t(
    `holdout 用例的文字（标题、机制、输入、规则的条件和断言）会对智能体封闭：交给智能体的任何内容里，只要原样出现其中连续 ${n} 个字符，就会被拦下。所以要写得具体，不要用常见套话或通用说明，也不要整段照抄真实数据或日志，否则真实工作里出现同样的文字也会被拦。夹具应答的数据不算在内。`,
    `A holdout case’s text (title, mechanism, input, rule conditions and assertions) is withheld from agents: anything an agent is given that carries ${n} characters of it in a row is stopped. Write it specifically — no stock phrases or generic instructions, and no passages copied whole from real data or logs — or the same text in real work is stopped too. Fixture answer data does not count.`,
  );
}

export function splitHint(split: EvalCaseSplit, t: Translate): string {
  return split === 'dev'
    ? t(
        'dev：改进 Worker 时可以参考它的评测结论。',
        'dev: its verdicts may be consulted while improving the Worker.',
      )
    : t(
        'holdout：只用于最终确认，智能体永远看不到它的内容。',
        'holdout: used only for the final confirmation; no agent ever sees its content.',
      );
}

export function fixtureProblemText(problem: EvalFixtureProblemKind, t: Translate): string {
  switch (problem) {
    case 'gate_not_in_suite':
      return t(
        '这条规则的夹具门已不在用例集里，它不会再回答任何调用。',
        'This rule’s fixture gate is no longer in the suite; it answers no call any more.',
      );
    case 'operation_not_on_gate':
      return t(
        '夹具门同步后已没有这个操作，这条规则不会再回答任何调用。',
        'Since a sync the fixture gate no longer has this operation; this rule answers no call any more.',
      );
    case 'absent_not_declared':
      return t(
        '这个操作同步后不再声明“不存在”的回答，这条规则回答不了。改成返回数据或报错。',
        'Since a sync this operation no longer declares a “not there” answer, so this rule cannot answer. Answer with data or an error.',
      );
  }
}

/** 「2 条夹具规则需要处理」 */
export function fixtureProblemCountText(count: number, t: Translate): string {
  return t(`${count} 条夹具规则需要处理`, `${count} fixture rule(s) need attention`);
}

/** The suite's frozen Operation, when it still has it. */
export function fixtureOperation(
  gates: readonly EvalFixtureGateWire[],
  gatekeeperId: string,
  operation: string,
): EvalFixtureOperationWire | undefined {
  return gates
    .find((gate) => gate.gatekeeperId === gatekeeperId)
    ?.operations.find((op) => op.name === operation);
}

/** 「hosts · hosts.restart」: a fixture gate's Operation as the case pages name it. */
export function gateOperationText(
  gates: readonly EvalFixtureGateWire[],
  gatekeeperId: string,
  operation: string,
  t: Translate,
): string {
  const gate = gates.find((candidate) => candidate.gatekeeperId === gatekeeperId);
  const gateName =
    gate === undefined
      ? t('（已不在用例集里的门）', '(a gate no longer in the suite)')
      : shownName(gate.gateName);
  return `${gateName} · ${actionKindTagText(operation)}`;
}

/** The top-level parameters an Operation's `paramsSchema` names, in its order. */
export function operationParams(op: EvalFixtureOperationWire | undefined): readonly string[] {
  const properties = op?.paramsSchema.properties;
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

// ----- drafts ---------------------------------------------------------------------------------

let uidCounter = 0;
function newUid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/** When a rule answers: any call of its Operation, a call whose one parameter compares so, or a
 *  call whose params satisfy a predicate. */
export type WhenMode = 'always' | 'param' | 'predicate';

export interface FixtureRuleDraft {
  /** React key and error place; never sent. */
  readonly uid: string;
  readonly gatekeeperId: string;
  readonly operation: string;
  readonly whenMode: WhenMode;
  readonly whenParam: string;
  readonly whenOp: PredicateOp;
  readonly whenValueKind: PredicateValueKind;
  readonly whenValueText: string;
  readonly whenPredicate: PredicateDraft;
  readonly answer: EvalFixtureAnswerKind;
  readonly dataText: string;
  readonly errorMessage: string;
}

export type AssertionTemplate =
  | 'summary_contains'
  | 'output_equals'
  | 'called'
  | 'not_called'
  | 'at_most'
  | 'predicate';
export const ASSERTION_TEMPLATES: readonly AssertionTemplate[] = [
  'summary_contains',
  'output_equals',
  'called',
  'not_called',
  'at_most',
  'predicate',
];

/** The templates that count calls of one fixture gate Operation. */
export function countsCalls(template: AssertionTemplate): boolean {
  return template === 'called' || template === 'not_called' || template === 'at_most';
}

export function assertionTemplateLabel(template: AssertionTemplate, t: Translate): string {
  switch (template) {
    case 'summary_contains':
      return t('结果摘要包含', 'Result summary contains');
    case 'output_equals':
      return t('输出字段等于', 'Output field equals');
    case 'called':
      return t('调用过', 'Called');
    case 'not_called':
      return t('没有调用', 'Never called');
    case 'at_most':
      return t('调用至多 n 次', 'Called at most n times');
    case 'predicate':
      return t('自定义条件', 'Custom condition');
  }
}

export interface AssertionDraft {
  readonly uid: string;
  readonly template: AssertionTemplate;
  /** 结果摘要包含 */
  readonly text: string;
  /** 输出字段等于 */
  readonly field: string;
  readonly valueKind: PredicateValueKind;
  readonly valueText: string;
  /** 调用过 / 没有调用 / 至多 n 次 */
  readonly gatekeeperId: string;
  readonly operation: string;
  readonly count: string;
  /** 自定义条件 */
  readonly predicate: PredicateDraft;
  readonly note: string;
}

export type InputMode = 'text' | 'json';

export interface CaseDraft {
  readonly title: string;
  readonly partition: EvalCasePartition | '';
  readonly split: EvalCaseSplit | '';
  readonly mechanism: string;
  readonly inputMode: InputMode;
  readonly inputText: string;
  readonly fixtures: readonly FixtureRuleDraft[];
  readonly assertions: readonly AssertionDraft[];
}

export function emptyRule(gatekeeperId = '', operation = ''): FixtureRuleDraft {
  return {
    uid: newUid('rule'),
    gatekeeperId,
    operation,
    whenMode: 'always',
    whenParam: '',
    whenOp: 'eq',
    whenValueKind: 'string',
    whenValueText: '',
    whenPredicate: emptyPredicateDraft(),
    answer: 'data',
    dataText: '',
    errorMessage: '',
  };
}

export function emptyAssertion(template: AssertionTemplate = 'summary_contains'): AssertionDraft {
  return {
    uid: newUid('assertion'),
    template,
    text: '',
    field: '',
    valueKind: 'string',
    valueText: '',
    gatekeeperId: '',
    operation: '',
    count: '',
    predicate: emptyPredicateDraft(),
    note: '',
  };
}

export function emptyCaseDraft(): CaseDraft {
  return {
    title: '',
    partition: '',
    split: '',
    mechanism: '',
    inputMode: 'text',
    inputText: '',
    fixtures: [],
    assertions: [emptyAssertion()],
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The path to one parameter of a call, as a rule's condition reads the params object. */
export function paramPath(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function paramOfPath(path: string): string | null {
  if (IDENTIFIER.test(path)) return path;
  if (!path.startsWith('"')) return null;
  try {
    const name = JSON.parse(path) as unknown;
    return typeof name === 'string' && paramPath(name) === path ? name : null;
  } catch {
    return null;
  }
}

/** A value kind the comparison takes: `current` while it still does. */
export function valueKindFor(op: PredicateOp, current: PredicateValueKind): PredicateValueKind {
  const kinds = predicateValueKinds(op);
  return kinds.includes(current) ? current : (kinds[0] ?? 'string');
}

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

function answerDraftOf(
  answer: EvalFixtureRule['answer'],
): Pick<FixtureRuleDraft, 'answer' | 'dataText' | 'errorMessage'> {
  switch (answer.kind) {
    case 'data':
      return { answer: 'data', dataText: prettyJson(answer.data), errorMessage: '' };
    case 'error':
      return { answer: 'error', dataText: '', errorMessage: answer.message };
    case 'absent':
      return { answer: 'absent', dataText: '', errorMessage: '' };
  }
}

function ruleDraftOf(
  rule: EvalFixtureRule,
  op: EvalFixtureOperationWire | undefined,
): FixtureRuleDraft {
  const base = { ...emptyRule(rule.gatekeeperId, rule.operation), ...answerDraftOf(rule.answer) };
  const when = rule.when;
  if (when === undefined) return base;
  if ('path' in when) {
    const param = paramOfPath(when.path);
    if (param !== null && operationParams(op).includes(param)) {
      const value =
        when.op === 'exists'
          ? { valueKind: 'string' as const, valueText: '' }
          : predicateValueDraft(when.value);
      return {
        ...base,
        whenMode: 'param',
        whenParam: param,
        whenOp: when.op,
        whenValueKind: value.valueKind,
        whenValueText: value.valueText,
      };
    }
  }
  return { ...base, whenMode: 'predicate', whenPredicate: predicateDraftFrom(when) };
}

/** An assertion as the template that writes it, or as a custom condition when none does. */
export function assertionDraftOf(assertion: EvalAssertion): AssertionDraft {
  const base = { ...emptyAssertion(), note: assertion.note ?? '' };
  const expect = assertion.expect;
  if ('path' in expect && expect.op !== 'exists') {
    const { path, op, value } = expect;
    if (path === EVAL_SUMMARY_PATH && op === 'contains' && typeof value === 'string') {
      return { ...base, template: 'summary_contains', text: value };
    }
    const field = parseEvalOutputFieldPath(path);
    if (field !== null && op === 'eq') {
      return { ...base, template: 'output_equals', field, ...predicateValueDraft(value) };
    }
    const call = parseEvalCallCountPath(path);
    if (call !== null) {
      const at = { ...base, gatekeeperId: call.gatekeeperId, operation: call.operation };
      if (op === 'gte' && value === 1) return { ...at, template: 'called' };
      if (op === 'eq' && value === 0) return { ...at, template: 'not_called' };
      if (op === 'lte' && typeof value === 'number' && Number.isInteger(value) && value >= 1) {
        return { ...at, template: 'at_most', count: String(value) };
      }
    }
  }
  return { ...base, template: 'predicate', predicate: predicateDraftFrom(expect) };
}

/** A case as the editor starts from it. */
export function caseDraftOf(
  evalCase: Pick<
    EvalCaseWire,
    'title' | 'partition' | 'split' | 'mechanism' | 'input' | 'fixtures' | 'assertions'
  >,
  gates: readonly EvalFixtureGateWire[],
): CaseDraft {
  const textInput = typeof evalCase.input === 'string';
  return {
    title: evalCase.title,
    partition: evalCase.partition,
    split: evalCase.split,
    mechanism: evalCase.mechanism ?? '',
    inputMode: textInput ? 'text' : 'json',
    inputText: textInput ? (evalCase.input as string) : prettyJson(evalCase.input),
    fixtures: evalCase.fixtures.map((rule) =>
      ruleDraftOf(rule, fixtureOperation(gates, rule.gatekeeperId, rule.operation)),
    ),
    assertions: evalCase.assertions.map(assertionDraftOf),
  };
}

// ----- building -------------------------------------------------------------------------------

export interface DraftCheck {
  /** What the save button still waits for, in the labels' words (for `StillNeeded`). */
  readonly missing: readonly string[];
  /** Each wrong field's problem, by place (see the module comment). */
  readonly errors: FieldErrors;
  /** The content when nothing is missing or wrong. */
  readonly content: EvalCaseContent | null;
}

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** A predicate draft as sent, its problems put under `prefix`: `undefined` while it has no
 *  condition, `null` when it has a problem. */
function predicateOf(
  draft: PredicateDraft,
  prefix: string,
  errors: Record<string, string>,
  t: Translate,
): Predicate | null | undefined {
  const value = predicateFromDraft(draft);
  if (value === undefined) return undefined;
  const own = [...predicateDraftProblems(draft, t)].map(
    ([path, message]) => [path === '' ? prefix : `${prefix}.${path}`, message] as const,
  );
  for (const [path, message] of own) errors[path] = message;
  const parsed = PredicateSchema.safeParse(value);
  if (parsed.success && own.length === 0) return parsed.data;
  if (!parsed.success) {
    for (const [path, message] of Object.entries(fieldErrorsFromIssues(parsed.error.issues, t))) {
      const at = path === '_' ? prefix : `${prefix}.${path}`;
      // The form's own problem at a place says more than the schema's about the text in it.
      if (!own.some(([mine]) => at === mine || at.startsWith(`${mine}.`))) errors[at] ??= message;
    }
  }
  return null;
}

/** A typed comparison value as sent; `undefined` while it is empty or does not parse (then
 *  `errors[at]` says why). */
function comparedValue(
  kind: PredicateValueKind,
  text: string,
  at: string,
  errors: Record<string, string>,
  t: Translate,
): unknown {
  if (
    (kind === 'string' && text === '') ||
    (kind !== 'string' && kind !== 'null' && kind !== 'boolean' && text.trim() === '')
  ) {
    return undefined;
  }
  const problem = predicateValueProblem(kind, text, t);
  if (problem !== null) {
    errors[at] = problem;
    return undefined;
  }
  return predicateValueOf(kind, text);
}

/** One comparison as the schema takes it; `null` (with `errors[at]`) when it refuses it. */
function leafOf(
  leaf: { readonly path: string; readonly op: PredicateOp; readonly value: unknown },
  at: string,
  errors: Record<string, string>,
): Predicate | null {
  const parsed = PredicateSchema.safeParse(leaf);
  if (parsed.success) return parsed.data;
  errors[at] = parsed.error.issues[0]?.message ?? '';
  return null;
}

function whenOf(
  rule: FixtureRuleDraft,
  errors: Record<string, string>,
  t: Translate,
): Predicate | null | undefined {
  switch (rule.whenMode) {
    case 'always':
      return undefined;
    case 'param': {
      if (rule.whenParam === '') return null;
      const path = paramPath(rule.whenParam);
      if (rule.whenOp === 'exists') return { path, op: 'exists' };
      const at = `${rule.uid}.whenValue`;
      const value = comparedValue(rule.whenValueKind, rule.whenValueText, at, errors, t);
      return value === undefined ? null : leafOf({ path, op: rule.whenOp, value }, at, errors);
    }
    case 'predicate':
      return predicateOf(rule.whenPredicate, `${rule.uid}.when`, errors, t) ?? null;
  }
}

function answerOf(
  rule: FixtureRuleDraft,
  gates: readonly EvalFixtureGateWire[],
  errors: Record<string, string>,
  t: Translate,
): EvalFixtureRule['answer'] | null {
  switch (rule.answer) {
    case 'absent': {
      const op = fixtureOperation(gates, rule.gatekeeperId, rule.operation);
      if (op !== undefined && !op.answersAbsent) {
        errors[`${rule.uid}.answer`] = t(
          '这个操作没有声明“不存在”的回答，改成返回数据或报错',
          'This operation declares no “not there” answer; answer with data or an error',
        );
        return null;
      }
      return { kind: 'absent' };
    }
    case 'error': {
      const message = rule.errorMessage.trim();
      return message === '' ? null : { kind: 'error', message };
    }
    case 'data': {
      if (rule.dataText.trim() === '') return null;
      const parsed = parseJson(rule.dataText);
      if (!parsed.ok) {
        errors[`${rule.uid}.data`] = t('不是合法的 JSON', 'Not valid JSON');
        return null;
      }
      if (jsonBytes(parsed.value) > EVAL_FIXTURE_DATA_MAX_BYTES) {
        errors[`${rule.uid}.data`] = t(
          `数据超过 ${EVAL_FIXTURE_DATA_MAX_BYTES} 字节`,
          `The data is larger than ${EVAL_FIXTURE_DATA_MAX_BYTES} bytes`,
        );
        return null;
      }
      return {
        kind: 'data',
        data: parsed.value as Extract<EvalFixtureRule['answer'], { kind: 'data' }>['data'],
      };
    }
  }
}

function expectOf(
  assertion: AssertionDraft,
  errors: Record<string, string>,
  t: Translate,
): Predicate | null {
  switch (assertion.template) {
    case 'summary_contains':
      return assertion.text.trim() === ''
        ? null
        : { path: EVAL_SUMMARY_PATH, op: 'contains', value: assertion.text };
    case 'output_equals': {
      const field = assertion.field.trim();
      const at = `${assertion.uid}.value`;
      const value = comparedValue(assertion.valueKind, assertion.valueText, at, errors, t);
      if (field === '' || value === undefined) return null;
      return leafOf({ path: evalOutputFieldPath(field), op: 'eq', value }, at, errors);
    }
    case 'called':
    case 'not_called':
    case 'at_most': {
      if (assertion.gatekeeperId === '' || assertion.operation === '') return null;
      const path = evalCallCountPath(assertion.gatekeeperId, assertion.operation);
      if (assertion.template === 'called') return { path, op: 'gte', value: 1 };
      if (assertion.template === 'not_called') return { path, op: 'eq', value: 0 };
      if (assertion.count.trim() === '') return null;
      const count = Number(assertion.count.trim());
      if (!Number.isInteger(count) || count < 1) {
        errors[`${assertion.uid}.count`] = t(
          '次数是不小于 1 的整数',
          'The count is a whole number of at least 1',
        );
        return null;
      }
      return { path, op: 'lte', value: count };
    }
    case 'predicate':
      return predicateOf(assertion.predicate, `${assertion.uid}.expect`, errors, t) ?? null;
  }
}

const errorUnder = (errors: Record<string, string>, uid: string): boolean =>
  Object.keys(errors).some((key) => key.startsWith(`${uid}.`));

/** What the draft still needs, what in it is wrong, and the content it stands for. `kindFixed`:
 *  an edit, which keeps the case's partition, split and mechanism. */
export function checkCaseDraft(
  draft: CaseDraft,
  gates: readonly EvalFixtureGateWire[],
  kindFixed: boolean,
  t: Translate,
): DraftCheck {
  const missing: string[] = [];
  const errors: Record<string, string> = {};
  const title = draft.title.trim();
  if (title === '') missing.push(t('填写标题', 'enter a title'));
  if (!kindFixed) {
    if (draft.partition === '') missing.push(t('选择分区', 'choose a partition'));
    if (draft.split === '') missing.push(t('选择 dev 或 holdout', 'choose dev or holdout'));
    if (draft.partition === 'mechanism' && draft.mechanism.trim() === '') {
      missing.push(t('填写机制', 'name the mechanism'));
    }
  }

  let input: unknown;
  if (draft.inputText.trim() === '') {
    missing.push(t('填写输入', 'enter the input'));
  } else if (draft.inputMode === 'text') {
    input = draft.inputText;
  } else {
    const parsed = parseJson(draft.inputText);
    if (!parsed.ok) errors.input = t('不是合法的 JSON', 'Not valid JSON');
    else if (parsed.value === null) errors.input = t('输入不能是 null', 'The input cannot be null');
    else input = parsed.value;
  }
  if (input !== undefined && jsonBytes(input) > EVAL_CASE_INPUT_MAX_BYTES) {
    errors.input = t(
      `输入超过 ${EVAL_CASE_INPUT_MAX_BYTES} 字节`,
      `The input is larger than ${EVAL_CASE_INPUT_MAX_BYTES} bytes`,
    );
    input = undefined;
  }

  const fixtures: EvalFixtureRule[] = [];
  let ruleIncomplete = false;
  for (const rule of draft.fixtures) {
    if (rule.gatekeeperId === '' || rule.operation === '') {
      ruleIncomplete = true;
      continue;
    }
    const when = whenOf(rule, errors, t);
    const answer = answerOf(rule, gates, errors, t);
    if (when === null || answer === null) {
      if (!errorUnder(errors, rule.uid)) ruleIncomplete = true;
      continue;
    }
    fixtures.push({
      gatekeeperId: rule.gatekeeperId,
      operation: rule.operation,
      ...(when !== undefined ? { when } : {}),
      answer,
    });
  }
  if (ruleIncomplete) missing.push(t('补全夹具规则', 'complete the fixture rules'));
  if (draft.fixtures.length > EVAL_CASE_MAX_FIXTURE_RULES) {
    missing.push(
      t(
        `夹具规则最多 ${EVAL_CASE_MAX_FIXTURE_RULES} 条`,
        `at most ${EVAL_CASE_MAX_FIXTURE_RULES} fixture rules`,
      ),
    );
  }

  const assertions: EvalAssertion[] = [];
  let assertionIncomplete = false;
  for (const assertion of draft.assertions) {
    const expect = expectOf(assertion, errors, t);
    if (expect === null) {
      if (!errorUnder(errors, assertion.uid)) assertionIncomplete = true;
      continue;
    }
    const note = assertion.note.trim();
    assertions.push({ expect, ...(note !== '' ? { note } : {}) });
  }
  if (draft.assertions.length === 0) missing.push(t('至少一条断言', 'at least one assertion'));
  else if (assertionIncomplete) missing.push(t('补全断言', 'complete the assertions'));
  if (draft.assertions.length > EVAL_CASE_MAX_ASSERTIONS) {
    missing.push(
      t(
        `断言最多 ${EVAL_CASE_MAX_ASSERTIONS} 条`,
        `at most ${EVAL_CASE_MAX_ASSERTIONS} assertions`,
      ),
    );
  }

  const content =
    missing.length === 0 && Object.keys(errors).length === 0 && input !== undefined
      ? { title, input: input as EvalCaseContent['input'], fixtures, assertions }
      : null;
  return { missing, errors, content };
}

/** A JSON value with its object keys in order, for telling two contents apart. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
}

/** Whether `content` says what the case already says (an edit that changes nothing is refused). */
export function sameContent(
  content: EvalCaseContent,
  evalCase: Pick<EvalCaseWire, 'title' | 'input' | 'fixtures' | 'assertions'>,
): boolean {
  const of = (c: Pick<EvalCaseWire, 'title' | 'input' | 'fixtures' | 'assertions'>) => ({
    title: c.title,
    input: c.input,
    fixtures: c.fixtures,
    assertions: c.assertions,
  });
  return canonical(of(content)) === canonical(of(evalCase));
}

// ----- sentences ------------------------------------------------------------------------------

/** An assertion as one sentence, by the template that writes it when one does. */
export function assertionSentence(
  assertion: EvalAssertion,
  gates: readonly EvalFixtureGateWire[],
  t: Translate,
): string {
  const draft = assertionDraftOf(assertion);
  const call = () => gateOperationText(gates, draft.gatekeeperId, draft.operation, t);
  switch (draft.template) {
    case 'summary_contains':
      return t(
        `结果摘要包含 ${JSON.stringify(draft.text)}`,
        `The result summary contains ${JSON.stringify(draft.text)}`,
      );
    case 'output_equals': {
      const value = 'value' in assertion.expect ? JSON.stringify(assertion.expect.value) : '';
      return t(
        `输出字段 ${draft.field} 等于 ${value}`,
        `Output field ${draft.field} equals ${value}`,
      );
    }
    case 'called':
      return t(`调用过 ${call()}`, `Called ${call()}`);
    case 'not_called':
      return t(`没有调用 ${call()}`, `Never called ${call()}`);
    case 'at_most':
      return t(
        `调用 ${call()} 至多 ${draft.count} 次`,
        `Called ${call()} at most ${draft.count} time(s)`,
      );
    case 'predicate':
      return predicateSentence(assertion.expect, t);
  }
}

/** When a rule answers: 「任何参数」 or its condition as a sentence on the call's params. */
export function ruleWhenText(rule: EvalFixtureRule, t: Translate): string {
  if (rule.when === undefined) return t('任何参数', 'any parameters');
  const sentence = predicateSentence(rule.when, t);
  return t(`参数满足：${sentence}`, `params match: ${sentence}`);
}

/** How a rule answers, in a few words (the data itself is shown under it). */
export function ruleAnswerText(rule: EvalFixtureRule, t: Translate): string {
  switch (rule.answer.kind) {
    case 'data':
      return t('返回数据', 'returns data');
    case 'absent':
      return t('回答“要查的东西不存在”', 'answers “what was looked up is not there”');
    case 'error':
      return t(`报错：${rule.answer.message}`, `fails: ${rule.answer.message}`);
  }
}

/**
 * Where a credential or masked-text refusal found something, in the editor's words (「规则 2」 and
 * 「断言 1」 are the editor's own legends): the kernel spells each place from the case's fields —
 * `title`, `mechanism`, `reason`, `input…`, `fixtures[i]…`, `assertions[i]…`
 * (`details.field`, and every place in `details.suspectedSecretPaths` / `details.paths`). Field
 * names only, never a value. Anything else is shown as the path.
 */
export function refusalPlace(path: string, t: Translate): string {
  if (path === 'title') return t('标题', 'the title');
  if (path === 'mechanism') return t('机制', 'the mechanism');
  if (path === 'reason') return t('修改原因', 'the reason');
  if (/^input(?:$|[.[])/.test(path)) return t('输入', 'the input');
  const rule = /^fixtures\[(\d+)\](?:\.(.*))?$/.exec(path);
  if (rule) {
    const n = Number(rule[1]) + 1;
    const rest = rule[2] ?? '';
    if (rest.startsWith('when')) return t(`规则 ${n} 的条件`, `the condition of rule ${n}`);
    if (rest.startsWith('answer')) return t(`规则 ${n} 的应答`, `the answer of rule ${n}`);
    return t(`规则 ${n}`, `rule ${n}`);
  }
  const assertion = /^assertions\[(\d+)\](?:\.(.*))?$/.exec(path);
  if (assertion) {
    const n = Number(assertion[1]) + 1;
    return assertion[2]?.startsWith('note')
      ? t(`断言 ${n} 的说明`, `the note of assertion ${n}`)
      : t(`断言 ${n}`, `assertion ${n}`);
  }
  return path;
}

/** What a case write's error says beside 保存 / 添加: {@link writeErrors}, and for a credential or
 *  masked-text refusal, every place it names and what to do there. */
export function caseWriteErrors(error: unknown, t: Translate): ErrorOverrides {
  const base = writeErrors(t);
  if (!(error instanceof HttpError)) return base;
  const credential = error.code === 'credentials_in_text';
  if (!credential && error.code !== 'redacted_text_submitted') return base;
  const listed = error.details?.[credential ? 'suspectedSecretPaths' : 'paths'];
  const places = [
    ...new Set(
      [error.details?.field, ...(Array.isArray(listed) ? listed : [])]
        .filter((path): path is string => typeof path === 'string')
        .map((path) => refusalPlace(path, t)),
    ),
  ];
  const where = places.length > 0 ? places.join(t('、', ', ')) : null;
  return {
    ...base,
    [error.code]: credential
      ? t(
          `${where === null ? '' : `${where}里`}有像凭据的写法（token、key、密码的值，或 Bearer、Authorization、名称=值 这样的写法），已拒绝，什么也没保存。用例只模拟门的应答，换成不像凭据的占位值，或者写成描述，不要写值本身。`,
          `${where === null ? 'The case' : `${where.charAt(0).toUpperCase()}${where.slice(1)}`} looks like it carries a credential (a token, key or password value, or a Bearer, Authorization or name=value form), so nothing was saved. A case only simulates the gate's answers: use a placeholder that does not look like a credential, or describe it, never the value itself.`,
        )
      : t(
          `${where === null ? '' : `${where}里`}还留着 [redacted]：那里的原文读出时已经遮住，不会填回来，什么也没保存。把这一段重新填写。`,
          `${where === null ? 'The case' : `${where.charAt(0).toUpperCase()}${where.slice(1)}`} still holds [redacted]: the original there was masked when read and is never filled back in, so nothing was saved. Write that part again.`,
        ),
  };
}
