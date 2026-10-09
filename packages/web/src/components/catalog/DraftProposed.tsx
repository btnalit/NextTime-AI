import { useEffect, useRef, useState } from 'react';
import { usePublishCredentialReview } from '../../lib/credential-review.js';
import { describeError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { CredentialReview } from '../kit/credential-review.js';
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
  /** The `publish_*` call for this draft; `undefined` hides the button (permission denied). The
   *  caller spreads `review` into its params — the credential confirmation once it was given
   *  (decision 2026-10-09 "二次确认", lib/credential-review.ts). */
  readonly onPublish?: (review: {
    readonly credentialsReviewed?: true;
  }) => Promise<{ readonly status: string }>;
  readonly onDone: () => void;
  /** Extra caveat (e.g. "the Workers tab only lists published versions"). */
  readonly note?: string;
  /** R6: an extra nudge for a draft that is easy to lose track of once this screen closes without
   *  publishing — pass the exact consequence of clicking "完成 Done" instead of "发布 Publish" —
   *  shown as a `warn` Notice in place of `note`, and the Publish button receives focus on mount
   *  so Enter/Space publishes right away. (Originally added when `list_worker_definitions` had no
   *  way to show the caller's own draft again at all, S8 W2-U2b's `includeOwnDrafts` fixed that —
   *  the Workers tab's own "我的草稿" section is the fallback now, this prop just keeps the nudge
   *  toward publishing front and center on the screen that already has the draft in view.) */
  readonly unpublishedConsequence?: string;
  /** Skill / Procedure drafts are also visible to the workspace owner and builders, who review
   *  and publish them (D-26 rule); WorkerDefinition drafts stay the proposer's alone. */
  readonly reviewersSeeDraft?: boolean;
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
  reviewersSeeDraft = false,
}: DraftProposedProps) {
  const t = useT();
  const toast = useToast();
  const [status, setStatus] = useState(draft.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const publishRef = useRef<HTMLButtonElement>(null);
  const credentialReview = usePublishCredentialReview(`${draft.id}@${draft.version}`);

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
      const result = await onPublish(credentialReview.params());
      setStatus(result.status);
      toast.push({
        tone: 'ok',
        title: t(`已发布 · ${draft.name ?? draft.id}`, `Published · ${draft.name ?? draft.id}`),
      });
    } catch (err) {
      // The kernel's credential question — answered next to Publish, not as a failure.
      if (credentialReview.capture(err)) return;
      setError(err);
      toast.push({
        tone: 'danger',
        title: t(
          `无法发布 ${draft.name ?? draft.id}`,
          `Could not publish ${draft.name ?? draft.id}`,
        ),
        description: platformErrorMessage(err, t) ?? describeError(err).message,
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
        {status === 'draft' && reviewersSeeDraft
          ? t(
              '草稿只有你（提议者）和工作区的 owner、builder 可见；发布后工作区所有成员可见、可选用。',
              'Drafts are visible only to you, the proposer, and the workspace owner and builders; publishing makes it visible and selectable for every member.',
            )
          : status === 'draft'
            ? t(
                '草稿只有你（提议者）可见；发布后工作区所有成员可见、可选用。',
                'Drafts are private to you, the proposer; publishing makes it visible and selectable for every member.',
              )
            : t(
                '已发布：工作区所有成员现在可见。',
                'Published — visible to every member of the workspace now.',
              )}
        {note ? ` ${note}` : ''}
        {unpublishedConsequence !== undefined && status === 'draft'
          ? ` ${unpublishedConsequence}`
          : ''}
      </Notice>
      {error !== null ? <ErrorBanner error={error} testId="draft-publish-error" /> : null}
      {status === 'draft' && onPublish ? (
        <CredentialReview
          count={credentialReview.count}
          subject="publish"
          checked={credentialReview.checked}
          onChange={credentialReview.setChecked}
          disabled={busy}
        />
      ) : null}
      <div className="row">
        {status === 'draft' && onPublish ? (
          <Button
            ref={publishRef}
            variant="primary"
            loading={busy}
            disabled={credentialReview.blocked}
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
