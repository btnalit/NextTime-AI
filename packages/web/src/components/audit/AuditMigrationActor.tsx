import type { ReactNode } from 'react';
import { auditMigrationSource } from '../../lib/audit.js';
import { useT } from '../../lib/i18n.js';

/**
 * components/audit/AuditMigrationActor (legacy 740): an audit row's actor. A row a migration wrote
 * while the platform was upgraded (`lib/audit` `auditMigrationSource`) shows 「升级时写入」 and the
 * migration's name instead of `children` (the member the migration recorded as the actor, and
 * what it came through) — the row is not something that member did. When the row is about
 * something else (a policy), that member follows as 「记在 …」, so whose rule it was stays on the
 * row. Any other row shows `children`.
 */
export function AuditMigrationActor({
  payload,
  recordedUnder,
  children,
}: {
  readonly payload: Readonly<Record<string, unknown>> | null | undefined;
  /** The member the migration recorded the row under, when the row is not about that member
   *  (governance 0016 / 0020: the rule's writer, the row being about the policy). */
  readonly recordedUnder?: ReactNode;
  readonly children: ReactNode;
}) {
  const t = useT();
  const source = auditMigrationSource(payload);
  if (source === null) return <>{children}</>;
  return (
    <>
      <span
        className="chip chip-s chip-neutral"
        data-testid="audit-by-migration"
        title={t(
          '这一条是平台升级时由数据迁移写下的，不是哪位成员的操作。审计表要求记一个操作者，迁移就把它记在一位相关成员名下（它处理的成员，或这条规则的设置者；没有记下设置者时是工作区所有者）。',
          'A data migration wrote this row while the platform was upgraded; no member did this. The audit table needs an actor, so the migration recorded it under a related member (the one it acted on, or the rule’s writer; the workspace owner when no writer is on record).',
        )}
      >
        {t('升级时写入', 'Written by an upgrade')}
      </span>
      <span className="mono text-3 text-small" data-testid="audit-by-migration-source">
        {source}
      </span>
      {recordedUnder ? (
        <span className="text-3 text-small" data-testid="audit-by-migration-recorded-under">
          {t('记在', 'recorded under')} {recordedUnder}
        </span>
      ) : null}
    </>
  );
}
