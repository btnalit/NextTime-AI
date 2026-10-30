import type { UnresolvedGoalActionWire } from '@nexttime/shared';
import type { ReactNode } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { actionKindTagText, formatDateTime, formatRelative } from '../../lib/format.js';
import { unresolvedActionText, unresolvedCheckErrorText } from '../../lib/goals.js';
import { useT } from '../../lib/i18n.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { RefChip } from '../kit/ref-chip.js';
import { DashboardCard } from '../kit/section.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { ActionChip } from './ActionChip.js';

export interface GoalUnresolvedSectionProps {
  readonly state:
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly error: unknown }
    | { readonly status: 'ready'; readonly items: readonly UnresolvedGoalActionWire[] };
  /** The goal is paused or held: a pending platform check waits for it to go on (GO3d). */
  readonly paused: boolean;
  readonly http: CapabilityCaller;
  readonly onRetry: () => void;
  /** What the reader may do about one action (`GoalReconcileControls`). */
  readonly controls?: (action: UnresolvedGoalActionWire) => ReactNode;
}

/**
 * components/goals/GoalUnresolvedSection (S11 GO6): 待核对的动作 — the goal's actions whose outcome
 * is unknown and that still need a person (`list_goal_unresolved_actions`): what each needs (a
 * finding, or — found not to have taken effect — a decision) and where the platform's own check
 * of it stands, or why there is none, and — through `controls` — what the reader may do about it.
 * Rendered only while there is something to show.
 */
export function GoalUnresolvedSection({
  state,
  paused,
  http,
  onRetry,
  controls,
}: GoalUnresolvedSectionProps) {
  const t = useT();
  if (state.status === 'ready' && state.items.length === 0) return null;
  return (
    <DashboardCard title={t('待核对的动作', 'Actions to check')} data-testid="goal-unresolved">
      {state.status === 'loading' ? (
        <SkeletonRows count={2} label={t('正在读取待核对的动作', 'Loading actions to check')} />
      ) : state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取待核对的动作', 'Could not read the actions to check')}
          onRetry={onRetry}
          testId="goal-unresolved-error"
        />
      ) : (
        <ul className="stack">
          {state.items.map((action) => {
            const text = unresolvedActionText(action, paused, t);
            const lastError = unresolvedCheckErrorText(action, t);
            return (
              <li
                key={action.actionRequestId}
                className="stack-s"
                data-testid="goal-unresolved-action"
                data-needs={action.needs}
              >
                <span className="row-wrap">
                  <ActionChip
                    actionRequestId={action.actionRequestId}
                    name={actionKindTagText(action.actionKindTag)}
                    http={http}
                  />
                  <RefChip kind="gatekeeper" id={action.gatekeeperId} http={http} size="s" />
                  <span className="text-3 text-small">
                    {t('步骤', 'Step')} <span className="mono">{action.stepKey}</span>
                  </span>
                  {action.failedAt ? (
                    <time className="text-3 text-small" title={formatDateTime(action.failedAt)}>
                      {formatRelative(action.failedAt)}
                    </time>
                  ) : null}
                </span>
                <span className={action.needs === 'finding' ? 'text-warn' : 'text-danger'}>
                  {text.needs}
                </span>
                <span className="text-small text-3" data-testid="goal-unresolved-check">
                  {text.check}
                </span>
                {lastError ? <span className="text-small text-3">{lastError}</span> : null}
                {controls?.(action)}
              </li>
            );
          })}
        </ul>
      )}
    </DashboardCard>
  );
}
