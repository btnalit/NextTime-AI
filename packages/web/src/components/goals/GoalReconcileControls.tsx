import type {
  GoalDetailWire,
  ReconcileGoalActionResultWire,
  UnresolvedGoalActionWire,
} from '@nexttime/shared';
import { useId, useState } from 'react';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { type GoalViewer, reconcileOptions } from '../../lib/goal-actions.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import {
  type GoalOperationOutcome,
  goalOperationErrors,
  useNote,
  useOperationDone,
} from './GoalOperationsBar.js';

export interface GoalReconcileControlsProps {
  readonly goal: GoalDetailWire;
  readonly action: UnresolvedGoalActionWire;
  readonly viewer: GoalViewer;
  readonly http: CapabilityCaller;
  /** After the finding or decision is recorded (or refused as stale): for the page to say and
   *  re-read. */
  readonly onDone: (outcome: GoalOperationOutcome) => void;
}

type Verdict = 'effect_seen' | 'effect_absent';

/**
 * components/goals/GoalReconcileControls (S11 GO6, operations): what a person does about one action
 * of the goal whose outcome is unknown (`reconcile_goal_action`): record what they found in the
 * target system — it took effect, or it did not — and, for the requester, run it again (a new
 * request, approved like any other). Either way the goal stays paused until its requester resumes
 * it. Each is recorded once.
 */
export function GoalReconcileControls({
  goal,
  action,
  viewer,
  http,
  onDone,
}: GoalReconcileControlsProps) {
  const can = useRoleCan(http);
  const options = reconcileOptions(goal, action, viewer);
  const [open, setOpen] = useState<'record' | 'reexecute' | null>(null);
  if (can('reconcile_goal_action') === false) return null;
  if (!options.record && !(options.reexecute && action.needs === 'decision')) return null;
  return (
    <span className="row-wrap" data-testid="goal-reconcile">
      {options.record ? (
        <RecordFinding
          open={open === 'record'}
          onOpenChange={(next) => setOpen(next ? 'record' : null)}
          canReexecute={options.reexecute}
          {...{ goal, action, http, onDone }}
        />
      ) : null}
      {options.reexecute && action.needs === 'decision' ? (
        <Reexecute
          open={open === 'reexecute'}
          onOpenChange={(next) => setOpen(next ? 'reexecute' : null)}
          {...{ goal, action, http, onDone }}
        />
      ) : null}
    </span>
  );
}

interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly goal: GoalDetailWire;
  readonly action: UnresolvedGoalActionWire;
  readonly http: CapabilityCaller;
  readonly onDone: (outcome: GoalOperationOutcome) => void;
}

function reconcile(
  props: DialogProps,
  params: { verdict?: Verdict; reexecute?: true; note?: string },
): Promise<ReconcileGoalActionResultWire> {
  return props.http.call<ReconcileGoalActionResultWire>('reconcile_goal_action', {
    goalRunId: props.goal.id,
    actionRequestId: props.action.actionRequestId,
    ...params,
  });
}

function RecordFinding(props: DialogProps & { readonly canReexecute: boolean }) {
  const t = useT();
  const run = useOperationDone(props.onDone);
  const name = useId();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [reexecute, setReexecute] = useState(false);
  const note = useNote();
  const withReexecute = props.canReexecute && verdict === 'effect_absent' && reexecute;
  return (
    <Confirm
      tier="medium"
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={
        <Button
          variant="secondary"
          size="s"
          onClick={() => props.onOpenChange(true)}
          data-testid="goal-reconcile-record"
        >
          {t('记录核对结果…', 'Record what you found…')}
        </Button>
      }
      title={t('记录核对结果', 'Record what you found')}
      description={t(
        '去目标系统里看过之后，记下这个动作有没有生效。只能记一次；目标仍然暂停，要请求人继续后才会推进。',
        'Having looked in the target system, record whether this action took effect. It is recorded once; the goal stays paused until its requester resumes it.',
      )}
      confirmLabel={t('记录', 'Record')}
      confirmDisabled={verdict === null || note.tooLong}
      errorOverrides={goalOperationErrors(t)}
      testId="goal-reconcile-record-confirm"
      onConfirm={async () => {
        if (verdict === null) return;
        await run(
          reconcile(props, {
            verdict,
            ...(withReexecute ? { reexecute: true } : {}),
            ...note.params,
          }),
          () =>
            withReexecute
              ? t('已记录：没有生效，并重新执行', 'Recorded: no effect, and run again')
              : verdict === 'effect_seen'
                ? t('已记录：已生效', 'Recorded: took effect')
                : t('已记录：没有生效', 'Recorded: no effect'),
        );
      }}
    >
      <fieldset className="stack-s" data-testid="goal-reconcile-verdict">
        <legend className="text-small">{t('核对结果', 'What you found')}</legend>
        <label className="row-wrap text-small">
          <input
            type="radio"
            name={name}
            checked={verdict === 'effect_seen'}
            onChange={() => setVerdict('effect_seen')}
          />
          {t('已生效：按已执行算', 'It took effect: counts as executed')}
        </label>
        <label className="row-wrap text-small">
          <input
            type="radio"
            name={name}
            checked={verdict === 'effect_absent'}
            onChange={() => setVerdict('effect_absent')}
          />
          {t('没有生效', 'It had no effect')}
        </label>
        {props.canReexecute && verdict === 'effect_absent' ? (
          <label className="row-wrap text-small">
            <input
              type="checkbox"
              checked={reexecute}
              onChange={(event) => setReexecute(event.target.checked)}
              data-testid="goal-reconcile-reexecute"
            />
            {t(
              '同时重新执行这个动作（新的请求照常审批）',
              'Also run it again (the new request is approved like any other)',
            )}
          </label>
        ) : null}
      </fieldset>
      {note.field}
    </Confirm>
  );
}

function Reexecute(props: DialogProps) {
  const t = useT();
  const run = useOperationDone(props.onDone);
  const note = useNote();
  return (
    <Confirm
      tier="medium"
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={
        <Button
          variant="secondary"
          size="s"
          onClick={() => props.onOpenChange(true)}
          data-testid="goal-reconcile-reexecute-open"
        >
          {t('重新执行…', 'Run again…')}
        </Button>
      }
      title={t('重新执行这个动作', 'Run this action again')}
      impact={[
        t(
          '发起一个新的动作请求，照常审批',
          'A new request for the action is made, approved like any other',
        ),
        t(
          '目标仍然暂停，你继续之后才会推进',
          'The goal stays paused and moves on once you resume it',
        ),
      ]}
      confirmLabel={t('重新执行', 'Run again')}
      confirmDisabled={note.tooLong}
      errorOverrides={goalOperationErrors(t)}
      testId="goal-reconcile-reexecute-confirm"
      onConfirm={() =>
        run(reconcile(props, { reexecute: true, ...note.params }), () =>
          t('已决定重新执行', 'Decided to run it again'),
        )
      }
    >
      {note.field}
    </Confirm>
  );
}
