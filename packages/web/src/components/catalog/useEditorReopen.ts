import { useEffect, useRef } from 'react';
import { draftScope, forgetDraft, loadDraftValue, saveDraftValue } from '../../lib/drafts.js';
import type { EditorState } from './CatalogShared.js';

/** The row an editor opened from: what a draft target names of it. */
interface EditorSource {
  readonly id: string;
  readonly version: number;
}

/**
 * Legacy 662: the target a catalog editor's form draft is kept under (`hooks/useFormDraft`) — the
 * same for the editor itself and for the tab that closes it (`forgetEditorDraft`).
 */
export function catalogEditorDraftTarget(
  family: 'skill' | 'procedure',
  editor: Exclude<EditorState<EditorSource>, null>,
): string {
  if (editor.kind === 'version') return `${family}:version:${editor.row.id}@${editor.row.version}`;
  if (editor.kind === 'copy') return `${family}:copy:${editor.row.id}`;
  return `${family}:new`;
}

/** Legacy 662 (#501 P2-1 on #1029): the editor discarded from the drawer itself — Esc, a press
 *  outside, its close button, confirmed — goes with its draft, as 取消 does. */
export function forgetEditorDraft(
  principalId: string | null,
  family: 'skill' | 'procedure',
  editor: EditorState<EditorSource>,
): void {
  if (principalId === null || editor === null) return;
  forgetDraft(draftScope(principalId, catalogEditorDraftTarget(family, editor)));
}

interface OpenEditorMark {
  readonly kind: 'new' | 'copy' | 'version';
  readonly rowId?: string;
}

function parseMark(raw: unknown): OpenEditorMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const mark = raw as Record<string, unknown>;
  if (mark.kind === 'new') return { kind: 'new' };
  if ((mark.kind === 'copy' || mark.kind === 'version') && typeof mark.rowId === 'string')
    return { kind: mark.kind, rowId: mark.rowId };
  return null;
}

/**
 * components/catalog/useEditorReopen (legacy 662): which editor a catalog tab has open — a new
 * draft, a copy of a row, the next version of a row — kept in this tab while it is open. The
 * address only says an editor is open (`…/new`), never which, so a session that expired under it
 * came back to 「未找到」 and the form's kept draft (`hooks/useFormDraft`) had nowhere to show.
 * Back at that address with no editor open, the same caller gets the same editor again, and the
 * editor its draft. Closing the editor — finished, cancelled, another row picked — drops the mark.
 * The form's draft goes when the editor is finished, cancelled or closed from the drawer
 * (`forgetEditorDraft`); picking another row in the list while it is open keeps it, so 新建草稿
 * (or the same copy / next version) later opens with it again, saying so.
 */
export function useEditorReopen<Row extends { readonly id: string }>({
  principalId,
  tab,
  editorAddressed,
  editor,
  setEditor,
  rows,
}: {
  readonly principalId: string | null;
  readonly tab: 'skills' | 'procedures';
  /** The address is the tab's editor sentinel (`NEW_ITEM_ID`). */
  readonly editorAddressed: boolean;
  readonly editor: EditorState<Row>;
  readonly setEditor: (next: EditorState<Row>) => void;
  /** The tab's rows once read; `null` while loading. */
  readonly rows: readonly Row[] | null;
}): void {
  const scope = principalId === null ? null : draftScope(principalId, `catalog-editor:${tab}`);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (scope === null) return;
    if (editor !== null) {
      wasOpen.current = true;
      saveDraftValue(
        scope,
        editor.kind === 'new' ? { kind: 'new' } : { kind: editor.kind, rowId: editor.row.id },
      );
    } else if (wasOpen.current) {
      wasOpen.current = false;
      forgetDraft(scope);
    }
  }, [scope, editor]);

  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || scope === null || rows === null) return;
    checked.current = true;
    if (!editorAddressed || editor !== null) return;
    const mark = parseMark(loadDraftValue(scope));
    if (mark === null) return;
    if (mark.kind === 'new') {
      setEditor({ kind: 'new' });
      return;
    }
    const row = rows.find((candidate) => candidate.id === mark.rowId);
    if (row) setEditor({ kind: mark.kind, row });
    else forgetDraft(scope);
  }, [scope, rows, editorAddressed, editor, setEditor]);
}
