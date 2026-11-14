import { auditUnchanged } from '../../lib/audit.js';
import { useT } from '../../lib/i18n.js';

/**
 * components/audit/AuditUnchangedChip (legacy 731): 「未改变」 right after an audit row's action
 * when the call went through but changed nothing (`payload.unchanged: true`, `lib/audit`
 * `auditUnchanged`) — a role set to the role it already had, a membership removed again, a member
 * disabled again. Without it the row reads exactly like the call that made the change. Renders
 * nothing for any other row, and never beside 「被拦下」 (a refused row is not unchanged).
 */
export function AuditUnchangedChip({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>> | null | undefined;
}) {
  const t = useT();
  if (!auditUnchanged(payload)) return null;
  return (
    <span
      className="chip chip-s chip-neutral"
      data-testid="audit-unchanged"
      title={t(
        '这次调用成功了，但目标本来就是要求的样子：什么也没有写，也没有撤销什么。',
        'This call went through, but the target already was what it asked for: nothing was written or revoked.',
      )}
    >
      {t('未改变', 'No change')}
    </span>
  );
}
