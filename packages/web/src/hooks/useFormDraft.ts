import { useCallback, useEffect, useRef, useState } from 'react';
import { reserveClientUidsIn } from '../lib/client-uids.js';
import { draftScope, forgetDraft, loadDraftValue, saveDraftValue } from '../lib/drafts.js';

export interface FormDraft {
  /** The form was put back from a kept draft on this mount — the editor says so. */
  readonly restored: boolean;
  /** The draft is done with — submitted, or discarded by the person. Nothing is kept after. */
  readonly forget: () => void;
}

export interface FormDraftOptions<T> {
  /** Who is editing (`useWorkspaceIdentity` `principalId`); `null` while not known yet. */
  readonly principalId: string | null;
  /** What is being edited (`skill:new`, `goal:<id>`, …) — `lib/drafts.ts` `draftScope`. */
  readonly target: string;
  /** The form as it stands. */
  readonly value: T;
  /** The person changed it from what the editor opened with: only then is it kept. */
  readonly edited: boolean;
  /** Narrows a kept value back to `T`; `null` for one this editor cannot take (another shape). */
  readonly parse: (raw: unknown) => T | null;
  /** Puts a kept value back into the form. */
  readonly restore: (value: T) => void;
}

/**
 * hooks/useFormDraft (legacy 662): an editor's whole form, kept in this tab as it is edited
 * (`lib/drafts.ts`), so a console session that expires under it — the shell unmounts and lands on
 * sign-in — does not take the person's work with it. The same caller opening the same target
 * again gets it back: restored once, on the first render that knows who is editing, before
 * anything is kept (keeping first would overwrite the very draft there is to restore — #1023).
 * The keys a restored form carries are reserved (`lib/client-uids.ts`), so a row added after a
 * reload cannot take one.
 *
 * Kept only while `edited`; an editor set back to what it opened with keeps nothing. `forget`
 * ends it: after a submit, or a discard the person confirmed.
 */
export function useFormDraft<T>({
  principalId,
  target,
  value,
  edited,
  parse,
  restore,
}: FormDraftOptions<T>): FormDraft {
  const scope = principalId === null ? null : draftScope(principalId, target);
  const [restored, setRestored] = useState(false);
  const checkedFor = useRef<string | null>(null);
  const done = useRef(false);
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    if (scope === null || done.current) return;
    if (checkedFor.current !== scope) {
      checkedFor.current = scope;
      const kept = loadDraftValue(scope);
      const parsed = kept === null ? null : parseRef.current(kept);
      if (parsed !== null) {
        reserveClientUidsIn(parsed);
        restoreRef.current(parsed);
        setRestored(true);
        return;
      }
    }
    if (edited) saveDraftValue(scope, value);
    else forgetDraft(scope);
  }, [scope, value, edited]);

  const forget = useCallback(() => {
    done.current = true;
    if (scope !== null) forgetDraft(scope);
  }, [scope]);

  return { restored, forget };
}
