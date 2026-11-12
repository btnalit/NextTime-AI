import { MAX_REVIEW_CRITERIA, REVIEW_WEIGHT_MAX } from '@nexttime/shared';
import { useId, useRef } from 'react';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import { byData, useFocusAfterRender } from '../../hooks/useFocusAfterRender.js';
import type { AgentPolicy } from '../../lib/agent-profile.js';
import { narrowByPolicyAllowList } from '../../lib/agent-profile.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  type CheckDraft,
  type FieldKey,
  REVIEW_PASS_AT_CHOICES,
  type ReviewDraft,
  type StepDraft,
  newReviewCriterion,
} from '../../lib/goal-plan-draft.js';
import {
  inPlanOrder,
  planReviewModelMatch,
  planReviewModelNote,
  reviewPassText,
  reviewProxyText,
} from '../../lib/goal-review.js';
import type { ModelRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { CheckboxListField, toggleListItem } from '../catalog/DirectoryPickers.js';
import { Button } from '../kit/button.js';
import { Field, describedBy } from '../kit/field.js';
import { ModelHealthNote, ModelOption, withModelHealthNote } from '../kit/model-health.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { Textarea } from '../kit/textarea.js';

const WEIGHTS = Array.from({ length: REVIEW_WEIGHT_MAX }, (_, index) => String(index + 1));

/**
 * components/goals/ReviewCheckEditor (S11 GO18b; `s11-w4/go18-default-plan.md` §4): an independent
 * review in the plan editor — what it reviews, what it scores, the line it passes at and the model
 * that scores. Nothing that can be chosen is typed (victor 10-09): the steps are ticked from the
 * plan's own, each criterion's weight and the pass line are picked, the model comes from the
 * catalog's models the workspace allows, and the criteria's keys are made up by the editor. Only
 * what each criterion asks is written.
 *
 * Under the line, the points it means with these weights (`reviewPassText`, the kernel's integer
 * rule); under the model, whether the review may end up scoring its own steps' work with the
 * model that did it. The kernel decides (`revise_goal`: `reviewShapeProblems`, the model offered
 * and allowed), and a review only ever scores: the verdict is the platform's arithmetic, a proxy
 * indicator, never the reviewer's word.
 */
export function ReviewCheckEditor({
  check,
  review,
  steps,
  http,
  errorOf,
  onChange,
}: {
  readonly check: CheckDraft;
  readonly review: ReviewDraft;
  /** The draft's steps: the ones kept are what a review may review. */
  readonly steps: readonly StepDraft[];
  readonly http: CapabilityCaller;
  readonly errorOf: (key: FieldKey) => string | null;
  readonly onChange: (review: ReviewDraft) => void;
}) {
  const t = useT();
  const id = useId();
  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const policy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  const criteriaRef = useRef<HTMLDivElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const at = (field: 'subjects' | 'criteria' | 'passAt' | 'model') =>
    `check:${check.uid}:${field}` as const;
  const patch = (next: Partial<ReviewDraft>) => onChange({ ...review, ...next });

  const kept = steps.filter((step) => !step.removed && step.key !== '');
  const subjectOptions = kept.map((step) => ({
    id: step.key,
    label: <span className="mono">{step.key}</span>,
  }));
  const modelRows = narrowByPolicyAllowList(
    models.state.status === 'ready' ? models.state.data.items : [],
    policy.state.status === 'ready' ? policy.state.data.allowedModels : undefined,
    (row) => row.id,
  );
  const modelKnown = review.model === '' || modelRows.some((row) => row.id === review.model);
  const passChoices = REVIEW_PASS_AT_CHOICES.includes(Number(review.passAt))
    ? REVIEW_PASS_AT_CHOICES
    : [...REVIEW_PASS_AT_CHOICES, Number(review.passAt)].sort((a, b) => a - b);
  const modelNote = planReviewModelNote(
    planReviewModelMatch(
      { subjects: review.subjects, model: review.model === '' ? undefined : review.model },
      {
        steps: kept.map((step) => ({
          key: step.key,
          spec: step.spec.model === '' ? undefined : { model: step.spec.model },
        })),
      },
    ),
    t,
    true,
  );
  const criterionItem = (uid: string | undefined) =>
    uid === undefined
      ? undefined
      : byData(criteriaRef.current, '[data-criterion-uid]', 'criterionUid', uid);
  const criteriaError = errorOf(at('criteria'));
  const passAtError = errorOf(at('passAt'));
  const modelError = errorOf(at('model'));

  return (
    <div className="stack-s" data-testid="goal-plan-review">
      <CheckboxListField
        legend={t('评审哪些步骤的产出', 'Whose output it reviews')}
        hint={t(
          '评审读这些步骤最后一次被接受的输出和它们留下的文件。',
          'The reviewer reads the output each of these steps last had accepted, and the files it left.',
        )}
        error={errorOf(at('subjects'))}
        options={subjectOptions}
        selected={review.subjects}
        // In the plan's order, whatever order they were ticked in (UX acceptance of #1111).
        onToggle={(key) =>
          patch({
            subjects: inPlanOrder(
              toggleListItem(review.subjects, key),
              kept.map((step) => step.key),
            ),
          })
        }
        testId="goal-plan-review-subjects"
        emptyHint={t('计划里还没有步骤。', 'The plan has no steps yet.')}
      />

      <div className="field" ref={criteriaRef} data-testid="goal-plan-review-criteria">
        <span className="field-label">{t('评分标准', 'Criteria')}</span>
        <span className="text-3 text-small">
          {t(
            '每条写清楚好的产出在这一点上是什么样。评审逐条打 0 到 4 分，乘以权重相加；权重越大，这一条越要紧。',
            'Say for each what good output looks like on that point. The reviewer scores each 0 to 4, multiplied by its weight and added up; the heavier the weight, the more it counts.',
          )}
        </span>
        <ol className="stack-s">
          {review.criteria.map((criterion, index) => {
            const error = errorOf(`check:${check.uid}:criterion:${criterion.uid}`);
            const n = index + 1;
            return (
              <li
                key={criterion.uid}
                className="stack-s"
                data-testid="goal-plan-review-criterion"
                data-criterion-uid={criterion.uid}
                data-criterion={criterion.key}
              >
                <Field
                  id={`${id}-criterion-${criterion.uid}`}
                  label={t(`第 ${n} 条标准`, `Criterion ${n}`)}
                  error={error}
                >
                  <Textarea
                    id={`${id}-criterion-${criterion.uid}`}
                    aria-label={t(`第 ${n} 条标准`, `Criterion ${n}`)}
                    value={criterion.description}
                    onChange={(event) =>
                      patch({
                        criteria: review.criteria.map((item) =>
                          item.uid === criterion.uid
                            ? { ...item, description: event.target.value }
                            : item,
                        ),
                      })
                    }
                    minRows={2}
                    maxRows={6}
                    invalid={error !== null}
                    data-testid="goal-plan-review-criterion-description"
                  />
                </Field>
                <div className="row-wrap">
                  <Select
                    aria-label={t(`第 ${n} 条标准的权重`, `Weight of criterion ${n}`)}
                    className="select-fit"
                    value={criterion.weight}
                    onChange={(event) =>
                      patch({
                        criteria: review.criteria.map((item) =>
                          item.uid === criterion.uid
                            ? { ...item, weight: event.target.value }
                            : item,
                        ),
                      })
                    }
                    data-testid="goal-plan-review-criterion-weight"
                  >
                    {WEIGHTS.map((weight) => (
                      <option key={weight} value={weight}>
                        {weight === '1'
                          ? t('权重 1（最轻）', 'Weight 1 (lightest)')
                          : weight === String(REVIEW_WEIGHT_MAX)
                            ? t(`权重 ${weight}（最重）`, `Weight ${weight} (heaviest)`)
                            : t(`权重 ${weight}`, `Weight ${weight}`)}
                      </option>
                    ))}
                  </Select>
                  {review.criteria.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => {
                        // Gone: the next criterion's text, else the one before it.
                        const next =
                          review.criteria[index + 1]?.uid ?? review.criteria[index - 1]?.uid;
                        focusAfterRender(() => criterionItem(next)?.querySelector('textarea'));
                        patch({
                          criteria: review.criteria.filter((item) => item.uid !== criterion.uid),
                        });
                      }}
                      data-testid="goal-plan-review-criterion-remove"
                    >
                      {t('删掉这条标准', 'Remove this criterion')}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {criteriaError ? (
          <p className="field-error" role="alert">
            {criteriaError}
          </p>
        ) : null}
        {review.criteria.length < MAX_REVIEW_CRITERIA ? (
          <div>
            <Button
              variant="secondary"
              size="s"
              onClick={() => {
                const added = newReviewCriterion(review, check.original);
                focusAfterRender(() => criterionItem(added.uid)?.querySelector('textarea'));
                patch({ criteria: [...review.criteria, added] });
              }}
              data-testid="goal-plan-review-add-criterion"
            >
              {t('加一条标准', 'Add a criterion')}
            </Button>
          </div>
        ) : (
          <span className="text-3 text-small">
            {t(
              `一条评审最多 ${MAX_REVIEW_CRITERIA} 条标准。`,
              `A review has at most ${MAX_REVIEW_CRITERIA} criteria.`,
            )}
          </span>
        )}
      </div>

      <Field
        id={`${id}-pass-at`}
        label={t('通过线', 'Pass line')}
        hint={reviewPassText(
          {
            criteria: review.criteria.map((criterion) => ({ weight: Number(criterion.weight) })),
            passAt: Number(review.passAt),
          },
          t,
        )}
        error={passAtError}
      >
        <Select
          id={`${id}-pass-at`}
          aria-label={t('通过线', 'Pass line')}
          className="select-fit"
          value={review.passAt}
          onChange={(event) => patch({ passAt: event.target.value })}
          invalid={passAtError !== null}
          data-testid="goal-plan-review-pass-at"
        >
          {passChoices.map((passAt) => (
            <option key={passAt} value={String(passAt)}>
              {t(`得分达到满分的 ${passAt}%`, `${passAt}% of the most it can score`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={`${id}-model`}
        label={t('评审模型', 'Reviewer model')}
        hint={t(
          '从模型目录里这个工作区允许的模型中选；和做这些步骤的模型不同，评审更可信。',
          'From the catalog’s models this workspace allows; a model other than the one doing the steps makes the review more telling.',
        )}
        error={modelError}
      >
        <Select
          id={`${id}-model`}
          aria-label={t('评审模型', 'Reviewer model')}
          className="select-fit"
          value={review.model}
          onChange={(event) => patch({ model: event.target.value })}
          invalid={modelError !== null}
          aria-describedby={withModelHealthNote(
            describedBy(`${id}-model`, true, modelError !== null),
            `${id}-model-health`,
            modelRows,
            review.model,
          )}
          data-testid="goal-plan-review-model"
        >
          <option value="">
            {t(
              '请求人的模型（请求人的智能体设置来选）',
              'The requester’s (their agent settings pick it)',
            )}
          </option>
          {!modelKnown ? <option value={review.model}>{review.model}</option> : null}
          {modelRows.map((row) => (
            <ModelOption key={row.id} model={row} selected={row.id === review.model} />
          ))}
        </Select>
        <ModelHealthNote
          models={modelRows}
          selectedId={review.model}
          canFix={false}
          testId="goal-plan-review-model-health"
          id={`${id}-model-health`}
        />
        {models.state.status === 'error' ? (
          <span
            className="row-wrap text-small text-warn"
            data-testid="goal-plan-review-models-error"
          >
            {t(
              '读不到模型目录，现在只能选请求人的模型，或者留着原来的模型。',
              'The model catalog cannot be read: for now, only the requester’s model, or the one already chosen.',
            )}
            <Button variant="ghost" size="s" onClick={() => void models.reload()}>
              {t('重新读取', 'Read again')}
            </Button>
          </span>
        ) : null}
      </Field>
      {modelNote ? (
        <Notice tone="warn" testId="goal-plan-review-model-note">
          {modelNote}
        </Notice>
      ) : null}
      <span className="text-3 text-small" data-testid="goal-plan-review-proxy">
        {reviewProxyText(t)}
      </span>
    </div>
  );
}
