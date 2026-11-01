import type { CapabilityCaller } from '../../lib/clients.js';
import type { Translate } from '../../lib/i18n.js';
import { type StepChange, stepFieldChangeText } from '../../lib/plan-step-diff.js';
import { RefChip } from '../kit/ref-chip.js';

export interface StepChangeListProps {
  /** The steps a revision kept under their key but redefined (`planStepDiff`). */
  readonly changes: readonly StepChange[];
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
  readonly testId: string;
}

/**
 * components/goals/StepChangeList (S11 GO15a; `s11-w2/go15-default-plan.md` F5): what a revision
 * changed in each step it redefined — one line per step, each change from what to what
 * (「改读 side、fetch-2 留下的文件（原来读 fetch）」, 「模型 a → b」); a Worker it swaps reads by
 * name. The planner's proposal and the plan's version timeline both list it under 改动的步骤.
 */
export function StepChangeList({ changes, http, gateNames, t, testId }: StepChangeListProps) {
  if (changes.length === 0) return null;
  return (
    <ul className="stack-s" data-testid={testId}>
      {changes.map((change) => (
        <li key={change.key} className="stack-s" data-step-key={change.key}>
          <span className="mono">{change.key}</span>
          <ul className="stack-s">
            {change.changes.map((field, index) => (
              <li
                // A step changes each field once; the index only tells two of a kind apart.
                key={`${field.kind}-${index}`}
                className="row-wrap"
                data-testid="goal-step-change"
                data-change={field.kind === 'specList' ? `spec.${field.field}` : field.kind}
              >
                {field.kind === 'worker' &&
                field.before.definitionId !== field.after.definitionId ? (
                  <>
                    <span>{t('换了 Worker：', 'Another Worker: ')}</span>
                    <RefChip
                      kind="workerDefinition"
                      id={field.before.definitionId}
                      http={http}
                      size="s"
                    />
                    <span className="text-3">v{field.before.version}</span>
                    <span>→</span>
                    <RefChip
                      kind="workerDefinition"
                      id={field.after.definitionId}
                      http={http}
                      size="s"
                    />
                    <span className="text-3">v{field.after.version}</span>
                  </>
                ) : (
                  <span>{stepFieldChangeText(field, { gateNames }, t)}</span>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
