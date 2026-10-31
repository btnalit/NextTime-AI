import type {
  DraftEvaluationArmTallyWire,
  DraftEvaluationEvidenceWire,
  DraftEvaluationSummaryWire,
  PublishAcknowledgementItemWire,
  PublishEvaluationReview,
  SkillPublishCandidateState,
  SkillPublishEvidenceWire,
} from '@nexttime/shared';
import { type ReactNode, useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import type { Resource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  cellText,
  costText,
  draftEvaluationOutcome,
  stageName,
  tallyText,
  verdictReasonText,
} from '../../lib/draft-evaluations.js';
import { formatUsd } from '../../lib/eval-runs.js';
import { formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { DraftEvaluationMeasure } from '../evaluation/DraftEvaluations.js';
import { Button } from '../kit/button.js';
import { GuardedCancelButton } from '../kit/discard-guard.js';
import { Field } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../kit/sheet.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { StillNeeded } from '../kit/still-needed.js';
import { Textarea } from '../kit/textarea.js';

/**
 * components/catalog/SkillPublishReview (S10 E3-3a; docs/s10-evolution-plan-2026-10-04.md §5.5,
 * §5.6 发布审阅): what a Skill draft's evaluations say to whoever publishes it —
 * `get_skill_publish_evidence` for the draft as shown, so every evaluation here evaluated exactly
 * this content (I-E3). The newest is the evidence card: its verdict and why, the stage that gave
 * it and what that stage measured, each case's tries, both arms' cost and tokens, and a link to it
 * under 评测 → 草稿评测. Then the same content's earlier evaluations that still have failures to
 * acknowledge (the rest are in 「评测」 above, #842 UX P3-4), and the evaluations that found
 * another version of the Skill refuted, regressed or worse, each with where that version stands
 * now (#842 UX P2-1).
 *
 * Evaluation gives evidence; it never publishes, nor stops anyone publishing. But a publish names
 * the evidence it was made on (`evaluationReview.evaluationId`), and each failure of a `regressed`
 * or `worse` evaluation (`acknowledge`) is acknowledged with a reason first
 * (`PublishAcknowledgeSheet`) — kept in the publish's audit record.
 */

export interface PublishTarget {
  readonly skillId: string;
  readonly version: number;
  readonly draftDigest: string;
}

/** The draft's publish evidence, read while `target` is set (a draft the viewer may publish)
 *  once the role is known to read it. */
export function useSkillPublishEvidence(
  http: CapabilityCaller,
  target: PublishTarget | null,
): Resource<SkillPublishEvidenceWire> {
  const can = useRoleCan(http);
  return useCapability<SkillPublishEvidenceWire>(http, 'get_skill_publish_evidence', target ?? {}, {
    enabled: target !== null && can('get_skill_publish_evidence') === true,
  });
}

/** How a Skill publish was asked for. */
export interface PublishOptions {
  /** From `PublishAcknowledgeSheet`, which says itself that the evidence moved on (#842 UX P3-2). */
  readonly inSheet?: boolean;
}

/** What a publish of the draft names of `evidence`, with no acknowledgement. */
export function evaluationReviewOf(evidence: SkillPublishEvidenceWire): PublishEvaluationReview {
  return { evaluationId: evidence.evaluations[0]?.id ?? null };
}

/** The key of one failure to acknowledge — one per case of one evaluation. */
function itemKey(item: Pick<PublishAcknowledgementItemWire, 'evaluationId' | 'caseId'>): string {
  return `${item.evaluationId}/${item.caseId}`;
}

/** A difference in dollars, signed: +$0.12, −$0.03, $0.00. */
function signedUsdText(amount: number): string {
  if (Math.abs(amount) < 0.005) return formatUsd(0);
  return `${amount > 0 ? '+' : '−'}${formatUsd(Math.abs(amount))}`;
}

function tokensText(tokens: number, t: Translate): string {
  return t(`${tokens.toLocaleString()} token`, `${tokens.toLocaleString()} tokens`);
}

function armTotalText(tally: DraftEvaluationArmTallyWire, t: Translate): string {
  return `${tallyText(tally, t)} · ${costText(tally.costUsd, t)} · ${tokensText(tally.tokens, t)}`;
}

/** What the draft cost against the baseline over every stage that ran, in a line. */
function costDifferenceText(evidence: DraftEvaluationEvidenceWire, t: Translate): string | null {
  const baseline = evidence.baselineTotal;
  const candidate = evidence.candidateTotal;
  if (baseline.trials === 0 || candidate.trials === 0) return null;
  const tokens = candidate.tokens - baseline.tokens;
  const tokenText = `${tokens > 0 ? '+' : tokens < 0 ? '−' : ''}${Math.abs(tokens).toLocaleString()}`;
  if (baseline.costUsd === null || candidate.costUsd === null) {
    return t(
      `草稿组比基线组 token ${tokenText}；费用差算不出来（有模型没有价格）。`,
      `The draft arm used ${tokenText} tokens against the baseline’s; the cost difference is unknown (a model has no price).`,
    );
  }
  return t(
    `草稿组比基线组费用 ${signedUsdText(candidate.costUsd - baseline.costUsd)}，token ${tokenText}。`,
    `The draft arm cost ${signedUsdText(candidate.costUsd - baseline.costUsd)} and ${tokenText} tokens against the baseline.`,
  );
}

function suiteText(row: Pick<DraftEvaluationSummaryWire, 'suite'>): string {
  return `${row.suite.name} v${row.suite.version}`;
}

/**
 * #842 UX P3-2: what moved in the evidence between a refused submit (`before`) and the evidence
 * read again since (`now`) — another evaluation ended, with its verdict, or one started — and
 * whether the failures to acknowledge grew. `null` while nothing moved (yet).
 */
export function evidenceChangeText(
  before: SkillPublishEvidenceWire,
  now: SkillPublishEvidenceWire,
  t: Translate,
): string | null {
  const latest = now.evaluations[0];
  const ended = latest !== undefined && latest.id !== before.evaluations[0]?.id;
  const started =
    now.runningEvaluationId !== null && now.runningEvaluationId !== before.runningEvaluationId;
  if (!ended && !started) return null;
  const known = new Set(before.acknowledge.map(itemKey));
  const added = now.acknowledge.filter((item) => !known.has(itemKey(item))).length;
  const parts = [
    ended && latest !== undefined
      ? t(
          `又有一次评测结束，结论是「${labelText(statusChipStyle('draftEvaluation', draftEvaluationOutcome(latest)), t)}」`,
          `another evaluation ended: ${labelText(statusChipStyle('draftEvaluation', draftEvaluationOutcome(latest)), t)}`,
        )
      : null,
    started
      ? t(
          '又有一次评测开始了，结束或取消之前不能发布',
          'another evaluation started, and the draft cannot be published until it ends or is cancelled',
        )
      : null,
    added > 0
      ? t(
          `要确认的失败多了 ${added} 条，见下面`,
          `${added} more failure${added === 1 ? '' : 's'} to acknowledge, below`,
        )
      : t('要确认的失败没有变', 'the failures to acknowledge are the same'),
  ].filter((part): part is string => part !== null);
  return t(
    `评测证据在提交前变了，这次没有发布，证据已重新读取：${parts.join('；')}。`,
    `The evaluation evidence changed before the submit, so nothing was published; it has been read again: ${parts.join('; ')}.`,
  );
}

export interface SkillPublishReviewProps {
  readonly evidence: Resource<SkillPublishEvidenceWire>;
}

/** 「发布审阅」 on a Skill draft's detail, for whoever may publish it. */
export function SkillPublishReview({ evidence }: SkillPublishReviewProps) {
  const t = useT();
  const state = evidence.state;
  return (
    <div className="stack-s" data-testid="skill-publish-review">
      <span className="section-title">{t('发布审阅', 'Publish review')}</span>
      {state.status === 'loading' ? (
        <SkeletonRows count={1} label={t('正在读取评测证据', 'Loading the evaluation evidence')} />
      ) : state.status === 'error' ? (
        <div className="stack-s">
          <InlineError error={state.error} testId="skill-publish-review-error" />
          <div>
            <Button
              variant="secondary"
              size="s"
              onClick={() => void evidence.reload()}
              data-testid="skill-publish-review-retry"
            >
              {t('重新读取', 'Read again')}
            </Button>
          </div>
        </div>
      ) : (
        <EvidenceBody evidence={state.data} t={t} />
      )}
    </div>
  );
}

function EvidenceBody({
  evidence,
  t,
}: {
  readonly evidence: SkillPublishEvidenceWire;
  readonly t: Translate;
}) {
  const [latest, ...rest] = evidence.evaluations;
  const pending = (id: string) => evidence.acknowledge.filter((item) => item.evaluationId === id);
  // #842 UX P3-4: 「评测」 above lists every evaluation of this version; here only the earlier
  // ones whose failures a publish still acknowledges.
  const earlier = rest.filter((row) => pending(row.id).length > 0);
  return (
    <>
      {latest === undefined ? (
        <p className="text-3 text-small" data-testid="skill-publish-review-none">
          {evidence.runningEvaluationId !== null
            ? t(
                '这份草稿的评测还在跑，还没有评测结束过。',
                'This draft’s evaluation is still running; none has ended yet.',
              )
            : t(
                '这份草稿的内容没有评测过。评测不是发布的前提；发布记录会写明发布时没有评测证据。',
                'This draft’s content has not been evaluated. Publishing does not need an evaluation; the publish record says it had no evaluation evidence.',
              )}
        </p>
      ) : (
        <EvidenceCard evidence={latest} pending={pending(latest.id)} t={t} />
      )}
      {evidence.acknowledge.length > 0 ? (
        <Notice tone="warn" testId="skill-publish-review-acknowledge">
          {t(
            `评测发现这份草稿在 ${evidence.acknowledge.length} 条用例上不如基线（判定「有回归」或「差于基线」）。可以发布，但发布前要逐条写下为什么仍然发布，理由记入发布的审计记录。`,
            `The evaluations found this draft below the baseline on ${evidence.acknowledge.length} case${evidence.acknowledge.length === 1 ? '' : 's'} (Regressed or Worse). It can still be published, but each is acknowledged first with why — kept in the publish’s audit record.`,
          )}
        </Notice>
      ) : null}
      {earlier.length > 0 ? (
        <div className="stack-s" data-testid="skill-publish-review-earlier">
          <span className="text-2" style={{ fontWeight: 600 }}>
            {t(
              '这份内容更早的、有失败要确认的评测',
              'Earlier evaluations of this content with failures to acknowledge',
            )}
          </span>
          <p className="text-3 text-small">
            {t(
              '同一内容的其他评测都在上面的「评测」里。',
              'The other evaluations of this content are under Evaluations above.',
            )}
          </p>
          <ul className="eval-suite-history">
            {earlier.map((row) => (
              <EvaluationLine
                key={row.id}
                row={row}
                note={t(
                  `要确认：${pending(row.id)
                    .map((item) => item.title)
                    .join('、')}`,
                  `To acknowledge: ${pending(row.id)
                    .map((item) => item.title)
                    .join(', ')}`,
                )}
                testId="skill-publish-review-earlier-row"
              />
            ))}
          </ul>
        </div>
      ) : null}
      {evidence.familyHistory.length > 0 ? (
        <div className="stack-s" data-testid="skill-publish-review-history">
          <span className="text-2" style={{ fontWeight: 600 }}>
            {t(
              '这个 Skill 其他版本的不利评测',
              'Unfavourable evaluations of this Skill’s other versions',
            )}
          </span>
          <p className="text-3 text-small">
            {t(
              '评测判为「机制未证实」「有回归」或「差于基线」的其他版本，以及每个版本现在的状态。',
              'Other versions an evaluation found Refuted, Regressed or Worse, and where each of them stands now.',
            )}
          </p>
          <ul className="eval-suite-history">
            {evidence.familyHistory.map((row) => (
              <EvaluationLine
                key={row.id}
                row={row}
                label={`v${row.candidate.version}`}
                state={row.candidateState}
                note={row.reason !== null ? verdictReasonText(row.reason, t) : null}
                testId="skill-publish-review-history-row"
              />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function EvaluationLine({
  row,
  label,
  state,
  note,
  testId,
}: {
  readonly row: DraftEvaluationSummaryWire;
  readonly label?: string;
  /** What became of the draft it evaluated, for another version's evaluation. */
  readonly state?: SkillPublishCandidateState;
  readonly note: string | null;
  readonly testId: string;
}) {
  return (
    <li data-testid={testId} data-evaluation-id={row.id}>
      <span className="row-wrap">
        <StatusChip machine="draftEvaluation" status={draftEvaluationOutcome(row)} size="s" />
        {label !== undefined ? <span style={{ fontWeight: 600 }}>{label}</span> : null}
        {state !== undefined ? (
          <StatusChip
            machine="skillPublishCandidate"
            status={state}
            size="s"
            testId="skill-publish-review-history-state"
          />
        ) : null}
        <RouteLink href={hrefs.evaluation('drafts', row.id)} className="link-inline">
          {suiteText(row)}
        </RouteLink>
        <span className="text-3 text-small">{formatRelative(row.finishedAt ?? row.createdAt)}</span>
      </span>
      {note !== null ? <span className="text-2 text-small">{note}</span> : null}
    </li>
  );
}

/** The newest evaluation of the draft's content: the evidence a publish names. */
function EvidenceCard({
  evidence,
  pending,
  t,
}: {
  readonly evidence: DraftEvaluationEvidenceWire;
  readonly pending: readonly PublishAcknowledgementItemWire[];
  readonly t: Translate;
}) {
  const stage = evidence.decidingStage;
  const toAcknowledge = new Set(pending.map((item) => item.caseId));
  const difference = costDifferenceText(evidence, t);
  return (
    <section
      className="stack-s draft-eval-stage"
      data-testid="skill-publish-evidence"
      data-evaluation-id={evidence.id}
      data-verdict={evidence.verdict ?? ''}
    >
      <div className="row-wrap">
        <StatusChip
          machine="draftEvaluation"
          status={draftEvaluationOutcome(evidence)}
          size="s"
          testId="skill-publish-evidence-verdict"
        />
        <span style={{ fontWeight: 600 }}>{suiteText(evidence)}</span>
        <span className="text-3 text-small">
          {formatRelative(evidence.finishedAt ?? evidence.createdAt)}
        </span>
        <RouteLink
          href={hrefs.evaluation('drafts', evidence.id)}
          className="link-inline"
          testId="skill-publish-evidence-link"
        >
          {t('查看评测详情', 'See the evaluation')}
        </RouteLink>
      </div>
      <p className="text-ok text-small" data-testid="skill-publish-evidence-same-content">
        {t(
          '✓ 评测的正是这份草稿现在的内容（内容摘要一致）。',
          '✓ It evaluated exactly this draft’s content as it is now (same content digest).',
        )}
      </p>
      {evidence.reason !== null ? (
        <p className="text-small" data-testid="skill-publish-evidence-reason">
          {verdictReasonText(evidence.reason, t)}
        </p>
      ) : null}
      {evidence.verdict === 'inconclusive' ? (
        <p className="text-warn text-small" data-testid="skill-publish-evidence-inconclusive">
          {t(
            '证据不足以证明这份草稿不比基线差。',
            'The evidence cannot show that this draft is no worse than the baseline.',
          )}
        </p>
      ) : null}
      {stage !== null ? (
        <div className="stack-s" data-testid="skill-publish-evidence-stage">
          <span className="text-2 text-small">
            {t(
              `给出结论的阶段：${stageName(stage.stage, t)}`,
              `The stage that gave the verdict: ${stageName(stage.stage, t)}`,
            )}
          </span>
          {stage.measure !== null ? (
            <DraftEvaluationMeasure measure={stage.measure} stage={stage} t={t} />
          ) : null}
          {stage.cases.length > 0 ? (
            <details data-testid="skill-publish-evidence-cases">
              <summary className="text-small">
                {t(
                  `各用例的得分（${stage.cases.length} 条）`,
                  `Each case’s score (${stage.cases.length})`,
                )}
              </summary>
              <div className="table-scroll">
                <table className="data-table data-table-cards">
                  <thead>
                    <tr>
                      <th>{t('用例', 'Case')}</th>
                      <th>{t('基线组', 'Baseline')}</th>
                      <th>{t('草稿组', 'Draft')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stage.cases.map((row) => (
                      <tr
                        key={row.caseId}
                        data-testid="skill-publish-evidence-case"
                        data-case-id={row.caseId}
                        data-acknowledge={toAcknowledge.has(row.caseId) || undefined}
                      >
                        <td>
                          <span className="row-wrap">
                            <span className="wrap-anywhere">{row.title}</span>
                            <span className="tag">{row.split}</span>
                            {toAcknowledge.has(row.caseId) ? (
                              <span className="text-warn text-small">
                                {t('发布前要确认', 'to acknowledge')}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="tabular" data-label={t('基线组', 'Baseline')}>
                          {cellText(row.baseline, t)}
                        </td>
                        <td className="tabular" data-label={t('草稿组', 'Draft')}>
                          {cellText(row.candidate, t)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
      {/* #842 UX P3-3: a title of its own, so the totals do not read as part of the folded cases. */}
      <div className="stack-s">
        <span className="text-2 text-small">
          {t('两组合计（各阶段）', 'Both arms, every stage that ran')}
        </span>
        <ul className="text-small tabular stack-s" data-testid="skill-publish-evidence-totals">
          <li>
            {t('基线组：', 'Baseline: ')}
            {armTotalText(evidence.baselineTotal, t)}
          </li>
          <li>
            {t('草稿组：', 'Draft: ')}
            {armTotalText(evidence.candidateTotal, t)}
          </li>
          {difference !== null ? (
            <li data-testid="skill-publish-evidence-difference">{difference}</li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}

export interface PublishAcknowledgeSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly target: string;
  readonly evidence: SkillPublishEvidenceWire;
  readonly busy: boolean;
  /** One of the draft's evaluations runs now — the publish waits for it to end or be cancelled. */
  readonly evaluating: boolean;
  /** The kernel's credential question, when a publish raised it (`PublishCredentialSlot`) —
   *  answered here, where the person is. */
  readonly credentialSlot: ReactNode;
  readonly credentialBlocked: boolean;
  /** Publishes with `review`; `true` once published (the sheet closes). A refusal because the
   *  evidence moved on is said here (`evidenceChangeText`), not in a toast over the button. */
  readonly onConfirm: (review: PublishEvaluationReview) => Promise<boolean>;
}

/**
 * Publishing a draft whose evaluations found failures (`evidence.acknowledge`, victor 2026-10-23
 * 分叉 2 = b): each failed case, grouped by its evaluation, with both arms' tries on it and a
 * required reason — why the draft is published anyway. The reasons go in `publish_skill`'s
 * `evaluationReview.acknowledgements` and are kept in the publish's audit record. A refusal (the
 * evidence changed meanwhile, a credential question) leaves the sheet open with the reasons typed;
 * the evidence is read again, so a reason belongs to a failure still listed, and the sheet says
 * what changed (#842 UX P3-2).
 */
export function PublishAcknowledgeSheet({
  open,
  onOpenChange,
  target,
  evidence,
  busy,
  evaluating,
  credentialSlot,
  credentialBlocked,
  onConfirm,
}: PublishAcknowledgeSheetProps) {
  const t = useT();
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  // The evidence a refused submit was made on — what the evidence read since is compared with.
  const [refusedOn, setRefusedOn] = useState<SkillPublishEvidenceWire | null>(null);
  const change = refusedOn !== null ? evidenceChangeText(refusedOn, evidence, t) : null;
  const items = evidence.acknowledge;
  const reasonOf = (item: PublishAcknowledgementItemWire) => (reasons[itemKey(item)] ?? '').trim();
  const missing = items.filter((item) => reasonOf(item) === '').length;
  const stillNeeded = [
    missing > 0
      ? t(
          `为 ${missing} 条失败写下理由`,
          `a reason for ${missing} failure${missing === 1 ? '' : 's'}`,
        )
      : null,
    credentialBlocked ? t('确认凭证提示', 'answer the credential question') : null,
    evaluating
      ? t('等正在跑的评测结束或取消', 'the evaluation running now to end or be cancelled')
      : null,
  ].filter((item): item is string => item !== null);
  const ready = items.length > 0 && stillNeeded.length === 0;
  const groups = evidence.evaluations.flatMap((evaluation) => {
    const own = items.filter((item) => item.evaluationId === evaluation.id);
    return own.length > 0 ? [{ evaluation, items: own }] : [];
  });

  function close(): void {
    setReasons({});
    setRefusedOn(null);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    if (!ready || busy) return;
    const submittedOn = evidence;
    setRefusedOn(null);
    const published = await onConfirm({
      ...evaluationReviewOf(evidence),
      acknowledgements: items.map((item) => ({
        evaluationId: item.evaluationId,
        caseId: item.caseId,
        reason: reasonOf(item),
      })),
    });
    if (published) close();
    else setRefusedOn(submittedOn);
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !busy && (next ? onOpenChange(true) : close())}>
      <SheetContent data-testid="publish-acknowledge" data-discard-guard>
        <SheetHeader>
          <SheetTitle>{t(`发布 ${target}`, `Publish ${target}`)}</SheetTitle>
          <SheetDescription>
            {t(
              '评测发现这份草稿在下面这些用例上不如基线。评测只给证据，不拦发布：要发布，就逐条写下为什么仍然发布。理由和这些用例记入发布的审计记录。',
              'The evaluations found this draft below the baseline on the cases below. Evaluation gives evidence and does not stop a publish: to publish, say for each why it is published anyway. The reasons and these cases are kept in the publish’s audit record.',
            )}
          </SheetDescription>
        </SheetHeader>

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {change !== null ? (
            <Notice tone="warn" testId="publish-acknowledge-changed">
              {change}
            </Notice>
          ) : null}
          {groups.map((group) => (
            <section
              key={group.evaluation.id}
              className="stack-s"
              data-testid="publish-acknowledge-evaluation"
              data-evaluation-id={group.evaluation.id}
            >
              <div className="row-wrap">
                <StatusChip
                  machine="draftEvaluation"
                  status={draftEvaluationOutcome(group.evaluation)}
                  size="s"
                />
                <RouteLink
                  href={hrefs.evaluation('drafts', group.evaluation.id)}
                  className="link-inline"
                >
                  {suiteText(group.evaluation)}
                </RouteLink>
                <span className="text-3 text-small">
                  {formatRelative(group.evaluation.finishedAt ?? group.evaluation.createdAt)}
                </span>
              </div>
              {group.items.map((item) => {
                const id = `publish-acknowledge-${item.evaluationId}-${item.caseId}`;
                return (
                  <div
                    key={itemKey(item)}
                    className="stack-s"
                    data-testid="publish-acknowledge-item"
                    data-case-id={item.caseId}
                  >
                    <span className="wrap-anywhere" style={{ fontWeight: 600 }}>
                      {item.title}
                    </span>
                    <span className="text-2 text-small tabular">
                      {t(
                        `${stageName(item.stage, t)} · ${item.split}：基线组 ${cellText(item.baseline, t)}，草稿组 ${cellText(item.candidate, t)}`,
                        `${stageName(item.stage, t)} · ${item.split}: baseline ${cellText(item.baseline, t)}, draft ${cellText(item.candidate, t)}`,
                      )}
                    </span>
                    <Field
                      id={id}
                      label={t('为什么仍然发布', 'Why publish anyway')}
                      hint={t('必填，记入审计', 'Required — kept in the audit trail')}
                      required
                    >
                      <Textarea
                        id={id}
                        value={reasons[itemKey(item)] ?? ''}
                        maxLength={500}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          setReasons((prev) => ({ ...prev, [itemKey(item)]: value }));
                        }}
                        aria-label={t(
                          `为什么仍然发布：${item.title}`,
                          `Why publish anyway: ${item.title}`,
                        )}
                        aria-required
                        data-testid="publish-acknowledge-reason"
                      />
                    </Field>
                  </div>
                );
              })}
            </section>
          ))}
          {credentialSlot}
        </form>

        <SheetFooter>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!ready || busy}
            aria-busy={busy || undefined}
            data-testid="publish-acknowledge-submit"
          >
            {t('确认并发布', 'Acknowledge and publish')}
          </Button>
          <GuardedCancelButton variant="ghost" onCancel={close} disabled={busy}>
            {t('取消', 'Cancel')}
          </GuardedCancelButton>
          <StillNeeded items={stillNeeded} hidden={busy} testId="publish-acknowledge-missing" />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
