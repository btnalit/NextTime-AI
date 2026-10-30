import {
  EVAL_ASSERTION_NOTE_MAX,
  EVAL_CASE_MAX_ASSERTIONS,
  EVAL_CASE_MAX_FIXTURE_RULES,
  EVAL_CASE_MECHANISM_MAX,
  EVAL_CASE_PARTITION_VALUES,
  EVAL_CASE_SPLIT_VALUES,
  EVAL_CASE_TITLE_MAX,
  EVAL_FIXTURE_ERROR_MAX,
  type EvalCaseContent,
  type EvalCaseKind,
  type EvalCaseWire,
  type EvalFixtureGateWire,
  visibleText,
} from '@nexttime/shared';
import { useMemo, useRef, useState } from 'react';
import { byData, useFocusAfterRender } from '../../hooks/useFocusAfterRender.js';
import { errorsUnder } from '../../lib/catalog.js';
import {
  ASSERTION_TEMPLATES,
  type AssertionDraft,
  type CaseDraft,
  type FixtureRuleDraft,
  type WhenMode,
  assertionTemplateLabel,
  caseDraftOf,
  caseWriteErrors,
  checkCaseDraft,
  countsCalls,
  emptyAssertion,
  emptyCaseDraft,
  emptyRule,
  fixtureOperation,
  fixtureProblemText,
  operationParams,
  partitionHint,
  sameContent,
  splitHint,
  valueKindFor,
} from '../../lib/eval-cases.js';
import { partitionLabel, shownName } from '../../lib/evaluation.js';
import { actionKindTagText } from '../../lib/format.js';
import { predicateOpLabel } from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import {
  PREDICATE_OPS,
  type PredicateOp,
  type PredicateValueKind,
  predicateValueKindLabel,
  predicateValueKinds,
} from '../../lib/predicate-draft.js';
import { PredicateEditor } from '../catalog/PredicateEditor.js';
import { Button } from '../kit/button.js';
import { GuardedCancelButton } from '../kit/discard-guard.js';
import { Field, describedBy } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { KeyValue } from '../kit/key-value.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { SheetFooter } from '../kit/sheet.js';
import { StillNeeded } from '../kit/still-needed.js';
import { Textarea } from '../kit/textarea.js';

export interface CaseSave {
  /** A new case's fixed fields; an edit keeps the case's own. */
  readonly kind?: EvalCaseKind;
  readonly content: EvalCaseContent;
  /** An edit's reason. */
  readonly reason?: string;
}

export interface CaseEditorProps {
  /** The suite's fixture gates, as frozen — what a rule and a call assertion pick from. */
  readonly gates: readonly EvalFixtureGateWire[];
  /** The case an edit starts from; `undefined` writes a new one. */
  readonly editing?: EvalCaseWire;
  /** Saves; a thrown error is shown in the form, which stays open. */
  readonly onSave: (save: CaseSave) => Promise<void>;
  readonly onCancel: () => void;
}

const REASON_MAX = 500;

/**
 * components/evaluation/CaseEditor (S10 E3-1b): a case of a suite, written or edited in the case
 * sheet (`SuiteCases`) — its title; its partition, dev / holdout split and mechanism (picked when
 * it is added, fixed after: an edit shows them and keeps them); what the Worker is given; the
 * fixture rules answering its calls, in order, each for one Operation of one of the suite's
 * fixture gates, with an optional condition on the call's params and an answer (data, "not there"
 * only where the Operation declares one, or an error); and the assertions that make it pass,
 * from templates or as a custom condition (`lib/eval-cases`). An edit needs a reason and a
 * change: one that leaves the case as it reads is not offered.
 */
export function CaseEditor({ gates, editing, onSave, onCancel }: CaseEditorProps) {
  const t = useT();
  const [draft, setDraft] = useState<CaseDraft>(() =>
    editing === undefined ? emptyCaseDraft() : caseDraftOf(editing, gates),
  );
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errorAnchor = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLFormElement>(null);
  const focusAfterRender = useFocusAfterRender();

  const kindFixed = editing !== undefined;
  const check = useMemo(
    () => checkCaseDraft(draft, gates, kindFixed, t),
    [draft, gates, kindFixed, t],
  );
  const unchanged =
    editing !== undefined && check.content !== null && sameContent(check.content, editing);
  const missing = [
    ...check.missing,
    ...(kindFixed && reason.trim() === '' ? [t('填写修改原因', 'give the reason')] : []),
  ];
  const ready = check.content !== null && missing.length === 0 && !unchanged;

  const edit = (patch: Partial<CaseDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const editRule = (uid: string, patch: Partial<FixtureRuleDraft>) =>
    edit({
      fixtures: draft.fixtures.map((rule) => (rule.uid === uid ? { ...rule, ...patch } : rule)),
    });
  const editAssertion = (uid: string, patch: Partial<AssertionDraft>) =>
    edit({
      assertions: draft.assertions.map((item) => (item.uid === uid ? { ...item, ...patch } : item)),
    });

  /** Moves or removes one item of a list, focus following it (or what took its place). */
  function reorder<T extends { readonly uid: string }>(
    list: readonly T[],
    uid: string,
    move: -1 | 1 | 'remove',
    key: 'fixtures' | 'assertions',
    selector: string,
  ): void {
    const index = list.findIndex((item) => item.uid === uid);
    if (index < 0) return;
    const next = [...list];
    if (move === 'remove') {
      next.splice(index, 1);
      const neighbour = next[Math.min(index, next.length - 1)];
      focusAfterRender(() =>
        neighbour === undefined
          ? byData(root.current, '[data-add]', 'add', key)
          : byData(root.current, selector, 'uid', neighbour.uid),
      );
    } else {
      const target = index + move;
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target] as T, next[index] as T];
      // The button pressed, unless the move took the item to the end it points at.
      const atEnd = move === -1 ? target === 0 : target === next.length - 1;
      const direction = (move === -1) !== atEnd ? 'up' : 'down';
      focusAfterRender(
        () =>
          byData(root.current, `[data-move="${direction}"]`, 'uid', uid) ??
          byData(root.current, selector, 'uid', uid),
      );
    }
    edit({ [key]: next } as Partial<CaseDraft>);
  }

  async function submit(): Promise<void> {
    if (!ready || check.content === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const kind: EvalCaseKind | undefined = kindFixed
        ? undefined
        : {
            partition: draft.partition as EvalCaseKind['partition'],
            split: draft.split as EvalCaseKind['split'],
            ...(draft.partition === 'mechanism' ? { mechanism: draft.mechanism.trim() } : {}),
          };
      await onSave({
        content: check.content,
        ...(kind !== undefined ? { kind } : {}),
        ...(kindFixed ? { reason: reason.trim() } : {}),
      });
    } catch (err) {
      setError(err);
      // The 保存 that had focus is disabled while it saves; the refusal takes focus instead
      // (#810 UX P3-2), so it is read out and scrolled into view, inside the sheet.
      focusAfterRender(() => errorAnchor.current);
    } finally {
      setSubmitting(false);
    }
  }

  const problems = new Map(
    (editing?.fixtureProblems ?? []).map((problem) => [problem.index, problem.problem]),
  );
  const inputId = 'eval-case-input';

  return (
    <>
      <form
        ref={root}
        className="stack"
        data-testid="eval-case-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field id="eval-case-title" label={t('标题', 'Title')} required>
          <input
            id="eval-case-title"
            className="input"
            value={draft.title}
            maxLength={EVAL_CASE_TITLE_MAX}
            onChange={(event) => edit({ title: event.target.value })}
            disabled={submitting}
            data-testid="eval-case-title"
          />
        </Field>

        {editing !== undefined ? (
          <div className="stack-s" data-testid="eval-case-kind-fixed">
            <KeyValue
              items={[
                {
                  key: 'partition',
                  label: t('分区', 'Partition'),
                  value: partitionLabel(editing.partition, t),
                },
                { key: 'split', label: 'dev / holdout', value: editing.split },
                ...(editing.mechanism !== null
                  ? [{ key: 'mechanism', label: t('机制', 'Mechanism'), value: editing.mechanism }]
                  : []),
              ]}
            />
            <p className="text-3 text-small">
              {t(
                '分区、dev / holdout 和机制在添加时定下，编辑不改它们；要换，退役这条再添加一条。',
                'The partition, dev / holdout split and mechanism are fixed when a case is added and kept by an edit; to change them, retire this case and add another.',
              )}
            </p>
          </div>
        ) : (
          <div className="stack-s">
            <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
              <Field
                id="eval-case-partition"
                label={t('分区', 'Partition')}
                required
                hint={draft.partition !== '' ? partitionHint(draft.partition, t) : undefined}
              >
                <Select
                  id="eval-case-partition"
                  aria-label={t('分区', 'Partition')}
                  value={draft.partition}
                  onChange={(event) =>
                    edit({ partition: event.target.value as CaseDraft['partition'] })
                  }
                  disabled={submitting}
                  data-testid="eval-case-partition"
                >
                  <option value="">{t('选择分区', 'Choose a partition')}</option>
                  {EVAL_CASE_PARTITION_VALUES.map((partition) => (
                    <option key={partition} value={partition}>
                      {partitionLabel(partition, t)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                id="eval-case-split"
                label="dev / holdout"
                required
                hint={draft.split !== '' ? splitHint(draft.split, t) : undefined}
              >
                <Select
                  id="eval-case-split"
                  aria-label="dev / holdout"
                  value={draft.split}
                  onChange={(event) => edit({ split: event.target.value as CaseDraft['split'] })}
                  disabled={submitting}
                  data-testid="eval-case-split"
                >
                  <option value="">{t('选择', 'Choose')}</option>
                  {EVAL_CASE_SPLIT_VALUES.map((split) => (
                    <option key={split} value={split}>
                      {split}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {draft.partition === 'mechanism' ? (
              <Field
                id="eval-case-mechanism"
                label={t('机制', 'Mechanism')}
                required
                hint={t(
                  '这条用例针对的失败机制，比如「重启前不检查依赖」。',
                  'The failure mechanism this case aims at, e.g. “restarts without checking dependants”.',
                )}
              >
                <input
                  id="eval-case-mechanism"
                  className="input"
                  value={draft.mechanism}
                  maxLength={EVAL_CASE_MECHANISM_MAX}
                  onChange={(event) => edit({ mechanism: event.target.value })}
                  disabled={submitting}
                  aria-describedby={describedBy('eval-case-mechanism', true, false)}
                  data-testid="eval-case-mechanism"
                />
              </Field>
            ) : null}
            <p className="text-3 text-small">
              {t(
                '分区、dev / holdout 和机制添加后不能改。',
                'The partition, dev / holdout split and mechanism cannot change once the case is added.',
              )}
            </p>
          </div>
        )}

        <fieldset className="stack-s" data-testid="eval-case-input-section">
          <legend className="section-title">{t('输入', 'Input')}</legend>
          <div className="row-wrap">
            {(['text', 'json'] as const).map((mode) => (
              <label key={mode} className="choice-line text-small">
                <input
                  type="radio"
                  name="eval-case-input-mode"
                  checked={draft.inputMode === mode}
                  onChange={() => edit({ inputMode: mode })}
                  disabled={submitting}
                  data-testid={`eval-case-input-mode-${mode}`}
                />
                <span>{mode === 'text' ? t('一段文字', 'Text') : 'JSON'}</span>
              </label>
            ))}
          </div>
          <Field
            id={inputId}
            label={t('交给 Worker 的输入', 'What the Worker is given')}
            required
            hint={
              check.errors.input !== undefined
                ? undefined
                : draft.inputMode === 'text'
                  ? t(
                      '和派活时给 Worker 的输入一样：要它做的事。',
                      'As a Task’s input when work is delegated: what it is asked to do.',
                    )
                  : t('任意 JSON 值（不能是 null）。', 'Any JSON value (not null).')
            }
            error={check.errors.input ?? null}
          >
            <Textarea
              id={inputId}
              aria-label={t('交给 Worker 的输入', 'What the Worker is given')}
              className={draft.inputMode === 'json' ? 'mono' : undefined}
              value={draft.inputText}
              minRows={3}
              maxRows={14}
              onChange={(event) => edit({ inputText: event.target.value })}
              disabled={submitting}
              invalid={check.errors.input !== undefined}
              data-testid="eval-case-input"
            />
          </Field>
        </fieldset>

        <section className="stack-s" data-testid="eval-case-rules">
          <span className="section-title">{t('夹具规则', 'Fixture rules')}</span>
          <p className="text-3 text-small">
            {t(
              '按顺序匹配：第一条匹配的规则回答这次调用；没有规则匹配的调用得到固定的“夹具没有答案”错误。执行类操作只模拟结果，不会真的执行。',
              'Matched in order: the first rule that matches answers the call; a call no rule matches gets a fixed “the fixture has no answer” error. An execute operation’s outcome is only simulated, never carried out.',
            )}
          </p>
          {gates.length === 0 ? (
            <Notice tone="info" testId="eval-case-rules-no-gates">
              {t(
                '用例集还没有夹具门，Worker 的调用都会得到“夹具没有答案”。要回答调用，先给用例集添加夹具门。',
                'The suite has no fixture gate yet, so every call the Worker makes gets “the fixture has no answer”. To answer calls, add a fixture gate to the suite first.',
              )}
            </Notice>
          ) : null}
          {draft.fixtures.map((rule, index) => (
            <RuleEditor
              key={rule.uid}
              rule={rule}
              index={index}
              count={draft.fixtures.length}
              gates={gates}
              problem={problems.get(index)}
              errors={check.errors}
              busy={submitting}
              onChange={(patch) => editRule(rule.uid, patch)}
              onMove={(move) =>
                reorder(
                  draft.fixtures,
                  rule.uid,
                  move,
                  'fixtures',
                  '[data-testid="eval-case-rule"]',
                )
              }
            />
          ))}
          <span className="row-wrap">
            <Button
              variant="secondary"
              size="s"
              data-add="fixtures"
              onClick={() => {
                const rule = emptyRule();
                edit({ fixtures: [...draft.fixtures, rule] });
                focusAfterRender(() =>
                  root.current?.querySelector<HTMLElement>(`#eval-case-${rule.uid}-gate`),
                );
              }}
              disabled={
                submitting ||
                gates.length === 0 ||
                draft.fixtures.length >= EVAL_CASE_MAX_FIXTURE_RULES
              }
              data-testid="eval-case-rule-add"
            >
              {t('添加规则', 'Add rule')}
            </Button>
            <StillNeeded
              reason={
                gates.length === 0
                  ? t('用例集还没有夹具门', 'the suite has no fixture gate yet')
                  : draft.fixtures.length >= EVAL_CASE_MAX_FIXTURE_RULES
                    ? t(
                        `一条用例最多 ${EVAL_CASE_MAX_FIXTURE_RULES} 条规则`,
                        `a case holds at most ${EVAL_CASE_MAX_FIXTURE_RULES} rules`,
                      )
                    : null
              }
              hidden={submitting}
            />
          </span>
        </section>

        <section className="stack-s" data-testid="eval-case-assertions">
          <span className="section-title">{t('断言', 'Assertions')}</span>
          <p className="text-3 text-small">
            {t('每条断言都成立，用例才算通过。', 'The case passes when every assertion holds.')}
          </p>
          {draft.assertions.map((assertion, index) => (
            <AssertionEditor
              key={assertion.uid}
              assertion={assertion}
              index={index}
              gates={gates}
              errors={check.errors}
              busy={submitting}
              onChange={(patch) => editAssertion(assertion.uid, patch)}
              onRemove={() =>
                reorder(
                  draft.assertions,
                  assertion.uid,
                  'remove',
                  'assertions',
                  '[data-testid="eval-case-assertion"]',
                )
              }
            />
          ))}
          <span className="row-wrap">
            <Button
              variant="secondary"
              size="s"
              data-add="assertions"
              onClick={() => {
                const assertion = emptyAssertion();
                edit({ assertions: [...draft.assertions, assertion] });
                focusAfterRender(() =>
                  root.current?.querySelector<HTMLElement>(`#eval-case-${assertion.uid}-template`),
                );
              }}
              disabled={submitting || draft.assertions.length >= EVAL_CASE_MAX_ASSERTIONS}
              data-testid="eval-case-assertion-add"
            >
              {t('添加断言', 'Add assertion')}
            </Button>
            <StillNeeded
              reason={
                draft.assertions.length >= EVAL_CASE_MAX_ASSERTIONS
                  ? t(
                      `一条用例最多 ${EVAL_CASE_MAX_ASSERTIONS} 条断言`,
                      `a case holds at most ${EVAL_CASE_MAX_ASSERTIONS} assertions`,
                    )
                  : null
              }
              hidden={submitting}
            />
          </span>
        </section>

        {kindFixed ? (
          <Field
            id="eval-case-reason"
            label={t('修改原因', 'Reason')}
            required
            hint={t(
              '必填，记入变更记录。旧的一条退役，新的一条接替它。',
              'Required; kept in the history. The old case is retired and the new one replaces it.',
            )}
          >
            <Textarea
              id="eval-case-reason"
              aria-label={t('修改原因', 'Reason')}
              aria-required
              value={reason}
              maxLength={REASON_MAX}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
              disabled={submitting}
              aria-describedby={describedBy('eval-case-reason', true, false)}
              data-testid="eval-case-reason"
            />
          </Field>
        ) : null}

        {error !== null ? (
          <div ref={errorAnchor} tabIndex={-1} data-testid="eval-case-save-error-anchor">
            <InlineError
              error={error}
              overrides={caseWriteErrors(error, t)}
              testId="eval-case-save-error"
            />
          </div>
        ) : null}
      </form>

      <SheetFooter>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!ready || submitting}
          aria-busy={submitting || undefined}
          data-testid="eval-case-save"
        >
          {kindFixed ? t('保存', 'Save') : t('添加', 'Add')}
        </Button>
        <GuardedCancelButton variant="ghost" onCancel={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </GuardedCancelButton>
        <StillNeeded
          items={missing}
          reason={
            unchanged
              ? t('内容和现在一样，没有可保存的改动', 'the case already reads this way')
              : Object.keys(check.errors).length > 0
                ? t('先改正标出的问题', 'fix the marked problems first')
                : null
          }
          hidden={submitting}
          testId="eval-case-missing"
        />
      </SheetFooter>
    </>
  );
}

/** The gate and Operation selects a rule and a call assertion share. A value the suite no longer
 *  has stays selectable as itself, marked, so a case a sync left behind still reads as written. */
function GateOperationPicker({
  id,
  gates,
  gatekeeperId,
  operation,
  busy,
  onChange,
  testId,
}: {
  readonly id: string;
  readonly gates: readonly EvalFixtureGateWire[];
  readonly gatekeeperId: string;
  readonly operation: string;
  readonly busy: boolean;
  readonly onChange: (pick: { gatekeeperId: string; operation: string }) => void;
  readonly testId: string;
}) {
  const t = useT();
  const gate = gates.find((candidate) => candidate.gatekeeperId === gatekeeperId);
  const operations = gate?.operations ?? [];
  const opGone = operation !== '' && !operations.some((op) => op.name === operation);
  return (
    <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
      <Field id={`${id}-gate`} label={t('夹具门', 'Fixture gate')} required>
        <Select
          id={`${id}-gate`}
          aria-label={t('夹具门', 'Fixture gate')}
          value={gatekeeperId}
          onChange={(event) => {
            const next = gates.find((candidate) => candidate.gatekeeperId === event.target.value);
            // A gate with one Operation has nothing else to pick.
            const only = next?.operations.length === 1 ? (next.operations[0]?.name ?? '') : '';
            onChange({ gatekeeperId: event.target.value, operation: only });
          }}
          disabled={busy}
          data-testid={`${testId}-gate`}
        >
          <option value="">{t('选择夹具门', 'Choose a fixture gate')}</option>
          {gates.map((candidate) => (
            <option key={candidate.gatekeeperId} value={candidate.gatekeeperId}>
              {shownName(candidate.gateName)}
            </option>
          ))}
          {gatekeeperId !== '' && gate === undefined ? (
            <option value={gatekeeperId}>
              {t('（已不在用例集里的门）', '(a gate no longer in the suite)')}
            </option>
          ) : null}
        </Select>
      </Field>
      <Field id={`${id}-op`} label={t('操作', 'Operation')} required>
        <Select
          id={`${id}-op`}
          aria-label={t('操作', 'Operation')}
          value={operation}
          onChange={(event) => onChange({ gatekeeperId, operation: event.target.value })}
          disabled={busy || gatekeeperId === ''}
          data-testid={`${testId}-op`}
        >
          <option value="">{t('选择操作', 'Choose an operation')}</option>
          {operations.map((op) => {
            // The kernel refuses a case holding a character a reader cannot see (#810 UX P3-1):
            // such an Operation is listed, never offered.
            const unseen = visibleText(op.name) !== op.name;
            return (
              <option key={op.name} value={op.name} disabled={unseen && op.name !== operation}>
                {unseen
                  ? t(
                      `${actionKindTagText(op.name)}（名字里有看不见的字符，不能用在用例里）`,
                      `${actionKindTagText(op.name)} (its name holds characters a reader cannot see; not usable in a case)`,
                    )
                  : `${actionKindTagText(op.name)}（${op.mode === 'execute' ? t('执行', 'execute') : t('观察', 'observe')}）`}
              </option>
            );
          })}
          {opGone ? (
            <option value={operation}>
              {t(
                `${actionKindTagText(operation)}（门上已没有）`,
                `${actionKindTagText(operation)} (no longer on the gate)`,
              )}
            </option>
          ) : null}
        </Select>
      </Field>
    </div>
  );
}

/** A comparison's value: its kind (the ones the comparison takes) and the value itself. */
function ValueInput({
  id,
  label,
  op,
  kind,
  text,
  error,
  busy,
  onChange,
  testId,
}: {
  readonly id: string;
  readonly label: string;
  readonly op: PredicateOp;
  readonly kind: PredicateValueKind;
  readonly text: string;
  readonly error: string | undefined;
  readonly busy: boolean;
  readonly onChange: (patch: { kind?: PredicateValueKind; text?: string }) => void;
  readonly testId: string;
}) {
  const t = useT();
  const kinds = predicateValueKinds(op);
  if (kinds.length === 0) return null;
  return (
    <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
      <Field id={`${id}-kind`} label={t('值的类型', 'Value kind')}>
        <Select
          id={`${id}-kind`}
          aria-label={t('值的类型', 'Value kind')}
          value={kind}
          onChange={(event) => onChange({ kind: event.target.value as PredicateValueKind })}
          disabled={busy}
          data-testid={`${testId}-kind`}
        >
          {kinds.map((candidate) => (
            <option key={candidate} value={candidate}>
              {predicateValueKindLabel(candidate, t)}
            </option>
          ))}
        </Select>
      </Field>
      {kind === 'null' ? null : kind === 'boolean' ? (
        <Field id={id} label={label} required>
          <Select
            id={id}
            aria-label={label}
            value={text === 'true' ? 'true' : 'false'}
            onChange={(event) => onChange({ text: event.target.value })}
            disabled={busy}
            data-testid={testId}
          >
            <option value="true">{t('是（true）', 'Yes (true)')}</option>
            <option value="false">{t('否（false）', 'No (false)')}</option>
          </Select>
        </Field>
      ) : (
        <Field id={id} label={label} required error={error ?? null}>
          {kind === 'json' ? (
            <Textarea
              id={id}
              aria-label={label}
              className="mono"
              value={text}
              onChange={(event) => onChange({ text: event.target.value })}
              disabled={busy}
              invalid={error !== undefined}
              data-testid={testId}
            />
          ) : (
            <input
              id={id}
              className="input"
              value={text}
              inputMode={kind === 'number' ? 'decimal' : undefined}
              onChange={(event) => onChange({ text: event.target.value })}
              disabled={busy}
              aria-invalid={error !== undefined || undefined}
              aria-describedby={describedBy(id, false, error !== undefined)}
              data-testid={testId}
            />
          )}
        </Field>
      )}
    </div>
  );
}

function whenModeLabel(mode: WhenMode, t: Translate): string {
  switch (mode) {
    case 'always':
      return t('任何参数', 'Any parameters');
    case 'param':
      return t('按一个参数', 'By one parameter');
    case 'predicate':
      return t('自定义条件', 'Custom condition');
  }
}

function RuleEditor({
  rule,
  index,
  count,
  gates,
  problem,
  errors,
  busy,
  onChange,
  onMove,
}: {
  readonly rule: FixtureRuleDraft;
  readonly index: number;
  readonly count: number;
  readonly gates: readonly EvalFixtureGateWire[];
  readonly problem: Parameters<typeof fixtureProblemText>[0] | undefined;
  readonly errors: Readonly<Record<string, string>>;
  readonly busy: boolean;
  readonly onChange: (patch: Partial<FixtureRuleDraft>) => void;
  readonly onMove: (move: -1 | 1 | 'remove') => void;
}) {
  const t = useT();
  const id = `eval-case-${rule.uid}`;
  const op = fixtureOperation(gates, rule.gatekeeperId, rule.operation);
  const params = operationParams(op);
  const number = index + 1;
  // A rule a sync left without its Operation keeps its answer as written.
  const absentOffered = op?.answersAbsent === true || rule.answer === 'absent';
  return (
    <fieldset
      className="stack-s rounded-m border border-border p-3"
      data-testid="eval-case-rule"
      data-uid={rule.uid}
      tabIndex={-1}
    >
      <legend className="text-small">{t(`规则 ${number}`, `Rule ${number}`)}</legend>
      {problem !== undefined ? (
        <Notice tone="warn" testId="eval-case-rule-problem">
          {fixtureProblemText(problem, t)}
        </Notice>
      ) : null}
      <GateOperationPicker
        id={id}
        gates={gates}
        gatekeeperId={rule.gatekeeperId}
        operation={rule.operation}
        busy={busy}
        onChange={(pick) =>
          onChange({
            ...pick,
            // Another Operation has other parameters (and maybe no "not there" answer).
            ...(pick.operation !== rule.operation
              ? { whenParam: '', ...(rule.whenMode === 'param' ? { whenMode: 'always' } : {}) }
              : {}),
          })
        }
        testId="eval-case-rule"
      />
      {op?.mode === 'execute' ? (
        <p className="text-3 text-small" data-testid="eval-case-rule-simulated">
          {t(
            '执行类操作：评测时按这条规则模拟结果，不会真的执行。',
            'An execute operation: under evaluation this rule simulates its outcome; nothing is carried out.',
          )}
        </p>
      ) : null}
      <Field id={`${id}-when`} label={t('什么时候回答', 'When it answers')}>
        <Select
          id={`${id}-when`}
          aria-label={t('什么时候回答', 'When it answers')}
          value={rule.whenMode}
          onChange={(event) => onChange({ whenMode: event.target.value as WhenMode })}
          disabled={busy || rule.operation === ''}
          data-testid="eval-case-rule-when"
        >
          {(['always', 'param', 'predicate'] as const).map((mode) => (
            <option
              key={mode}
              value={mode}
              disabled={mode === 'param' && params.length === 0 && rule.whenMode !== 'param'}
            >
              {whenModeLabel(mode, t)}
            </option>
          ))}
        </Select>
      </Field>
      {rule.whenMode === 'param' ? (
        <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
          <Field id={`${id}-param`} label={t('参数', 'Parameter')} required>
            <Select
              id={`${id}-param`}
              aria-label={t('参数', 'Parameter')}
              value={rule.whenParam}
              onChange={(event) => onChange({ whenParam: event.target.value })}
              disabled={busy}
              data-testid="eval-case-rule-param"
            >
              <option value="">{t('选择参数', 'Choose a parameter')}</option>
              {params.map((param) => (
                <option key={param} value={param}>
                  {param}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${id}-cmp`} label={t('比较', 'Comparison')}>
            <Select
              id={`${id}-cmp`}
              aria-label={t('比较', 'Comparison')}
              value={rule.whenOp}
              onChange={(event) => {
                const whenOp = event.target.value as PredicateOp;
                onChange({ whenOp, whenValueKind: valueKindFor(whenOp, rule.whenValueKind) });
              }}
              disabled={busy}
              data-testid="eval-case-rule-cmp"
            >
              {PREDICATE_OPS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {predicateOpLabel(candidate, t)}
                </option>
              ))}
            </Select>
          </Field>
          <ValueInput
            id={`${id}-value`}
            label={t('值', 'Value')}
            op={rule.whenOp}
            kind={rule.whenValueKind}
            text={rule.whenValueText}
            error={errors[`${rule.uid}.whenValue`]}
            busy={busy}
            onChange={(patch) =>
              onChange({
                ...(patch.kind !== undefined ? { whenValueKind: patch.kind } : {}),
                ...(patch.text !== undefined ? { whenValueText: patch.text } : {}),
              })
            }
            testId="eval-case-rule-value"
          />
        </div>
      ) : null}
      {rule.whenMode === 'predicate' ? (
        <div className="stack-s">
          <PredicateEditor
            id={`${id}-predicate`}
            legend={t('调用参数要满足', 'The call’s params must satisfy')}
            draft={rule.whenPredicate}
            errors={errorsUnder(errors, `${rule.uid}.when`)}
            busy={busy}
            onChange={(whenPredicate) => onChange({ whenPredicate })}
            subject={{
              label: t('调用参数里的', 'In the call’s params'),
              which: t('调用参数里的哪个值', 'which param'),
              placeholder: t(
                `参数，如 ${params[0] ?? 'host'}`,
                `A param, e.g. ${params[0] ?? 'host'}`,
              ),
            }}
            testId="eval-case-rule-predicate"
          />
          <p className="text-3 text-small">
            {t(
              `路径从调用参数开始${params.length > 0 ? `，比如 ${params.slice(0, 3).join('、')}` : ''}。`,
              `Paths start at the call’s params${params.length > 0 ? `, e.g. ${params.slice(0, 3).join(', ')}` : ''}.`,
            )}
          </p>
        </div>
      ) : null}
      <Field
        id={`${id}-answer`}
        label={t('回答', 'Answer')}
        required
        error={errors[`${rule.uid}.answer`] ?? null}
      >
        <Select
          id={`${id}-answer`}
          aria-label={t('回答', 'Answer')}
          value={rule.answer}
          onChange={(event) =>
            onChange({ answer: event.target.value as FixtureRuleDraft['answer'] })
          }
          disabled={busy}
          invalid={errors[`${rule.uid}.answer`] !== undefined}
          data-testid="eval-case-rule-answer"
        >
          <option value="data">{t('返回数据', 'Return data')}</option>
          {absentOffered ? (
            <option value="absent">{t('回答“要查的东西不存在”', 'Answer “not there”')}</option>
          ) : null}
          <option value="error">{t('报错', 'Fail with an error')}</option>
        </Select>
      </Field>
      {rule.answer === 'data' ? (
        <Field
          id={`${id}-data`}
          label={t('返回的数据', 'Data returned')}
          required
          hint={
            errors[`${rule.uid}.data`] !== undefined
              ? undefined
              : t('门会返回的结果，写成 JSON。', 'The result the gate would return, as JSON.')
          }
          error={errors[`${rule.uid}.data`] ?? null}
        >
          <Textarea
            id={`${id}-data`}
            aria-label={t('返回的数据', 'Data returned')}
            className="mono"
            value={rule.dataText}
            minRows={3}
            maxRows={12}
            onChange={(event) => onChange({ dataText: event.target.value })}
            disabled={busy}
            invalid={errors[`${rule.uid}.data`] !== undefined}
            data-testid="eval-case-rule-data"
          />
        </Field>
      ) : rule.answer === 'error' ? (
        <Field id={`${id}-message`} label={t('错误信息', 'Error message')} required>
          <input
            id={`${id}-message`}
            className="input"
            value={rule.errorMessage}
            maxLength={EVAL_FIXTURE_ERROR_MAX}
            onChange={(event) => onChange({ errorMessage: event.target.value })}
            disabled={busy}
            data-testid="eval-case-rule-message"
          />
        </Field>
      ) : null}
      <span className="row-wrap">
        {/* ux-lint-allow-disabled: the legend says the rule is the first one already. */}
        <Button
          variant="ghost"
          size="s"
          data-move="up"
          data-uid={rule.uid}
          aria-label={t(`上移规则 ${number}`, `Move rule ${number} up`)}
          onClick={() => onMove(-1)}
          disabled={busy || index === 0}
          data-testid="eval-case-rule-up"
        >
          {t('上移', 'Up')}
        </Button>
        {/* ux-lint-allow-disabled: the legend says the rule is the last one already. */}
        <Button
          variant="ghost"
          size="s"
          data-move="down"
          data-uid={rule.uid}
          aria-label={t(`下移规则 ${number}`, `Move rule ${number} down`)}
          onClick={() => onMove(1)}
          disabled={busy || index === count - 1}
          data-testid="eval-case-rule-down"
        >
          {t('下移', 'Down')}
        </Button>
        <Button
          variant="ghost"
          size="s"
          aria-label={t(`删除规则 ${number}`, `Remove rule ${number}`)}
          onClick={() => onMove('remove')}
          disabled={busy}
          data-testid="eval-case-rule-remove"
        >
          {t('删除', 'Remove')}
        </Button>
      </span>
    </fieldset>
  );
}

function AssertionEditor({
  assertion,
  index,
  gates,
  errors,
  busy,
  onChange,
  onRemove,
}: {
  readonly assertion: AssertionDraft;
  readonly index: number;
  readonly gates: readonly EvalFixtureGateWire[];
  readonly errors: Readonly<Record<string, string>>;
  readonly busy: boolean;
  readonly onChange: (patch: Partial<AssertionDraft>) => void;
  readonly onRemove: () => void;
}) {
  const t = useT();
  const id = `eval-case-${assertion.uid}`;
  const number = index + 1;
  const template = assertion.template;
  return (
    <fieldset
      className="stack-s rounded-m border border-border p-3"
      data-testid="eval-case-assertion"
      data-uid={assertion.uid}
      tabIndex={-1}
    >
      <legend className="text-small">{t(`断言 ${number}`, `Assertion ${number}`)}</legend>
      <Field id={`${id}-template`} label={t('要求', 'Requires')}>
        <Select
          id={`${id}-template`}
          aria-label={t('要求', 'Requires')}
          value={template}
          onChange={(event) =>
            onChange({ template: event.target.value as AssertionDraft['template'] })
          }
          disabled={busy}
          data-testid="eval-case-assertion-template"
        >
          {ASSERTION_TEMPLATES.map((candidate) => (
            <option
              key={candidate}
              value={candidate}
              // Counting calls needs a fixture gate to count them on.
              disabled={countsCalls(candidate) && gates.length === 0 && !countsCalls(template)}
            >
              {assertionTemplateLabel(candidate, t)}
            </option>
          ))}
        </Select>
      </Field>
      {template === 'summary_contains' ? (
        <Field
          id={`${id}-text`}
          label={t('摘要里要有的文字', 'Text the summary must contain')}
          required
          hint={t(
            'Worker 报告结果时写的摘要（summary）里要出现这段文字。',
            'The summary the Worker reports its result with must contain this text.',
          )}
        >
          <input
            id={`${id}-text`}
            className="input"
            value={assertion.text}
            onChange={(event) => onChange({ text: event.target.value })}
            disabled={busy}
            aria-describedby={describedBy(`${id}-text`, true, false)}
            data-testid="eval-case-assertion-text"
          />
        </Field>
      ) : template === 'output_equals' ? (
        <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
          <Field
            id={`${id}-field`}
            label={t('输出字段', 'Output field')}
            required
            hint={t(
              'Worker 结果 output 里的顶层字段名。',
              'A top-level field of the Worker’s result output.',
            )}
          >
            <input
              id={`${id}-field`}
              className="input"
              value={assertion.field}
              onChange={(event) => onChange({ field: event.target.value })}
              disabled={busy}
              aria-describedby={describedBy(`${id}-field`, true, false)}
              data-testid="eval-case-assertion-field"
            />
          </Field>
          <ValueInput
            id={`${id}-value`}
            label={t('等于', 'Equals')}
            op="eq"
            kind={assertion.valueKind}
            text={assertion.valueText}
            error={errors[`${assertion.uid}.value`]}
            busy={busy}
            onChange={(patch) =>
              onChange({
                ...(patch.kind !== undefined ? { valueKind: patch.kind } : {}),
                ...(patch.text !== undefined ? { valueText: patch.text } : {}),
              })
            }
            testId="eval-case-assertion-value"
          />
        </div>
      ) : countsCalls(template) ? (
        <div className="stack-s">
          <GateOperationPicker
            id={id}
            gates={gates}
            gatekeeperId={assertion.gatekeeperId}
            operation={assertion.operation}
            busy={busy}
            onChange={(pick) => onChange(pick)}
            testId="eval-case-assertion"
          />
          {template === 'at_most' ? (
            <Field
              id={`${id}-count`}
              label={t('至多几次', 'At most how many times')}
              required
              error={errors[`${assertion.uid}.count`] ?? null}
            >
              <input
                id={`${id}-count`}
                className="input"
                type="number"
                min={1}
                step={1}
                value={assertion.count}
                onChange={(event) => onChange({ count: event.target.value })}
                disabled={busy}
                aria-invalid={errors[`${assertion.uid}.count`] !== undefined || undefined}
                aria-describedby={describedBy(
                  `${id}-count`,
                  false,
                  errors[`${assertion.uid}.count`] !== undefined,
                )}
                data-testid="eval-case-assertion-count"
              />
            </Field>
          ) : null}
        </div>
      ) : (
        <div className="stack-s">
          <PredicateEditor
            id={`${id}-predicate`}
            legend={t('运行要满足', 'The run must satisfy')}
            draft={assertion.predicate}
            errors={errorsUnder(errors, `${assertion.uid}.expect`)}
            busy={busy}
            onChange={(predicate) => onChange({ predicate })}
            subject={{
              label: t('运行里的', 'In the run'),
              which: t('运行里的哪个值', 'which value of the run'),
              placeholder: t('路径，如 result.summary', 'A path, e.g. result.summary'),
            }}
            testId="eval-case-assertion-predicate"
          />
          <p className="text-3 text-small">
            {t(
              '路径从 result（Worker 报告的结果：summary、output 等）或 calls（它对夹具门的每次调用：gatekeeperId、operation、params、answer）开始。',
              'Paths start at result (the result the Worker reported: summary, output, …) or calls (each call it made to a fixture gate: gatekeeperId, operation, params, answer).',
            )}
          </p>
        </div>
      )}
      <Field
        id={`${id}-note`}
        label={t('说明', 'Note')}
        hint={t('可选：这条断言检查什么。', 'Optional: what this assertion checks.')}
      >
        <input
          id={`${id}-note`}
          className="input"
          value={assertion.note}
          maxLength={EVAL_ASSERTION_NOTE_MAX}
          onChange={(event) => onChange({ note: event.target.value })}
          disabled={busy}
          aria-describedby={describedBy(`${id}-note`, true, false)}
          data-testid="eval-case-assertion-note"
        />
      </Field>
      <span className="row-wrap">
        <Button
          variant="ghost"
          size="s"
          aria-label={t(`删除断言 ${number}`, `Remove assertion ${number}`)}
          onClick={onRemove}
          disabled={busy}
          data-testid="eval-case-assertion-remove"
        >
          {t('删除', 'Remove')}
        </Button>
      </span>
    </fieldset>
  );
}
