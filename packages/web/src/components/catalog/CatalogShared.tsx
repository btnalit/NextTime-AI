import { useT } from '../../lib/i18n.js';

/** Local editor-drawer state shared by the Skills and Procedures tabs: a blank new draft, a copy
 *  saved as a new Skill / Procedure (「另存为新的」, a new family), or the next version of the row's
 *  own family (「编辑（新版本草稿）」, S11 W1a E2-0 — `propose_skill{skillId}` /
 *  `propose_procedure{procedureId}`). The Workers tab uses its own state (`WorkerEditorState`,
 *  adds `'template'`) rather than this generic. */
export type EditorState<Row> =
  | { readonly kind: 'new' }
  | { readonly kind: 'copy'; readonly row: Row }
  | { readonly kind: 'version'; readonly row: Row }
  | null;

/** S8 W3 K2 (leftover 82): the periodic kernel sweep's own staleness threshold, in days — the
 *  console has no read of it today (out of this lane's own read-model scope, see the PR report),
 *  so this mirrors the kernel's compiled-in default (`DEFAULT_DRAFT_EXPIRY_DAYS`,
 *  `application/worker/draft-lifecycle.ts`) rather than guessing; a platform-configurable
 *  `DRAFT_EXPIRY_DAYS` env override on the kernel is not reflected here. */
export const DRAFT_EXPIRY_DAYS = 30;

/** The one-line auto-cleanup note shared by the Workers tab's "我的草稿" section and the Skills /
 *  Procedures tabs' toolbars (S8 W3 K2, leftover 82). */
export function DraftExpiryNote({ testId }: { readonly testId: string }) {
  const t = useT();
  return (
    <p className="text-3 text-small" data-testid={testId}>
      {t(
        `草稿 ${DRAFT_EXPIRY_DAYS} 天未更新会自动清理。`,
        `A draft is automatically cleaned up after ${DRAFT_EXPIRY_DAYS} days with no update.`,
      )}
    </p>
  );
}
