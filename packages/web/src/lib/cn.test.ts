import { describe, expect, it } from 'vitest';
import { buttonVariants } from '../components/kit/button.js';
import { cn } from './cn.js';

describe('cn', () => {
  it('keeps a text colour next to a type-scale size (the scale is a font-size group)', () => {
    expect(cn('text-13 text-text-on-primary', 'text-12').split(' ')).toEqual([
      'text-text-on-primary',
      'text-12',
    ]);
  });

  it('still resolves real conflicts in favour of the last class', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-13', 'text-12')).toBe('text-12');
  });

  it('a small primary kit Button keeps its label colour (P3-2 / P3-3 invisible-label bug)', () => {
    // kit/button.tsx merges its own variant classes through cn(), exactly like this.
    const classes = cn(buttonVariants({ variant: 'primary', size: 's' })).split(' ');
    expect(classes).toContain('text-text-on-primary');
    expect(classes).toContain('text-12');
    expect(classes).not.toContain('text-13');
  });
});
