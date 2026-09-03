import type { CSSProperties } from 'react';

export interface SkeletonProps {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly className?: string;
}

/** components/ui/Skeleton: one shimmering block. Compose into a rough silhouette of the content. */
export function Skeleton({ width = '100%', height = 12, className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return (
    <span className={`skeleton${className ? ` ${className}` : ''}`} style={style} aria-hidden />
  );
}

export interface SkeletonRowsProps {
  readonly count?: number;
  /** Announced to assistive tech while the real content loads. */
  readonly label?: string;
  readonly testId?: string;
}

/** Varying widths so the silhouette reads as content, not as a grid. Cycled for `count` > 6. */
const SILHOUETTES = [
  { key: 'a', title: '55%', meta: '35%' },
  { key: 'b', title: '45%', meta: '50%' },
  { key: 'c', title: '35%', meta: '35%' },
  { key: 'd', title: '55%', meta: '50%' },
  { key: 'e', title: '45%', meta: '35%' },
  { key: 'f', title: '35%', meta: '50%' },
] as const;

/** The `loading` state of every list page: N row silhouettes (chip, title, meta, trailing). */
export function SkeletonRows({ count = 4, label = 'Loading', testId }: SkeletonRowsProps) {
  return (
    <output
      className="skeleton-rows"
      aria-live="polite"
      aria-label={label}
      data-testid={testId}
      data-state="loading"
    >
      {SILHOUETTES.slice(0, count).map((silhouette) => (
        <div className="skeleton-row" key={silhouette.key}>
          <Skeleton width={84} height={20} />
          <div className="grow stack-s">
            <Skeleton width={silhouette.title} height={12} />
            <Skeleton width={silhouette.meta} height={10} />
          </div>
          <Skeleton width={56} height={12} />
        </div>
      ))}
    </output>
  );
}
