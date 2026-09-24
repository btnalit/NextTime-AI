import { useEffect, useRef, useState } from 'react';
import { describeError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../ui/Button.js';
import { CopyId } from '../ui/CopyId.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { StatusChip } from '../ui/StatusChip.js';
import { useToast } from '../ui/Toast.js';

export interface ProposedDraft {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly name?: string;
}

export interface DraftProposedProps {
  readonly kindLabel: string;
  readonly draft: ProposedDraft;
  /** The `publish_*` call for this draft; `undefined` hides the button (permission denied). */
  readonly onPublish?: () => Promise<{ readonly status: string }>;
  readonly onDone: () => void;
  /** Extra caveat (e.g. "the Workers tab only lists published versions"). */
  readonly note?: string;
  /** R6 fallback: when the caller has no `list_*` capability that can ever show this draft again
   *  once this screen closes without publishing (today: `list_worker_definitions`, unlike
   *  `list_skills`/`list_procedures`, never returns a caller's own draft), pass the exact
   *  consequence of clicking "完成 Done" instead of "发布 Publish" — shown as a `warn` Notice in
   *  place of `note`, and the Publish button receives focus on mount so Enter/Space publishes
   *  right away. */
  readonly unpublishedConsequence?: string;
}

/**
 * components/catalog/DraftProposed: an editor's success state — the draft's identity, the
 * privacy note ("草稿私有于提议者"), and the one-click "发布 Publish" that turns it into what
 * `list_*` shows every member (§5.3 "提交即 propose_*，草稿列表可 publish_*"). Publish errors
 * carry the kernel's text (C14).
 */
export function DraftProposed({
  kindLabel,
  draft,
  onPublish,
  onDone,
  note,
  unpublishedConsequence,
}: DraftProposedProps) {
  const t = useT();
  const toast = useToast();
  const [status, setStatus] = useState(draft.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const publishRef = useRef<HTMLButtonElement>(null);

  // Focuses Publish once, on mount only — a later status change (e.g. after publishing) must not
  // steal focus back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount only, see above.
  useEffect(() => {
    if (unpublishedConsequence !== undefined && draft.status === 'draft' && onPublish) {
      publishRef.current?.focus();
    }
  }, []);

  async function publish(): Promise<void> {
    if (!onPublish) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onPublish();
      setStatus(result.status);
      toast.push({ tone: 'ok', title: `已发布 Published · ${draft.name ?? draft.id}` });
    } catch (err) {
      setError(err);
      toast.push({
        tone: 'danger',
        title: `无法发布 Could not publish ${draft.name ?? draft.id}`,
        description: describeError(err).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" data-testid="draft-proposed" data-draft-id={draft.id}>
      <div className="row-wrap">
        <StatusChip machine="publishable" status={status} />
        <strong>{draft.name ?? kindLabel}</strong>
        <span className="text-3">v{draft.version}</span>
        <CopyId id={draft.id} label={kindLabel} />
      </div>
      <Notice
        tone={unpublishedConsequence !== undefined && status === 'draft' ? 'warn' : 'info'}
        testId="draft-private-notice"
      >
        {status === 'draft'
          ? t(
              '草稿只有你（提议者）可见；发布后工作区所有成员可见、可选用。',
              'Drafts are private to you, the proposer; publishing makes it visible and selectable for every member.',
            )
          : t(
              '已发布：工作区所有成员现在可见。 Published —',
              'visible to every member of the workspace now.',
            )}
        {note ? ` ${note}` : ''}
        {unpublishedConsequence !== undefined && status === 'draft'
          ? ` ${unpublishedConsequence}`
          : ''}
      </Notice>
      {error !== null ? <ErrorBanner error={error} testId="draft-publish-error" /> : null}
      <div className="row">
        {status === 'draft' && onPublish ? (
          <Button
            ref={publishRef}
            variant="primary"
            loading={busy}
            onClick={() => void publish()}
            data-testid="draft-publish"
          >
            {t('发布', 'Publish')}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onDone} disabled={busy} data-testid="draft-done">
          {t('完成', 'Done')}
        </Button>
      </div>
    </div>
  );
}
