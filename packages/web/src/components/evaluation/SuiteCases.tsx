import type {
  EvalCaseSummaryWire,
  EvalCaseWire,
  EvalFixtureGateWire,
  EvalSuiteWire,
} from '@nexttime/shared';
import { useRef, useState } from 'react';
import { byData } from '../../hooks/useFocusAfterRender.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  assertionSentence,
  fixtureProblemCountText,
  fixtureProblemText,
  gateOperationText,
  partitionHint,
  ruleAnswerText,
  ruleWhenText,
  splitHint,
} from '../../lib/eval-cases.js';
import { partitionLabel, suiteVersionStep, writeErrors } from '../../lib/evaluation.js';
import { formatDateTime, formatRelative, prettyJsonVisible } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Field, describedBy } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../kit/sheet.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { Textarea } from '../kit/textarea.js';
import { CaseEditor, type CaseSave } from './CaseEditor.js';
import { useFocusAfterChange, useLoadWhen } from './hooks.js';

export interface SuiteCasesProps {
  readonly http: CapabilityCaller;
  readonly suite: EvalSuiteWire;
  readonly principalNames: ReadonlyMap<string, string>;
  /** One governed change at the version shown (`SuiteDetail`'s): the suite it left. A stale
   *  version re-reads the suite and rethrows. */
  readonly change: (write: () => Promise<EvalSuiteWire>) => Promise<EvalSuiteWire>;
  /** What the case sheet shows — held by `SuiteDetail`, whose fixture gate cards open the cases
   *  that use a gate. */
  readonly opened: OpenedCase | null;
  readonly onOpenedChange: (next: OpenedCase | null) => void;
}

const REASON_MAX = 500;

/** The case sheet: adding a case, or one case shown (and maybe edited). */
export type OpenedCase =
  | { readonly mode: 'add' }
  | { readonly mode: 'case'; readonly caseId: string };

/**
 * components/evaluation/SuiteCases (S10 E3-1b): the 用例 section of a suite's detail — the cases
 * the suite holds at its version, each with its partition, dev / holdout split and whether a
 * fixture rule needs attention after a fixture gate sync; 添加用例; and a case's sheet,
 * which shows it whole (input, fixture rules in order, assertions as sentences) with 编辑 (a
 * reason required; the old case is retired and the new one replaces it) and 退役 (a reason
 * required). Every change is a new suite version, at the version the reader saw.
 */
export function SuiteCases({
  http,
  suite,
  principalNames,
  change,
  opened,
  onOpenedChange: setOpened,
}: SuiteCasesProps) {
  const t = useT();
  const can = useRoleCan(http);
  const canAdd = can('add_eval_case') !== false;
  const canEdit = can('edit_eval_case') !== false;
  // A retired case takes its row, and the title that opened its sheet, with it.
  const [section, focusSection] = useFocusAfterChange<HTMLElement>();
  // The case the sheet was opened on, kept while it stays open (an edit moves it to the case
  // that replaced it; idempotent, so it may be noted while rendering).
  const openedFor = useRef<string | null>(null);
  const shown = opened?.mode === 'case' ? opened.caseId : null;
  if (opened === null) openedFor.current = null;
  else if (openedFor.current === null) openedFor.current = shown;
  const openedOn = openedFor.current;
  /** An edit replaced the row that opened the sheet (#810 UX P3-3): closing hands focus to the
   *  row of the case it shows now, not to <body>. */
  const returnFocus = (event: Event) => {
    if (shown === null || shown === openedOn) return;
    const row = byData(
      section.current,
      '[data-case-id]',
      'caseId',
      shown,
    )?.querySelector<HTMLElement>('[data-testid="eval-case-open"]');
    if (row === undefined || row === null) return;
    event.preventDefault();
    row.focus();
  };
  const at = { suiteId: suite.id, suiteVersion: suite.version };
  const attention = suite.cases.filter((item) => item.fixtureProblems.length > 0).length;
  const dev = suite.cases.filter((item) => item.split === 'dev').length;

  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={t('用例', 'Cases')}
      className="stack-s"
      data-testid="eval-suite-cases"
    >
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span className="row-wrap">
          <span className="section-title">{t('用例', 'Cases')}</span>
          {suite.cases.length > 0 ? (
            <span className="text-3 text-small tabular" data-testid="eval-suite-cases-count">
              {t(
                `${suite.cases.length} 条（dev ${dev}，holdout ${suite.cases.length - dev}）`,
                `${suite.cases.length} (dev ${dev}, holdout ${suite.cases.length - dev})`,
              )}
            </span>
          ) : null}
        </span>
        {canAdd ? (
          <Button
            variant="secondary"
            size="s"
            onClick={() => setOpened({ mode: 'add' })}
            data-testid="eval-case-add-trigger"
          >
            {t('添加用例', 'Add case')}
          </Button>
        ) : null}
      </div>
      <p className="text-3 text-small">
        {t(
          '每条用例给 Worker 一个输入，用夹具规则回答它对夹具门的调用，再用断言判断这次运行。',
          'Each case gives the Worker an input, answers its calls to the fixture gates with fixture rules, and judges the run with assertions.',
        )}
      </p>
      {attention > 0 ? (
        <Notice tone="warn" testId="eval-suite-cases-attention">
          {canEdit
            ? t(
                `${attention} 条用例的夹具规则在夹具门同步后对不上了，打开它们编辑。`,
                `${attention} case(s) have fixture rules a fixture gate sync left without a match; open them to edit.`,
              )
            : t(
                `${attention} 条用例的夹具规则在夹具门同步后对不上了，打开它们查看。`,
                `${attention} case(s) have fixture rules a fixture gate sync left without a match; open them to see which.`,
              )}
        </Notice>
      ) : null}
      {suite.cases.length === 0 ? (
        <p className="text-3" data-testid="eval-suite-cases-empty">
          {t('还没有用例。', 'No case yet.')}
        </p>
      ) : (
        <ul className="eval-suite-history" data-testid="eval-suite-cases-list">
          {suite.cases.map((item) => (
            <CaseRow
              key={item.id}
              item={item}
              onOpen={() => setOpened({ mode: 'case', caseId: item.id })}
            />
          ))}
        </ul>
      )}

      <Sheet open={opened !== null} onOpenChange={(open) => !open && setOpened(null)}>
        {opened === null ? null : opened.mode === 'add' ? (
          canAdd ? (
            <SheetContent size="wide" data-testid="eval-case-sheet">
              <SheetHeader>
                <SheetTitle>{t('添加用例', 'Add case')}</SheetTitle>
                <SheetDescription>
                  {t(
                    `${suiteVersionStep(suite.version, t)}。用例只给人看，智能体读不到。`,
                    `${suiteVersionStep(suite.version, t)}. A case is shown to people only, never to an agent.`,
                  )}
                </SheetDescription>
              </SheetHeader>
              <CaseEditor
                gates={suite.fixtureGates}
                onCancel={() => setOpened(null)}
                onSave={async (save: CaseSave) => {
                  await change(() =>
                    http.call<EvalSuiteWire>('add_eval_case', {
                      ...at,
                      ...save.kind,
                      ...save.content,
                    }),
                  );
                  setOpened(null);
                }}
              />
            </SheetContent>
          ) : null
        ) : (
          <CaseSheetContent
            key={opened.caseId}
            http={http}
            suite={suite}
            caseId={opened.caseId}
            principalNames={principalNames}
            canEdit={canEdit}
            canRetire={can('retire_eval_case') !== false}
            onCloseAutoFocus={returnFocus}
            onEdit={async (save) => {
              const next = await change(() =>
                http.call<EvalSuiteWire>('edit_eval_case', {
                  ...at,
                  caseId: opened.caseId,
                  reason: save.reason ?? '',
                  ...save.content,
                }),
              );
              const replacement = next.cases.find((item) => item.supersedes === opened.caseId);
              setOpened(
                replacement === undefined ? null : { mode: 'case', caseId: replacement.id },
              );
            }}
            onRetire={async (reason) => {
              await change(() =>
                http.call<EvalSuiteWire>('retire_eval_case', {
                  ...at,
                  caseId: opened.caseId,
                  reason,
                }),
              );
              setOpened(null);
              focusSection();
            }}
          />
        )}
      </Sheet>
    </section>
  );
}

function CaseKindChips({
  item,
}: {
  readonly item: Pick<EvalCaseSummaryWire, 'partition' | 'split' | 'mechanism'>;
}) {
  const t = useT();
  return (
    <>
      <span className="tag" data-testid="eval-case-partition-tag">
        {partitionLabel(item.partition, t)}
        {item.mechanism !== null ? `：${item.mechanism}` : ''}
      </span>
      <span className="tag" data-testid="eval-case-split-tag" data-split={item.split}>
        {item.split}
      </span>
    </>
  );
}

function CaseRow({
  item,
  onOpen,
}: {
  readonly item: EvalCaseSummaryWire;
  readonly onOpen: () => void;
}) {
  const t = useT();
  return (
    <li data-testid="eval-case" data-case-id={item.id} data-split={item.split}>
      <span className="row-wrap">
        <Button
          variant="ghost"
          size="s"
          className="wrap-anywhere"
          onClick={onOpen}
          data-testid="eval-case-open"
        >
          {item.title}
        </Button>
        <CaseKindChips item={item} />
      </span>
      <span className="row-wrap text-3 text-small">
        <span className="tabular">
          {t(
            `${item.fixtureRuleCount} 条夹具规则 · ${item.assertionCount} 条断言`,
            `${item.fixtureRuleCount} fixture rule(s) · ${item.assertionCount} assertion(s)`,
          )}
        </span>
        <span className="meta-sep" />
        <span className="tabular">
          {item.supersedes === null
            ? t(`用例集 v${item.addedInVersion} 添加`, `added at suite v${item.addedInVersion}`)
            : t(`用例集 v${item.addedInVersion} 编辑`, `edited at suite v${item.addedInVersion}`)}
        </span>
      </span>
      {item.fixtureProblems.length > 0 ? (
        <span className="text-small text-warn" data-testid="eval-case-attention">
          {fixtureProblemCountText(item.fixtureProblems.length, t)}
        </span>
      ) : null}
    </li>
  );
}

function CaseSheetContent({
  http,
  suite,
  caseId,
  principalNames,
  canEdit,
  canRetire,
  onEdit,
  onRetire,
  onCloseAutoFocus,
}: {
  readonly http: CapabilityCaller;
  readonly suite: EvalSuiteWire;
  readonly caseId: string;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly canEdit: boolean;
  readonly canRetire: boolean;
  readonly onEdit: (save: CaseSave) => Promise<void>;
  readonly onRetire: (reason: string) => Promise<void>;
  readonly onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useT();
  // Read again whenever the suite moves on: a sync or a removal changes what a rule finds.
  const read = useLoadWhen(`${caseId}@${suite.version}`, () =>
    http.call<EvalCaseWire>('get_eval_case', { suiteId: suite.id, caseId }),
  );
  // The case an edit started from: kept while the form is open, whatever re-reads in between.
  const [editing, setEditing] = useState<EvalCaseWire | null>(null);
  // The last read stays on screen while the next one loads.
  const last = useRef<EvalCaseWire | null>(null);
  if (read.status === 'ready' && read.data !== undefined) last.current = read.data;
  const evalCase = last.current;

  const title =
    editing !== null ? t('编辑用例', 'Edit case') : (evalCase?.title ?? t('用例', 'Case'));
  return (
    <SheetContent size="wide" onCloseAutoFocus={onCloseAutoFocus} data-testid="eval-case-sheet">
      <SheetHeader>
        <SheetTitle className="wrap-anywhere">{title}</SheetTitle>
        <SheetDescription>
          {editing !== null
            ? t(
                `${suiteVersionStep(suite.version, t)}。旧的一条退役，新的一条接替它。`,
                `${suiteVersionStep(suite.version, t)}. The old case is retired and the new one replaces it.`,
              )
            : t(
                '用例只给人看，智能体读不到。',
                'A case is shown to people only, never to an agent.',
              )}
        </SheetDescription>
      </SheetHeader>
      {editing !== null && canEdit ? (
        <CaseEditor
          gates={suite.fixtureGates}
          editing={editing}
          onCancel={() => setEditing(null)}
          onSave={async (save) => {
            await onEdit(save);
            setEditing(null);
          }}
        />
      ) : evalCase === null ? (
        read.status === 'error' ? (
          <InlineError error={read.error} testId="eval-case-read-error" />
        ) : (
          <SkeletonRows
            count={4}
            label={t('正在加载用例', 'Loading case')}
            testId="eval-case-loading"
          />
        )
      ) : (
        <>
          <CaseView
            evalCase={evalCase}
            gates={suite.fixtureGates}
            principalNames={principalNames}
            http={http}
          />
          <SheetFooter>
            {canRetire && evalCase.retiredInVersion === null ? (
              <RetireCaseConfirm
                evalCase={evalCase}
                suiteVersion={suite.version}
                onRetire={onRetire}
              />
            ) : null}
            {canEdit && evalCase.retiredInVersion === null ? (
              <Button
                variant="primary"
                onClick={() => setEditing(evalCase)}
                data-testid="eval-case-edit"
              >
                {t('编辑', 'Edit')}
              </Button>
            ) : null}
            {/* A reader with nothing to change has no other way out of a full-screen sheet on a
             *  phone (no overlay to tap, no Esc) — #810 UX P2-2. */}
            <SheetClose asChild>
              <Button variant="ghost" data-testid="eval-case-close">
                {t('关闭', 'Close')}
              </Button>
            </SheetClose>
          </SheetFooter>
        </>
      )}
    </SheetContent>
  );
}

function CaseView({
  http,
  evalCase,
  gates,
  principalNames,
}: {
  readonly http: CapabilityCaller;
  readonly evalCase: EvalCaseWire;
  readonly gates: readonly EvalFixtureGateWire[];
  readonly principalNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const problems = new Map(
    evalCase.fixtureProblems.map((problem) => [problem.index, problem.problem]),
  );
  const items: KeyValueItem[] = [
    {
      key: 'partition',
      label: t('分区', 'Partition'),
      value: (
        <span className="stack-s">
          <span>{partitionLabel(evalCase.partition, t)}</span>
          <span className="text-3 text-small">{partitionHint(evalCase.partition, t)}</span>
        </span>
      ),
    },
    ...(evalCase.mechanism !== null
      ? [{ key: 'mechanism', label: t('机制', 'Mechanism'), value: evalCase.mechanism }]
      : []),
    {
      key: 'split',
      label: 'dev / holdout',
      value: (
        <span className="stack-s">
          <span>{evalCase.split}</span>
          <span className="text-3 text-small">{splitHint(evalCase.split, t)}</span>
        </span>
      ),
    },
    {
      key: 'added',
      label: evalCase.supersedes === null ? t('添加', 'Added') : t('编辑', 'Edited'),
      value: (
        <span className="row-wrap">
          <span className="tabular">
            {t(`用例集 v${evalCase.addedInVersion}`, `suite v${evalCase.addedInVersion}`)}
          </span>
          <RefChip
            kind="principal"
            id={evalCase.addedBy}
            name={principalNames.get(evalCase.addedBy) ?? null}
            http={http}
            size="s"
          />
          <time className="text-3" title={formatDateTime(evalCase.addedAt)}>
            {formatRelative(evalCase.addedAt)}
          </time>
        </span>
      ),
    },
  ];
  return (
    <div className="stack" data-testid="eval-case-view" data-case-id={evalCase.id}>
      {evalCase.retiredInVersion !== null ? (
        <Notice tone="info" testId="eval-case-retired">
          {evalCase.supersededBy !== null
            ? t(
                `这条用例在用例集 v${evalCase.retiredInVersion} 被编辑，新的一条接替了它。`,
                `This case was edited at suite v${evalCase.retiredInVersion}; a new one replaced it.`,
              )
            : t(
                `这条用例在用例集 v${evalCase.retiredInVersion} 退役。`,
                `This case was retired at suite v${evalCase.retiredInVersion}.`,
              )}
          {evalCase.retireReason !== null
            ? ` ${t('原因：', 'Reason: ')}${evalCase.retireReason}`
            : ''}
        </Notice>
      ) : null}
      <KeyValue items={items} testId="eval-case-overview" />

      <section className="stack-s">
        <span className="section-title">{t('输入', 'Input')}</span>
        <pre className="code-block pre-wrap" data-testid="eval-case-view-input">
          {typeof evalCase.input === 'string' ? evalCase.input : prettyJsonVisible(evalCase.input)}
        </pre>
      </section>

      <section className="stack-s" data-testid="eval-case-view-rules">
        <span className="section-title">{t('夹具规则', 'Fixture rules')}</span>
        {evalCase.fixtures.length === 0 ? (
          <p className="text-3 text-small">
            {t(
              '没有规则：Worker 的每次调用都得到“夹具没有答案”。',
              'No rule: every call the Worker makes gets “the fixture has no answer”.',
            )}
          </p>
        ) : (
          <ol className="eval-suite-history">
            {evalCase.fixtures.map((rule, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rules are ordered and never reordered in a read
              <li key={index} data-testid="eval-case-view-rule">
                <span className="row-wrap">
                  <span className="tag tabular">{index + 1}</span>
                  <span className="mono wrap-anywhere">
                    {gateOperationText(gates, rule.gatekeeperId, rule.operation, t)}
                  </span>
                </span>
                <span className="text-2 text-small">
                  {ruleWhenText(rule, t)}
                  {t(' → ', ' → ')}
                  {ruleAnswerText(rule, t)}
                </span>
                {rule.answer.kind === 'data' ? (
                  <pre className="code-block">{prettyJsonVisible(rule.answer.data)}</pre>
                ) : null}
                {problems.has(index) ? (
                  <Notice tone="warn" testId="eval-case-view-rule-problem">
                    {fixtureProblemText(
                      problems.get(index) as Parameters<typeof fixtureProblemText>[0],
                      t,
                    )}
                  </Notice>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <p className="text-3 text-small">
          {t(
            '按顺序匹配，第一条匹配的规则作答；没有规则匹配的调用得到“夹具没有答案”。',
            'Matched in order; the first rule that matches answers. A call no rule matches gets “the fixture has no answer”.',
          )}
        </p>
      </section>

      <section className="stack-s" data-testid="eval-case-view-assertions">
        <span className="section-title">{t('断言', 'Assertions')}</span>
        <ol className="eval-suite-history">
          {evalCase.assertions.map((assertion, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: assertions are read in their order
            <li key={index} data-testid="eval-case-view-assertion">
              <span className="wrap-anywhere">{assertionSentence(assertion, gates, t)}</span>
              {assertion.note !== undefined ? (
                <span className="text-3 text-small">{assertion.note}</span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="text-3 text-small">
          {t('每条断言都成立，用例才算通过。', 'The case passes when every assertion holds.')}
        </p>
      </section>
    </div>
  );
}

function RetireCaseConfirm({
  evalCase,
  suiteVersion,
  onRetire,
}: {
  readonly evalCase: EvalCaseWire;
  readonly suiteVersion: number;
  readonly onRetire: (reason: string) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const reasonId = `eval-case-retire-reason-${evalCase.id}`;
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason('');
      }}
      anchor={
        <Button
          variant="ghost"
          onClick={() => setOpen(true)}
          data-testid="eval-case-retire-trigger"
        >
          {t('退役', 'Retire')}
        </Button>
      }
      title={t(`退役用例「${evalCase.title}」`, `Retire case “${evalCase.title}”`)}
      description={t(
        '之后的评测不再跑这条用例；之前的用例集版本仍保留它。原因记入变更记录。',
        'Later evaluation no longer runs this case; earlier suite versions still hold it. The reason is kept in the history.',
      )}
      target={evalCase.title}
      impact={[suiteVersionStep(suiteVersion, t)]}
      confirmLabel={t('退役', 'Retire')}
      danger
      confirmDisabled={trimmed === ''}
      onConfirm={() => onRetire(trimmed)}
      errorOverrides={writeErrors(t)}
      testId="eval-case-retire"
    >
      <Field
        id={reasonId}
        label={t('退役原因', 'Reason')}
        hint={t('必填，记入变更记录。', 'Required; kept in the history.')}
        required
      >
        <Textarea
          id={reasonId}
          aria-label={t('退役原因', 'Retirement reason')}
          aria-required
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={describedBy(reasonId, true, false)}
          data-testid="eval-case-retire-reason"
        />
      </Field>
    </Confirm>
  );
}
