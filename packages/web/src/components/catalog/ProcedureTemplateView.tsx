import type { ProcedureBinding, ProcedureStep, StepAcceptanceCheck } from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import { actionKindTagText, prettyJsonVisible } from '../../lib/format.js';
import { factCheckObjectIds, planCheckSentence } from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import {
  type ProcedurePlanPlace,
  parsedProcedureParameters,
  parsedProcedureSteps,
  procedureBindingIssue,
  procedureBindingSentence,
  procedureDependencySentence,
  procedureNoPlanReason,
  procedurePlanPlaces,
  procedureWorkersByKey,
} from '../../lib/procedure-template.js';
import { useGatekeeperNames } from '../approvals/useDirectoryNames.js';
import { OutputContractExplanation, OutputContractFields } from '../goals/OutputContract.js';
import { useObjectLabels } from '../graph/useObjectLabels.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';

const KIND_LABEL: Readonly<Record<ProcedureStep['kind'], readonly [string, string]>> = {
  operation: ['门操作', 'Operation'],
  worker: ['Worker', 'Worker'],
  approval: ['审批', 'Approval'],
  verify: ['验证', 'Verify'],
};

/**
 * components/catalog/ProcedureTemplateView (S11 GO5d-2): a Procedure's steps on its catalog page,
 * read as the template a goal's plan is made from (`lib/procedure-template`) — whether it can make
 * one at all, and for each step what it becomes: a `worker` step's place in the plan, what it waits
 * for, where its inputs come from, its output contract and attempts; a `verify` step's check, the
 * platform's or the requester's. Then the parameters a goal made from it asks for. The steps as
 * JSON stay one click away.
 *
 * UX acceptance of #722: a draft is not yet a template (publishing checks it), so it says so, and
 * a binding the page can already tell is wrong is marked where it is read; a Procedure that makes
 * no plan shows no place in one.
 */
export function ProcedureTemplateView({
  http,
  status,
  steps: rawSteps,
  parameters: rawParameters,
}: {
  readonly http: CapabilityCaller;
  /** The version's status: a draft is only checked as a template when it is published. */
  readonly status: string;
  readonly steps: readonly unknown[];
  readonly parameters: unknown;
}) {
  const t = useT();
  const steps = parsedProcedureSteps(rawSteps);
  const noPlan = procedureNoPlanReason(steps);
  const places: ReadonlyMap<number, ProcedurePlanPlace> =
    noPlan === null ? procedurePlanPlaces(steps) : new Map();
  const workers = procedureWorkersByKey(steps, places);
  const parameters = parsedProcedureParameters(rawParameters);
  const issueOf = (binding: ProcedureBinding, place: ProcedurePlanPlace) =>
    procedureBindingIssue(binding, place, workers, parameters, t);
  const hasIssue = [...places].some(([index, place]) => {
    const step = steps[index];
    return step?.kind === 'worker' && (step.bindings ?? []).some((b) => issueOf(b, place) !== null);
  });
  const draft = status === 'draft';
  return (
    <div className="stack-s procedure-template" data-testid="procedure-template">
      <span className="section-title">{t('步骤', 'Steps')}</span>
      {noPlan === 'manual_step' ? (
        <Notice testId="procedure-template-manual">
          {t(
            '这个流程有门操作或审批步骤，只能照着手动执行，不能用来生成目标的计划：目标的步骤只运行 Worker。',
            'This Procedure has an Operation or approval step, so it is followed by hand and makes no goal plan: a goal’s steps only run Workers.',
          )}
        </Notice>
      ) : noPlan === 'no_worker' ? (
        <Notice testId="procedure-template-manual">
          {t(
            '这个流程没有 Worker 步骤，不能用来生成目标的计划。',
            'This Procedure has no Worker step, so it makes no goal plan.',
          )}
        </Notice>
      ) : (
        <span className="text-small text-3" data-testid="procedure-template-summary">
          {draft
            ? t(
                '发布后可以用这个流程生成目标（发布时平台会检查它生成的计划）：Worker 步骤成为计划的步骤，验证步骤成为目标的验收，带检查的由平台检查，其余由请求人确认。',
                'Once published, a goal can be made from this Procedure (publishing checks the plan it makes): its Worker steps become the plan’s steps, and its verify steps the goal’s acceptance — the platform makes the checks they carry, and the requester confirms the rest.',
              )
            : t(
                '可以用这个流程生成目标：Worker 步骤成为计划的步骤，验证步骤成为目标的验收，带检查的由平台检查，其余由请求人确认。',
                'A goal can be made from this Procedure: its Worker steps become the plan’s steps, and its verify steps the goal’s acceptance — the platform makes the checks they carry, and the requester confirms the rest.',
              )}
        </span>
      )}
      {hasIssue ? (
        <Notice tone="warn" testId="procedure-template-issues">
          {draft
            ? t(
                '下面标出的绑定有问题，这个草稿发布时会被拒：请「编辑为新草稿」，在 JSON 视图里改。',
                'The bindings marked below have problems, so publishing this draft is refused: use “Edit as new draft” and fix them in the JSON view.',
              )
            : t(
                '下面标出的绑定有问题，用这个流程生成目标会被拒。',
                'The bindings marked below have problems, so making a goal from this Procedure is refused.',
              )}
        </Notice>
      ) : null}
      <ol className="stack-s">
        {steps.map((step, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered, unkeyed list.
            key={index}
            className="card card-padded stack-s"
            data-testid="procedure-template-step"
          >
            {step ? (
              <StepBody
                http={http}
                step={step}
                index={index}
                place={places.get(index) ?? null}
                issueOf={issueOf}
                t={t}
              />
            ) : (
              <>
                <span className="tag">{index + 1}</span>
                <pre className="code-block">{prettyJsonVisible(rawSteps[index])}</pre>
              </>
            )}
          </li>
        ))}
      </ol>
      {parameters ? (
        <div className="stack-s" data-testid="procedure-template-parameters">
          <span className="section-title">{t('启动参数', 'Parameters')}</span>
          <span className="text-small text-3">
            {t(
              '用这个流程生成目标时要填写这些参数；步骤的输入可以从中取值。',
              'A goal made from this Procedure is proposed with these parameters; its steps’ inputs can take values from them.',
            )}
          </span>
          <OutputContractFields schema={parameters} t={t} explain={false} />
        </div>
      ) : null}
      <details className="disclosure">
        <summary>{t('步骤原文（JSON）', 'The steps as JSON')}</summary>
        <div className="disclosure-body">
          <pre className="code-block" data-testid="procedure-detail-steps">
            {prettyJsonVisible(rawSteps)}
          </pre>
        </div>
      </details>
    </div>
  );
}

function StepBody({
  http,
  step,
  index,
  place,
  issueOf,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly step: ProcedureStep;
  readonly index: number;
  /** `null`: not a step of a plan (not a `worker` step, or the Procedure makes none). */
  readonly place: ProcedurePlanPlace | null;
  readonly issueOf: (binding: ProcedureBinding, place: ProcedurePlanPlace) => string | null;
  readonly t: Translate;
}) {
  const [zh, en] = KIND_LABEL[step.kind];
  return (
    <>
      <span className="row-wrap">
        <span className="tag">{index + 1}</span>
        <strong>{t(zh, en)}</strong>
        {step.kind === 'worker' ? (
          <>
            <RefChip kind="workerDefinition" id={step.definitionId} http={http} size="s" />
            <span className="text-3 text-small">v{step.version}</span>
          </>
        ) : step.kind === 'operation' ? (
          <>
            <RefChip kind="gatekeeper" id={step.gatekeeperId} http={http} size="s" />
            <span className="mono text-small">{actionKindTagText(step.operationName)}</span>
          </>
        ) : null}
        {place ? (
          <span className="text-small text-3" data-testid="procedure-template-step-key">
            {t('计划里的步骤名', 'In the plan:')} <span className="mono">{place.key}</span>
          </span>
        ) : null}
      </span>
      {step.description ? <span>{step.description}</span> : null}
      {step.kind === 'worker' && place ? (
        <ul className="stack-s text-small" data-testid="procedure-template-step-lines">
          <li>{procedureDependencySentence(place, t)}</li>
          {(step.bindings ?? []).map((binding) => {
            const issue = issueOf(binding, place);
            return (
              <li key={`${binding.from}:${binding.to}`} className="stack-s">
                <span data-testid="procedure-template-binding">
                  {procedureBindingSentence(binding, t)}
                </span>
                {issue ? (
                  <span className="text-warn" data-testid="procedure-template-binding-issue">
                    {issue}
                  </span>
                ) : null}
              </li>
            );
          })}
          {step.maxAttempts !== undefined ? (
            <li>{t(`最多尝试 ${step.maxAttempts} 次`, `At most ${step.maxAttempts} attempts`)}</li>
          ) : null}
        </ul>
      ) : null}
      {step.kind === 'worker' && step.input !== undefined ? (
        <details className="disclosure">
          <summary>{t('写定的输入', 'Its fixed input')}</summary>
          <div className="disclosure-body">
            <pre className="code-block">{prettyJsonVisible(step.input)}</pre>
          </div>
        </details>
      ) : null}
      {step.kind === 'worker' && step.outputSchema !== undefined ? (
        <details className="disclosure" data-testid="procedure-template-output-contract">
          <summary>{t('输出约定', 'Output contract')}</summary>
          <div className="disclosure-body stack-s">
            <OutputContractExplanation t={t} />
            <OutputContractFields schema={step.outputSchema} t={t} explain={false} />
          </div>
        </details>
      ) : null}
      {step.kind === 'verify' ? (
        step.check ? (
          <VerifyCheckLine http={http} check={step.check} t={t} />
        ) : (
          <span className="text-small text-3" data-testid="procedure-template-confirm">
            {t('在目标里由请求人确认这一条。', 'In a goal, the requester confirms this.')}
          </span>
        )
      ) : null}
    </>
  );
}

/** A verify step's check — its own component, so the gate directory is read only when one is. */
function VerifyCheckLine({
  http,
  check,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly check: StepAcceptanceCheck;
  readonly t: Translate;
}) {
  const gateNames = useGatekeeperNames(http);
  const objectNames = useObjectLabels(
    http,
    check.kind === 'fact_predicate' ? factCheckObjectIds(check.fact) : [],
  );
  return (
    <span className="text-small" data-testid="procedure-template-check">
      <span className="text-3">
        {t('在目标里由平台检查：', 'In a goal, the platform checks: ')}
      </span>
      {planCheckSentence(check, gateNames, t, objectNames)}
    </span>
  );
}
