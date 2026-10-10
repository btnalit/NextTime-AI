import type { DefinitionMismatchWire } from '@nexttime/shared';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';

/**
 * components/connect/DefinitionDrift (legacy K, UX acceptance of #538): what a workspace reads when
 * a platform gate refuses calls because it runs another definition than the published one — and
 * whose step ends it. Both halves come from the kernel's one derivation
 * (`application/gates/definition-drift.ts`): the system card's `definitionMismatch` and the align
 * preview's `awaitingPlatformAdoption`, so the drawer, the align button and the card never
 * disagree.
 *
 * Until the platform adopts the gate's new manifest, aligning here cannot help (it reads the
 * manifest in effect, which still holds the old definition), so that case names the platform admin
 * first: a platform admin gets the link to the gate instance, anyone else is told who to ask.
 */

function joined(names: readonly string[], zh: boolean): string {
  return names.join(zh ? '、' : ', ');
}

export function AwaitingAdoptionNotice({
  operations,
  announcedAt,
  platformAdmin,
  platformGateId,
  enabling = false,
  testId,
}: {
  readonly operations: readonly string[];
  /** Said in front of `enable_gate_instance` rather than an align: enabling now imports the
   *  definitions the gate no longer runs. */
  readonly enabling?: boolean;
  /** When the gate announced the manifest that waits — omitted where it is not known. */
  readonly announcedAt?: string;
  readonly platformAdmin: boolean;
  readonly platformGateId?: string;
  readonly testId?: string;
}) {
  const t = useT();
  const when =
    announcedAt !== undefined
      ? t(`（${formatRelative(announcedAt)}）`, ` (${formatDateTime(announcedAt)})`)
      : '';
  return (
    <Notice tone="warn" testId={testId}>
      <span className="stack-s">
        <span>
          {enabling
            ? t(
                `门公布了新清单${when}，平台管理员还没采用。现在启用的话，采用之前对 ${joined(operations, true)} 的调用会被拒绝。`,
                `The gate announced a new manifest${when} that a platform admin has not adopted yet. If you enable it now, calls to ${joined(operations, false)} are refused until it is adopted.`,
              )
            : t(
                `门公布了新清单${when}，平台管理员还没采用。采用之前这里对齐不了，对 ${joined(operations, true)} 的调用会被拒绝。`,
                `The gate announced a new manifest${when} that a platform admin has not adopted yet. Until it is adopted nothing can be aligned here, and calls to ${joined(operations, false)} are refused.`,
              )}
        </span>
        {platformAdmin && platformGateId !== undefined ? (
          <a
            href={hrefs.platformGateInstance(platformGateId)}
            data-testid={testId ? `${testId}-adopt-link` : undefined}
          >
            {t('去集成采用', 'Adopt it under Integrations')}
          </a>
        ) : (
          <span className="text-3">
            {t(
              '请平台管理员在「集成」里采用门的新清单。',
              "Ask a platform admin to adopt the gate's new manifest under Integrations.",
            )}
          </span>
        )}
      </span>
    </Notice>
  );
}

/** The system drawer's account of every refused Operation on this gate, grouped by whose step
 *  ends it. Renders nothing when nothing is refused. */
export function DefinitionMismatchNotice({
  mismatch,
  platformAdmin,
  platformGateId,
  canManage,
  testId,
}: {
  readonly mismatch: readonly DefinitionMismatchWire[];
  readonly platformAdmin: boolean;
  readonly platformGateId?: string;
  /** May align and publish here (a workspace owner). */
  readonly canManage: boolean;
  readonly testId?: string;
}) {
  const t = useT();
  const adoption = mismatch
    .filter((entry) => entry.awaiting === 'platform_adoption')
    .map((entry) => entry.operation);
  const revision = mismatch
    .filter((entry) => entry.awaiting === 'workspace_revision')
    .map((entry) => entry.operation);
  if (adoption.length === 0 && revision.length === 0) return null;
  return (
    <div className="stack-s" data-testid={testId}>
      {adoption.length > 0 ? (
        <AwaitingAdoptionNotice
          operations={adoption}
          platformAdmin={platformAdmin}
          platformGateId={platformGateId}
          testId={testId ? `${testId}-adoption` : undefined}
        />
      ) : null}
      {revision.length > 0 ? (
        <Notice tone="warn" testId={testId ? `${testId}-revision` : undefined}>
          {t(
            `门已经按新定义运行，对 ${joined(revision, true)} 的调用会被拒绝，直到这个工作区对齐并发布修订。`,
            `The gate already runs a new definition, so calls to ${joined(revision, false)} are refused until this workspace aligns and publishes the revision.`,
          )}{' '}
          {canManage
            ? t(
                '点下面的「与门公告对齐」打开修订，再到能力目录发布。',
                'Use “Align with the gate’s announcement” below to open the revision, then publish it in the catalog.',
              )
            : t(
                '请工作区所有者对齐并发布修订。',
                'Ask a workspace owner to align and publish the revision.',
              )}
        </Notice>
      ) : null}
    </div>
  );
}
