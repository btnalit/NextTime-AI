import type { WorkerSpec } from '@nexttime/shared';
import { actionLabel } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  skillRefShown,
  workerSpecFieldLabel,
  workerSpecFields,
  workerSpecSummary,
} from '../../lib/goals.js';
import type { Translate } from '../../lib/i18n.js';
import { KeyValue } from '../kit/key-value.js';
import { RefChip } from '../kit/ref-chip.js';

export interface WorkerSpecFieldsProps {
  readonly spec: WorkerSpec;
  readonly http: CapabilityCaller;
  /** The workspace's gatekeepers by id, where already read; the others resolve themselves. */
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
}

/**
 * components/goals/WorkerSpecFields (S11 GO8a; plan §3.1, I-G8): what a step sets differently for
 * its Worker — the plan entry's WorkerSpec, field by field, each as the console names it (gates by
 * name, capabilities by their console names, Skills as the plan names them), under a line naming
 * what was set and over one saying how it combines with the Worker: lists and the model replace
 * the Worker's, the responsibility follows its prompt, and nothing reaches past the Worker ceiling,
 * the requester's authority now or the goal's budget. Shown on the confirmation card and with the
 * step after it, so what is confirmed is what the step was admitted with.
 */
export function WorkerSpecFields({ spec, http, gateNames, t }: WorkerSpecFieldsProps) {
  const none = <span className="text-3">{t('无', 'None')}</span>;
  const gateChips = (ids: readonly string[], testId: string) =>
    ids.length === 0 ? (
      none
    ) : (
      <span className="row-wrap">
        {ids.map((id) => (
          <RefChip
            key={id}
            kind="gatekeeper"
            id={id}
            {...(gateNames.has(id) ? { name: gateNames.get(id) } : { http })}
            size="s"
            testId={testId}
          />
        ))}
      </span>
    );
  const value = (field: keyof WorkerSpec) => {
    switch (field) {
      case 'instructions':
        return (
          <span className="pre-wrap wrap-anywhere" data-testid="goal-step-spec-instructions">
            {spec.instructions}
          </span>
        );
      case 'skills':
        return (spec.skills ?? []).length === 0 ? (
          none
        ) : (
          <span data-testid="goal-step-spec-skills">
            {(spec.skills ?? []).map(skillRefShown).join(t('、', ', '))}
          </span>
        );
      case 'gates':
        return gateChips(spec.gates ?? [], 'goal-step-spec-gate');
      case 'capabilities':
        return (spec.capabilities ?? []).length === 0 ? (
          none
        ) : (
          <span data-testid="goal-step-spec-capabilities">
            {(spec.capabilities ?? []).map((name) => actionLabel(name, t)).join(t('、', ', '))}
          </span>
        );
      case 'model':
        return (
          <span className="mono" data-testid="goal-step-spec-model">
            {spec.model}
          </span>
        );
      case 'observeScope':
        return (spec.observeScope ?? []).length === 0 ? (
          <span className="text-3">{t('不读取任何门', 'Reads through no gatekeeper')}</span>
        ) : (
          gateChips(spec.observeScope ?? [], 'goal-step-spec-observe-gate')
        );
      case 'tokenBudget':
        return (
          <span className="tabular" data-testid="goal-step-spec-token-budget">
            {(spec.tokenBudget ?? 0).toLocaleString()}
          </span>
        );
    }
  };
  return (
    <div className="stack-s" data-testid="goal-step-spec">
      <span className="text-small">{workerSpecSummary(spec, t)}</span>
      <KeyValue
        items={workerSpecFields(spec).map((field) => ({
          key: field,
          label: workerSpecFieldLabel(field, t),
          value: value(field),
        }))}
        testId="goal-step-spec-fields"
      />
      <span className="text-3 text-small">
        {t(
          'Skill、门、能力范围和模型替换 Worker 原有的设定，职责说明加在它原有的系统提示之后，观察范围限定这一步的任务能读取哪些门。这一步能做的不会超出 Worker 能有的上限和请求人现在的权限，Token 上限也不会超出目标剩下的预算。',
          'Skills, gates, capabilities and the model replace the Worker’s own; the responsibility is added after its system prompt; the observation scope is the gatekeepers this step’s task may read through. What the step may do never goes past what a Worker may hold and what the requester holds now, and its token cap never past what is left of the goal’s budget.',
        )}
      </span>
    </div>
  );
}
