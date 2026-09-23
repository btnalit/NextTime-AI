// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';

afterEach(cleanup);

function renderTooltip(open: boolean) {
  return render(
    <TooltipProvider delayDuration={0}>
      <Tooltip open={open}>
        <TooltipTrigger>?</TooltipTrigger>
        <TooltipContent>撤销后无法恢复</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe('kit/Tooltip', () => {
  it('renders no tooltip content while closed', () => {
    renderTooltip(false);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('renders role="tooltip" content with the token-backed classes when open', () => {
    renderTooltip(true);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe('撤销后无法恢复');
    expect(tooltip.className).toContain('bg-surface-1');
    expect(tooltip.className).toContain('border-border');
  });
});
