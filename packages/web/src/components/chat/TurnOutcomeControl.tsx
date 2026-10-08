import type { ObjectiveOutcome, TurnAttributionWire } from '@nexttime/shared';
import { useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { StatusChip } from '../kit/status-chip.js';

export interface TurnOutcomeControlProps {
  readonly http: CapabilityCaller;
  readonly turn: TurnAttributionWire;
  /** The viewer's own principal id (`useWorkspaceIdentity`) — only the Turn's requester may judge
   *  it (`mark_turn_outcome` refuses anyone else with a 403), so nobody else sees the buttons. */
  readonly viewerId: string | null;
  readonly onChanged: (turn: TurnAttributionWire) => void;
  readonly onError: (title: string, description: string) => void;
}

const OTHER: Record<ObjectiveOutcome, ObjectiveOutcome> = {
  achieved: 'not_achieved',
  not_achieved: 'achieved',
};

/**
 * components/chat/TurnOutcomeControl (S10 E1 结果归因, docs/s10-evolution-plan-2026-10-04.md
 * §3.1): the line under a finished Turn's last reply —
 *
 * - the Procedure the entry agent *said* it followed, labelled "agent 自报" (a claim, not something
 *   the kernel observed — `ProcedureClaimWire.basis`);
 * - the requester's own objective outcome: two buttons while there is none, the chip once given,
 *   one correction (a `medium` confirm — the second answer is final), then "已更正（原：…）".
 *
 * Renders nothing for a Turn with neither a claim nor anything the viewer can do.
 */
export function TurnOutcomeControl({
  http,
  turn,
  viewerId,
  onChanged,
  onError,
}: TurnOutcomeControlProps) {
  const t = useT();
  const permissions = usePermissions();
  const [busy, setBusy] = useState<ObjectiveOutcome | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const isRequester =
    viewerId !== null && turn.startedBy === viewerId && !permissions.isDenied('mark_turn_outcome');
  const outcome = turn.outcome;

  if (turn.status === 'running') return null;
  if (turn.procedure === null && outcome === null && !isRequester) return null;

  async function mark(next: ObjectiveOutcome): Promise<void> {
    const updated = (await http.call('mark_turn_outcome', {
      turnId: turn.id,
      outcome: next,
    })) as TurnAttributionWire;
    onChanged(updated);
  }

  async function markFromButton(next: ObjectiveOutcome): Promise<void> {
    setBusy(next);
    try {
      await mark(next);
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('mark_turn_outcome');
      onError(t('无法记录目标结果', 'Could not record the outcome'), describeError(err).message);
    } finally {
      setBusy(null);
    }
  }

  const outcomeLabel = (value: ObjectiveOutcome) =>
    value === 'achieved' ? t('达成', 'Achieved') : t('未达成', 'Not achieved');

  return (
    <div
      className="turn-outcome"
      data-testid="turn-outcome"
      data-turn-id={turn.id}
      data-outcome={outcome?.outcome ?? 'unknown'}
    >
      {turn.procedure !== null ? (
        <span className="turn-outcome-procedure" data-testid="turn-outcome-procedure">
          <span>{t('按流程', 'Procedure')}</span>
          <span className="turn-outcome-name">
            {turn.procedure.name} v{turn.procedure.version}
          </span>
          <span
            className="turn-outcome-basis"
            title={t(
              '入口 agent 自己报告的，内核没有核验它是否真的照做',
              'Reported by the entry agent itself; the kernel did not verify it was followed',
            )}
          >
            {t('agent 自报', 'agent-reported')}
          </span>
        </span>
      ) : null}

      {outcome === null ? (
        isRequester ? (
          <span className="turn-outcome-ask">
            <span>{t('这一轮达成目标了吗？', 'Did this turn achieve its goal?')}</span>
            {(['achieved', 'not_achieved'] as const).map((value) => (
              <Button
                key={value}
                variant="ghost"
                size="s"
                disabled={busy !== null}
                aria-busy={busy === value}
                onClick={() => void markFromButton(value)}
                data-testid={`turn-outcome-${value}`}
              >
                {outcomeLabel(value)}
              </Button>
            ))}
          </span>
        ) : null
      ) : (
        <span className="turn-outcome-given">
          <StatusChip
            machine="objectiveOutcome"
            status={outcome.outcome}
            size="s"
            testId="turn-outcome-chip"
          />
          <span className="turn-outcome-meta">
            {outcome.givenBy === viewerId ? t('你', 'You') : t('请求人', 'Requester')} ·{' '}
            <time title={formatDateTime(outcome.givenAt)}>{formatRelative(outcome.givenAt)}</time>
            {outcome.revision === 2 && outcome.previousOutcome !== null
              ? ` · ${t('已更正，原为', 'corrected from')} ${outcomeLabel(outcome.previousOutcome)}`
              : null}
          </span>
          {isRequester && outcome.revision === 1 ? (
            <Confirm
              tier="medium"
              open={correcting}
              onOpenChange={setCorrecting}
              anchor={
                <Button
                  variant="ghost"
                  size="s"
                  onClick={() => setCorrecting(true)}
                  data-testid="turn-outcome-correct"
                >
                  {t('更正', 'Correct')}
                </Button>
              }
              title={t(
                `更正为“${outcomeLabel(OTHER[outcome.outcome])}”`,
                `Correct to “${outcomeLabel(OTHER[outcome.outcome])}”`,
              )}
              description={t(
                '每一轮只能更正一次，更正后不能再改。原来的判断会保留在记录里。',
                'A turn can be corrected once; after that the answer is final. The original answer stays on record.',
              )}
              confirmLabel={t('更正', 'Correct')}
              onConfirm={async () => {
                try {
                  await mark(OTHER[outcome.outcome]);
                } catch (err) {
                  if (isForbiddenError(err)) permissions.markDenied('mark_turn_outcome');
                  throw err;
                }
              }}
              testId="turn-outcome-correct-confirm"
            />
          ) : null}
        </span>
      )}
    </div>
  );
}
