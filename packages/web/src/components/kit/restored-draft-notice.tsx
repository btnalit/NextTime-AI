import { useT } from '../../lib/i18n.js';
import { Notice } from './notice.js';

/**
 * components/kit/restored-draft-notice (legacy 662): says an editor opened with what the person
 * had not submitted last time (`hooks/useFormDraft`) — after a session that expired under it, or a
 * page they left — and how to drop it, so restored content never passes for the saved version.
 */
export function RestoredDraftNotice({
  discard,
}: {
  /** The editor's own discard control, by its visible label: 取消 / 放弃修改. */
  readonly discard: 'cancel' | 'discardChanges';
}) {
  const t = useT();
  return (
    <Notice testId="restored-draft">
      {discard === 'cancel'
        ? t(
            '已恢复上次没有提交的内容，还没有保存。不需要的话，点「取消」放弃。',
            'Restored what you had not submitted last time; it is not saved yet. Not needed? Cancel drops it.',
          )
        : t(
            '已恢复上次没有提交的修改，还没有提交。不需要的话，点「放弃修改」。',
            'Restored the changes you had not submitted last time; they are not submitted yet. Not needed? Discard changes drops them.',
          )}
    </Notice>
  );
}
