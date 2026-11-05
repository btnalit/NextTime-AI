import { auditRefusal } from '../../lib/audit.js';
import { useT } from '../../lib/i18n.js';

/**
 * components/audit/AuditRefusedChip (legacy 628): 「被拦下」 right after an audit row's action
 * when the call was refused (`payload.outcome: 'refused'`, `lib/audit` `auditRefusal`) — the row
 * otherwise reads exactly like the call that went through. The refusal code, when the writer
 * recorded one, follows as the text an auditor searches by. Renders nothing for any other row.
 * `detailsBelow={false}` where the row has no payload details (the recent-audit lists): the
 * tooltip then points to the platform audit page instead.
 */
export function AuditRefusedChip({
  payload,
  detailsBelow = true,
}: {
  readonly payload: Readonly<Record<string, unknown>> | null | undefined;
  readonly detailsBelow?: boolean;
}) {
  const t = useT();
  const refusal = auditRefusal(payload);
  if (refusal === null) return null;
  return (
    <>
      <span
        className="chip chip-s chip-danger"
        data-testid="audit-refused"
        title={
          detailsBelow
            ? t(
                '这次调用被拦下了，没有生效；原因在下面的详情里。',
                'This call was refused and took no effect; the reason is in the details below.',
              )
            : t(
                '这次调用被拦下了，没有生效；原因在「查看全部」里这一条的详情中。',
                'This call was refused and took no effect; the reason is in this row’s details under “View all”.',
              )
        }
      >
        {t('被拦下', 'Refused')}
      </span>
      {refusal.code !== null ? (
        <span className="mono text-3 text-small" data-testid="audit-refused-code">
          {refusal.code}
        </span>
      ) : null}
    </>
  );
}
