import { auditRefusal } from '../../lib/audit.js';
import { callRefusalReasonText } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';

/**
 * components/audit/AuditRefusedChip (legacy 628): 「被拦下」 right after an audit row's action
 * when the call was refused (`payload.outcome: 'refused'`, `lib/audit` `auditRefusal`) — the row
 * otherwise reads exactly like the call that went through. The refusal code, when the writer
 * recorded one, follows as the text an auditor searches by. Renders nothing for any other row.
 * `detailsBelow={false}` where the row has no payload details (the recent-audit lists): the
 * tooltip then points to the platform audit page instead. The chip and the code are one group
 * (`.audit-refused`): at narrow widths it moves to the next line as a whole, and a long code
 * breaks anywhere (UX P2-1 on #964). Legacy 666: when the row names why authorization refused it
 * (`payload.refusal.reason`), that reason follows in words (`lib/errors.ts`'s one wording of
 * each), the code kept beside it.
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
  // Review of #1038 (P3-2): the admin agent's own refusal rows (`dispatch.ts`
  // `auditAdminAgentRefusal`) record `admin_agent_only` as their code, with no reason.
  const reasonText = callRefusalReasonText(refusal.reason ?? refusal.code ?? '', t);
  return (
    <span className="audit-refused">
      <span
        className="chip chip-s chip-danger"
        data-testid="audit-refused"
        title={
          detailsBelow
            ? t(
                '这次调用被拦下了，没有生效；原因在下面的「负载」里。',
                'This call was refused and took no effect; the reason is in “Payload” below.',
              )
            : t(
                '这次调用被拦下了，没有生效；原因在「查看全部」里这一条的详情中。',
                'This call was refused and took no effect; the reason is in this row’s details under “View all”.',
              )
        }
      >
        {t('被拦下', 'Refused')}
      </span>
      {reasonText !== null ? (
        <span className="text-small audit-refused-reason" data-testid="audit-refused-reason">
          {reasonText}
        </span>
      ) : refusal.reason !== null ? (
        <span
          className="mono text-3 text-small audit-refused-code"
          data-testid="audit-refused-reason"
        >
          {refusal.reason}
        </span>
      ) : null}
      {refusal.code !== null ? (
        <span
          className="mono text-3 text-small audit-refused-code"
          data-testid="audit-refused-code"
        >
          {refusal.code}
        </span>
      ) : null}
    </span>
  );
}
