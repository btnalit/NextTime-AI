import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn.js';

export interface SkeletonProps {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly className?: string;
}

/**
 * components/kit/skeleton (console redesign P3-1): one shimmering block — reuses the legacy
 * `.skeleton` CSS (`styles/ui.css`, same shimmer keyframes) rather than a parallel Tailwind
 * animation, the same reuse choice `kit/select`/`kit/textarea` make for `.select`/`.textarea`.
 * Compose into a rough silhouette of the loading content, or use `SkeletonRows` below for the
 * common "N list rows" shape.
 */
export function Skeleton({ width = '100%', height = 12, className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return <span className={cn('skeleton', className)} style={style} aria-hidden />;
}

export interface SkeletonRowsProps {
  readonly count?: number;
  /** Announced to assistive tech while the real content loads. */
  readonly label?: string;
  readonly testId?: string;
  readonly className?: string;
}

/** Varying widths so the silhouette reads as content, not as a grid — cycled (via modulo) past 6
 *  rows rather than truncated. */
const SILHOUETTES = [
  { title: '55%', meta: '35%' },
  { title: '45%', meta: '50%' },
  { title: '35%', meta: '35%' },
  { title: '55%', meta: '50%' },
  { title: '45%', meta: '35%' },
  { title: '35%', meta: '50%' },
] as const;

/** The `loading` state of a list page or panel: N row silhouettes (leading chip, title, meta). */
export function SkeletonRows({
  count = 4,
  label = 'Loading',
  testId,
  className,
}: SkeletonRowsProps) {
  return (
    <output
      className={cn('skeleton-rows', className)}
      aria-live="polite"
      aria-label={label}
      data-testid={testId}
      data-state="loading"
    >
      {Array.from({ length: count }, (_, index) => {
        const silhouette = SILHOUETTES[index % SILHOUETTES.length] as (typeof SILHOUETTES)[number];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-shape silhouettes, no identity
          <div className="skeleton-row" key={index}>
            <Skeleton width={84} height={20} />
            <div className="grow stack-s">
              <Skeleton width={silhouette.title} height={12} />
              <Skeleton width={silhouette.meta} height={10} />
            </div>
            <Skeleton width={56} height={12} />
          </div>
        );
      })}
    </output>
  );
}
