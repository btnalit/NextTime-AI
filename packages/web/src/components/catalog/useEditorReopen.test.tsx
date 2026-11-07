// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditorState } from './CatalogShared.js';
import { useEditorReopen } from './useEditorReopen.js';

/** useEditorReopen.test.tsx: legacy 662 — the catalog editor open when a session expired under
 *  it opens again at the same address, for the same caller. */

interface Row {
  readonly id: string;
}
const ROWS: readonly Row[] = [{ id: 'sk-1' }, { id: 'sk-2' }];

function mount(
  props: Partial<{
    principalId: string | null;
    editorAddressed: boolean;
    editor: EditorState<Row>;
    rows: readonly Row[] | null;
  }>,
) {
  const setEditor = vi.fn();
  const view = renderHook(
    (p: typeof props) =>
      useEditorReopen<Row>({
        principalId: p.principalId === undefined ? 'p-me' : p.principalId,
        tab: 'skills',
        editorAddressed: p.editorAddressed ?? true,
        editor: p.editor ?? null,
        setEditor,
        rows: p.rows === undefined ? ROWS : p.rows,
      }),
    { initialProps: props },
  );
  return { ...view, setEditor };
}

describe('useEditorReopen (legacy 662)', () => {
  it('an editor left open by an unmount opens again, on the same row', () => {
    const first = mount({ editor: { kind: 'version', row: ROWS[1] as Row } });
    first.unmount();

    const again = mount({});
    expect(again.setEditor).toHaveBeenCalledWith({ kind: 'version', row: ROWS[1] });
  });

  it('not once it was closed', () => {
    const first = mount({ editor: { kind: 'new' } });
    first.rerender({ editor: null });
    first.unmount();

    expect(mount({}).setEditor).not.toHaveBeenCalled();
  });

  it('not for another caller, not away from the editor address, and not before the rows are read', () => {
    mount({ editor: { kind: 'new' } }).unmount();

    expect(mount({ principalId: 'p-other' }).setEditor).not.toHaveBeenCalled();
    expect(mount({ editorAddressed: false }).setEditor).not.toHaveBeenCalled();
    const loading = mount({ rows: null });
    expect(loading.setEditor).not.toHaveBeenCalled();
    loading.rerender({ rows: ROWS });
    expect(loading.setEditor).toHaveBeenCalledWith({ kind: 'new' });
  });

  it('a row that is gone: no editor, and the mark goes', () => {
    mount({ editor: { kind: 'copy', row: { id: 'sk-gone' } } }).unmount();
    expect(mount({}).setEditor).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('nexttime.drafts')).toBeNull();
  });
});
