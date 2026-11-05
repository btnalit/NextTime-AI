import { useT } from '../../lib/i18n.js';

/** Legacy 583: an audit row the person's 管理员智能体 wrote in their name — the kernel records the
 *  acting session beside the row's payload (`sessionKind: 'admin_agent'`, `sessionId`). */
export function actedByAdminAgent(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Readonly<Record<string, unknown>>).sessionKind === 'admin_agent'
  );
}

/**
 * components/audit/AdminAgentActingChip (S11 AA4c-3, legacy 583; the AA4 plan F10-3): 「由管理员
 * 智能体代为」 beside an audit row's actor when that person's admin agent did it — the actor is
 * still the person (the agent acts as them, within its own ceiling), so the row says both.
 * Renders nothing for any other row.
 */
export function AdminAgentActingChip({ payload }: { readonly payload: unknown }) {
  if (!actedByAdminAgent(payload)) return null;
  return <AdminAgentActingMark testId="audit-admin-agent" />;
}

/** The same mark wherever a resource records the admin agent session that made it in the
 *  person's name (S11 AA5b: a connection request's or a Task's `adminAgentSessionId`). */
export function AdminAgentActingMark({ testId }: { readonly testId: string }) {
  const t = useT();
  return (
    <span
      className="chip chip-s chip-warn"
      data-testid={testId}
      title={t(
        '这一条是这位平台管理员的管理员智能体以本人名义做的',
        'This was done by this platform administrator’s admin agent, in their name',
      )}
    >
      {t('由管理员智能体代为', 'By their admin agent')}
    </span>
  );
}
