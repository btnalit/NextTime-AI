import { actingThroughChipText } from '../../lib/acting-through.js';
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
  actingName,
  payload,
}: {
  readonly actingThrough: string | null | undefined;
  /** Legacy 666: the Worker or service account it came through (`actingName`), if any. */
  readonly actingName?: string | null;
  readonly payload: unknown;
}) {
  const t = useT();
  if (actingThrough === 'admin_agent_session' || actedByAdminAgent(payload)) {
    // Legacy 670 (UX P3-3 on #1035): worded like every other row's 「经由 …」, the filter's own
    // name for it, and still the warning mark.
    return (
      <AdminAgentActingMark
        testId="audit-admin-agent"
        text={actingThroughChipText('admin_agent_session', null, t)}
      />
    );
  }
  const recorded = actingThrough !== null && actingThrough !== undefined;
  const text = actingThroughChipText(actingThrough, actingName, t);
  // Review of #1038 (P3-3): a long Worker name ends in an ellipsis inside the row, never past
  // it; the whole of it is the chip's title.
  return (
    <span
      className="chip chip-s chip-neutral audit-acting-through"
      data-testid="audit-acting-through"
      data-acting-through={recorded ? actingThrough : 'unrecorded'}
      title={
        recorded
          ? actingName
            ? text
            : undefined
          : t(
              '这一条早于平台开始记录「经由」，或者不是在一次调用里写下的。',
              'This row is older than the platform’s record of what an act came through, or was written outside a call.',
            )
      }
    >
      <span className="audit-acting-through-text">{text}</span>
    </span>
  );
}
