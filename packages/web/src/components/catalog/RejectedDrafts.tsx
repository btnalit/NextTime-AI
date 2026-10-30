import type { ListDraftRejectionsResultWire, RejectableDraftKind } from '@nexttime/shared';
import { useEffect, useRef } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { RedactedNote } from '../kit/redacted-note.js';
import { RefChip } from '../kit/ref-chip.js';

/**
 * components/catalog/RejectedDrafts (legacy 491): 「被拒绝的草稿」 under the Skills / Procedures
 * list — the caller's own drafts a reviewer rejected (`reject_draft` deletes the draft), from
 * `list_draft_rejections`: which (name and version), who rejected it, when, and the reason. A draft
 * the caller's Worker proposed is the caller's here too (its Handle acted for them). Nothing shows
 * while it loads, when there is none, or on a 403; `reloadKey` changing reads it again (the list's
 * own refresh).
 */
export function RejectedDrafts({
  http,
  kind,
  reloadKey,
}: {
  readonly http: CapabilityCaller;
  readonly kind: RejectableDraftKind;
  readonly reloadKey: number;
}) {
  const t = useT();
  const can = useRoleCan(http);
  // A human member and up (the read is held until the role is known).
  const allowed = can('list_draft_rejections') === true;
  const rejections = useCapability<ListDraftRejectionsResultWire>(
    http,
    'list_draft_rejections',
    { kind },
    { enabled: allowed },
  );
  const { reload } = rejections;
  const state = rejections.state;
  const testId = `${kind}-rejected-drafts`;

  useReloadOnChange(reloadKey, reload);

  if (!allowed || state.status === 'loading') return null;
  if (state.status === 'error') {
    if (isForbiddenError(state.error)) return null;
    return (
      <ErrorBanner
        error={state.error}
        title={t('无法读取被拒绝的草稿', 'Could not read your rejected drafts')}
        onRetry={() => void reload()}
        testId={`${testId}-error`}
      />
    );
  }
  const items = state.data.items;
  if (items.length === 0) return null;

  return (
    <section className="stack-s" data-testid={testId} aria-labelledby={`${testId}-title`}>
      <span className="section-title" id={`${testId}-title`}>
        {t('被拒绝的草稿', 'Rejected drafts')}
      </span>
      <p className="text-3 text-small">
        {kind === 'skill'
          ? t(
              '你提议的 Skill 草稿（也包括你的 Worker 代你提议的）被审核人拒绝后列在这里，草稿本身已删除；改好后可以重新提议。',
              'Skill drafts you proposed (including those your Workers proposed for you) that a reviewer rejected. The draft itself is gone; propose it again once it is fixed.',
            )
          : t(
              '你提议的流程草稿（也包括你的 Worker 代你提议的）被审核人拒绝后列在这里，草稿本身已删除；改好后可以重新提议。',
              'Procedure drafts you proposed (including those your Workers proposed for you) that a reviewer rejected. The draft itself is gone; propose it again once it is fixed.',
            )}
      </p>
      <ul className="rejected-drafts">
        {items.map((item) => (
          <li key={`${item.id}@${item.version}:${item.rejectedAt}`} data-testid={`${testId}-item`}>
            <span className="row-wrap" style={{ minWidth: 0 }}>
              <span className="wrap-anywhere" data-testid={`${testId}-name`}>
                {item.name ?? t('（拒绝时未记下名字）', '(name not recorded)')}
              </span>
              <span className="text-3">v{item.version}</span>
            </span>
            <span className="rejected-drafts-meta text-3 text-small">
              <span>{t('拒绝人', 'Rejected by')}</span>
              <RefChip kind="principal" id={item.rejectedBy} http={http} size="s" />
              <span>·</span>
              <time dateTime={item.rejectedAt} title={formatDateTime(item.rejectedAt)}>
                {formatRelative(item.rejectedAt)}
              </time>
            </span>
            <span className="wrap-anywhere" data-testid={`${testId}-reason`}>
              {t('原因：', 'Reason: ')}
              {item.reason}
            </span>
            <RedactedNote value={item.reason} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Reads again each time `key` changes after the first render. */
function useReloadOnChange(key: number, reload: () => Promise<void> | void): void {
  const seen = useRef(key);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    void reloadRef.current();
  }, [key]);
}
