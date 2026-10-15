import { shortId } from '../../lib/format.js';

export interface SameNameIdProps {
  readonly id: string;
  /** The ids whose name collides with another row's (`lib/same-name`'s `sameNameIds`). */
  readonly same: ReadonlySet<string>;
}

/**
 * components/kit/same-name-id: the short id after a name that another member or gate also
 * carries — nothing at all for a unique name. Its own element, marked `data-volatile` and set in
 * mono, so the screenshot gate masks the per-run id while the width stays the same every run
 * (see `lib/same-name`).
 */
export function SameNameId({ id, same }: SameNameIdProps) {
  if (!same.has(id)) return null;
  return (
    <span className="same-name-id mono text-3" data-volatile="" data-testid="same-name-id">
      {` · ${shortId(id)}`}
    </span>
  );
}
