import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export interface KeyValueItem {
  /** Stable React key; falls back to the row's index when omitted (fine for a static list built
   *  from a fixed field set — pass this when `items` is itself dynamic, e.g. mapped from a record). */
  readonly key?: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** Adds `.mono` to this row's value — ids, hashes, paths, anything that must stay copy-paste
   *  exact (the console's existing convention, `styles/base.css` `.mono`). */
  readonly mono?: boolean;
}

export interface KeyValueProps {
  readonly items: readonly KeyValueItem[];
  readonly testId?: string;
  readonly className?: string;
}

/**
 * components/kit/key-value (console redesign P3-1, DesignSystem.dc.html): a definition-list
 * label/value grid — dense 13px, label column `--text-3`, value `--text`. This is the componentised
 * form of the `<dl className="definition-list">` pattern already hand-written at 30+ call sites
 * across the console (`styles/base.css` `.definition-list`/`dt`/`dd` — unchanged here, this reuses
 * it rather than adding a parallel Tailwind implementation); new detail panels should reach for
 * this instead of repeating the raw markup, but this PR does not migrate the existing call sites.
 */
export function KeyValue({ items, testId, className }: KeyValueProps) {
  return (
    <dl className={cn('definition-list', className)} data-testid={testId}>
      {items.map((item, index) => (
        <Fragment key={item.key ?? index}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? 'mono' : undefined}>{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
