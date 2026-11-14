import type { ReactNode } from 'react';
import { auditMigrationSource } from '../../lib/audit.js';
import { useT } from '../../lib/i18n.js';

/**
 * components/audit/AuditMigrationActor (legacy 740): an audit row's actor. A row a migration wrote
 * while the platform was upgraded (`lib/audit` `auditMigrationSource`) shows 「升级时写入」 and the
 * migration's name instead of `children` (the member the migration recorded as the actor, and
 * what it came through) — the row is not something that member did. Any other row shows
 * `children`.
 */
export function AuditMigrationActor({
  payload,
  children,
}: {
  readonly payload: Readonly<Record<string, unknown>> | null | undefined;
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
          '这一条是平台升级时由数据迁移写下的，不是哪位成员的操作。审计表要求记一个操作者，迁移就记了它处理的那个成员。',
          'A data migration wrote this row while the platform was upgraded; no member did this. The audit table needs an actor, so the migration recorded the member it acted on.',
        )}
      >
        {t('升级时写入', 'Written by an upgrade')}
      </span>
      <span className="mono text-3 text-small" data-testid="audit-by-migration-source">
        {source}
      </span>
    </>
  );
}
