import type { AbsentAnswerDraftWire, OperationAbsentAnswersWire } from '@nexttime/shared';
import { actionKindTagText } from '../../lib/format.js';
import { absentAnswersWhenText, operationKey } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';

/**
 * components/connect/AbsentAnswerDrafts (S11 「门确认不存在」 B-a): a gate's Operations that declare
 * answers meaning "does not exist" are not published by a bulk publish (`enable_gate_instance`,
 * `publish_manifest`) — goal acceptance takes such an answer as evidence that something was
 * removed, so a person publishes each in the catalog, confirming the gate's credentials can see
 * what it looks up. One wording for every place that says so: before enabling (the preview's
 * announced entries) and after it (the result's `absentAnswerDrafts`). Each name links to its draft.
 */

interface HeldEntry {
  readonly name: string;
  readonly absentAnswers: OperationAbsentAnswersWire;
}

function HeldList({
  entries,
  gatekeeperId,
  testId,
}: {
  readonly entries: readonly HeldEntry[];
  readonly gatekeeperId: string | null;
  readonly testId: string | undefined;
}) {
  const t = useT();
  return (
    <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
      {entries.map((entry) => (
        <li key={entry.name} data-testid={testId ? `${testId}-item` : undefined}>
          {gatekeeperId !== null ? (
            <RouteLink
              href={hrefs.catalog('operations', operationKey({ gatekeeperId, name: entry.name }))}
            >
              <span className="mono">{actionKindTagText(entry.name)}</span>
            </RouteLink>
          ) : (
            <span className="mono">{actionKindTagText(entry.name)}</span>
          )}
          {t('：', ': ')}
          {absentAnswersWhenText(entry.absentAnswers, t)}
          {t('表示不存在', ', it does not exist')}
        </li>
      ))}
    </ul>
  );
}

/** After a bulk publish: the drafts it left for a person. Renders nothing when there are none (an
 *  older kernel's result without the field reads the same). */
export function AbsentAnswerDraftsNotice({
  drafts,
  gatekeeperId,
  testId,
}: {
  readonly drafts: readonly AbsentAnswerDraftWire[] | undefined;
  readonly gatekeeperId: string;
  readonly testId?: string;
}) {
  const t = useT();
  if (!drafts || drafts.length === 0) return null;
  return (
    <Notice testId={testId}>
      <span className="stack-s">
        <span>
          {t(
            `${drafts.length} 个 Operation 留作草稿，等人确认后发布：它们声明了哪些回答表示要查的东西不存在，目标验收会把这种回答当作“已经删掉”的证据。`,
            `${drafts.length} operation(s) stay drafts until a person confirms them: they declare which answers mean the thing looked up does not exist, and goal acceptance takes such an answer as evidence that something was removed.`,
          )}
        </span>
        <HeldList entries={drafts} gatekeeperId={gatekeeperId} testId={testId} />
        <span className="text-3">
          {t(
            '逐个打开，确认门用的凭据看得到要查的东西，目标不会因为没权限、地址配错或别的错误给出同样的回答，勾选后发布。',
            'Open each one, confirm the gate’s credentials can see what it looks up and that the target does not give the same answer for no permission, a wrong address or any other failure, tick it and publish.',
          )}
        </span>
      </span>
    </Notice>
  );
}

/** Before enabling: the announced entries that will be imported as drafts, not published. */
export function AbsentAnswersHeldPreview({
  operations,
  testId,
}: {
  readonly operations: readonly HeldEntry[];
  readonly testId?: string;
}) {
  const t = useT();
  if (operations.length === 0) return null;
  return (
    <Notice testId={testId}>
      <span className="stack-s">
        <span>
          {t(
            `${operations.length} 个 Operation 只导入为草稿，不会发布：它们声明了哪些回答表示要查的东西不存在。启用后到能力目录逐个确认门用的凭据看得到要查的东西，再发布。`,
            `${operations.length} operation(s) will only be imported as drafts, not published: they declare which answers mean the thing looked up does not exist. After enabling, confirm each one in the catalog (the gate’s credentials can see what it looks up), then publish.`,
          )}
        </span>
        <HeldList entries={operations} gatekeeperId={null} testId={testId} />
      </span>
    </Notice>
  );
}
