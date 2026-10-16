import type { DefinitionMismatchWire } from '@nexttime/shared';
import { actionKindTagText, formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { gateOwnedParamsText } from './GateOwnedParams.js';

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
 *
 * UX acceptance of #573 P2: an entry carrying `gateOwnedParams` is neither — the definition the
 * gate runs declares params only the gate sets, so its revision can never be published and no
 * align or adoption brings the calls back. Those are said on their own, waiting on the gate's
 * maintainer, and kept out of the "align and publish" line.
 *
 * UX acceptance of #579 (legacy 297): an Operation the gate's held manifest no longer lists reads
 * `platform_adoption` too, but adopting removes it instead of bringing its calls back — the
 * kernel flags it (`droppedByGate`, the preview's `dropped`) and it is said on its own.
 */

function joined(names: readonly string[], zh: boolean): string {
  return names.join(zh ? '、' : ', ');
}

export function AwaitingAdoptionNotice({
  operations,
  dropped = [],
  announcedAt,
  platformAdmin,
  platformGateId,
  enabling = false,
  testId,
}: {
  readonly operations: readonly string[];
  /** UX acceptance of #579 (legacy 297): the subset of `operations` the gate's new manifest no
   *  longer lists. Adopting removes them rather than bringing their calls back, so they are said
   *  apart and never in the "until it is adopted" line. */
  readonly dropped?: readonly string[];
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
  const droppedSet = new Set(dropped);
  const restorable = operations.filter((name) => !droppedSet.has(name));
  const gone = operations.filter((name) => droppedSet.has(name));
  const one = gone.length === 1;
  return (
    <Notice tone="warn" testId={testId}>
      <span className="stack-s">
        <span>
          {restorable.length === 0
            ? t(
                `门公布了新清单${when}，平台管理员还没采用。`,
                `The gate announced a new manifest${when} that a platform admin has not adopted yet.`,
              )
            : enabling
              ? t(
                  `门公布了新清单${when}，平台管理员还没采用。现在启用的话，采用之前对 ${joined(restorable, true)} 的调用会被拒绝。`,
                  `The gate announced a new manifest${when} that a platform admin has not adopted yet. If you enable it now, calls to ${joined(restorable, false)} are refused until it is adopted.`,
                )
              : t(
                  `门公布了新清单${when}，平台管理员还没采用。采用之前这里对齐不了，对 ${joined(restorable, true)} 的调用会被拒绝。`,
                  `The gate announced a new manifest${when} that a platform admin has not adopted yet. Until it is adopted nothing can be aligned here, and calls to ${joined(restorable, false)} are refused.`,
                )}
          {gone.length > 0 ? (
            <>
              {t('', ' ')}
              <span data-testid={testId ? `${testId}-dropped` : undefined}>
                {t(
                  `门已经不再提供 ${joined(gone, true)}，对${one ? '它' : '它们'}的调用会被拒绝，采用和对齐都恢复不了：采用后${one ? '它' : '它们'}会从清单里移除。`,
                  `The gate no longer offers ${joined(gone, false)}, so calls to ${one ? 'it' : 'them'} are refused, and neither adopting nor aligning brings ${one ? 'it' : 'them'} back: adopting removes ${one ? 'it' : 'them'} from the manifest.`,
                )}
              </span>
            </>
          ) : null}
        </span>
        {platformAdmin && platformGateId !== undefined ? (
          <RouteLink
            href={hrefs.platformGateInstance(platformGateId)}
            testId={testId ? `${testId}-adopt-link` : undefined}
          >
            {t('去集成采用', 'Adopt it under Integrations')}
          </RouteLink>
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
  const heldByGate = mismatch.filter((entry) => (entry.gateOwnedParams?.length ?? 0) > 0);
  const recoverable = mismatch.filter((entry) => (entry.gateOwnedParams?.length ?? 0) === 0);
  const adoptionEntries = recoverable.filter((entry) => entry.awaiting === 'platform_adoption');
  const adoption = adoptionEntries.map((entry) => actionKindTagText(entry.operation));
  const dropped = adoptionEntries
    .filter((entry) => entry.droppedByGate === true)
    .map((entry) => actionKindTagText(entry.operation));
  const revision = recoverable
    .filter((entry) => entry.awaiting === 'workspace_revision')
    .map((entry) => actionKindTagText(entry.operation));
  if (adoption.length === 0 && revision.length === 0 && heldByGate.length === 0) return null;
  return (
    <div className="stack-s" data-testid={testId}>
      {heldByGate.length > 0 ? (
        <Notice tone="warn" testId={testId ? `${testId}-gate-owned` : undefined}>
          {t(
            `门已经按新定义运行，对 ${joined(
              heldByGate.map((entry) => actionKindTagText(entry.operation)),
              true,
            )} 的调用会被拒绝。新定义声明了只能由门自己设置的参数（${heldByGate
              .map(
                (entry) =>
                  `${actionKindTagText(entry.operation)}：${gateOwnedParamsText(entry.gateOwnedParams ?? [], t)}`,
              )
              .join(
                '；',
              )}），修订发布不了，对齐也恢复不了这些调用；要等门的维护者去掉这些参数、平台采用改好的清单之后才会恢复。`,
            `The gate already runs a new definition, so calls to ${joined(
              heldByGate.map((entry) => actionKindTagText(entry.operation)),
              false,
            )} are refused. The new definition declares params only the gate sets (${heldByGate
              .map(
                (entry) =>
                  `${actionKindTagText(entry.operation)}: ${gateOwnedParamsText(entry.gateOwnedParams ?? [], t)}`,
              )
              .join(
                '; ',
              )}), so its revision cannot be published and aligning does not bring the calls back; they resume only once the gate's maintainer drops those params and the platform adopts the corrected manifest.`,
          )}
        </Notice>
      ) : null}
      {adoption.length > 0 ? (
        <AwaitingAdoptionNotice
          operations={adoption}
          dropped={dropped}
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
          )}
          {t('', ' ')}
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
