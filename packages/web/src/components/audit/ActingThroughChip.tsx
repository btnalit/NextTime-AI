import { actingThroughLabel } from '../../lib/acting-through.js';
import { useT } from '../../lib/i18n.js';
import { AdminAgentActingMark, actedByAdminAgent } from './AdminAgentActingChip.js';

/**
 * components/audit/ActingThroughChip (legacy 666): 「经由 …」 beside an audit row's actor — what the
 * act came through (`actingThrough`, `lib/acting-through.ts`), on every row of both audit pages.
 * The person's admin agent keeps its own warning mark (legacy 583, `AdminAgentActingMark`)
 * whenever either says so: the recorded value, or the payload (`sessionKind`) that is all a row
 * from before #1028 has — the mark this page showed before legacy 666 never goes away.
 */
export function ActingThroughChip({
  actingThrough,
  payload,
}: {
  readonly actingThrough: string | null | undefined;
  readonly payload: unknown;
}) {
  const t = useT();
  if (actingThrough === 'admin_agent_session' || actedByAdminAgent(payload)) {
    return <AdminAgentActingMark testId="audit-admin-agent" />;
  }
  const recorded = actingThrough !== null && actingThrough !== undefined;
  return (
    <span
      className="chip chip-s chip-neutral"
      data-testid="audit-acting-through"
      data-acting-through={recorded ? actingThrough : 'unrecorded'}
      title={
        recorded
          ? undefined
          : t(
              '这一条早于平台开始记录「经由」，或者不是在一次调用里写下的。',
              'This row is older than the platform’s record of what an act came through, or was written outside a call.',
            )
      }
    >
      {t('经由', 'Through')} {actingThroughLabel(actingThrough, t)}
    </span>
  );
}
