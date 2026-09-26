// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton, SkeletonRows } from './skeleton.js';

afterEach(cleanup);

describe('kit/Skeleton', () => {
  it('renders one hidden-from-a11y block at the given size', () => {
    const { container } = render(<Skeleton width={120} height={16} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.width).toBe('120px');
    expect(el.style.height).toBe('16px');
  });

  it('defaults to a full-width 12px block', () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('12px');
  });
});

describe('kit/SkeletonRows', () => {
  it('renders `count` row silhouettes and announces the label', () => {
    render(<SkeletonRows count={3} label="Loading members" testId="members-loading" />);
    const region = screen.getByTestId('members-loading');
    expect(region.getAttribute('data-state')).toBe('loading');
    expect(region.getAttribute('aria-label')).toBe('Loading members');
    expect(region.querySelectorAll('.skeleton-row')).toHaveLength(3);
  });

  it('cycles the silhouette widths past 6 rows instead of truncating', () => {
    render(<SkeletonRows count={8} testId="many-loading" />);
    expect(screen.getByTestId('many-loading').querySelectorAll('.skeleton-row')).toHaveLength(8);
  });

  it('defaults to 4 rows', () => {
    render(<SkeletonRows testId="default-loading" />);
    expect(screen.getByTestId('default-loading').querySelectorAll('.skeleton-row')).toHaveLength(4);
  });
});
