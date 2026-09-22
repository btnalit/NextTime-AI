// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FRESHNESS_LEGEND } from '../../lib/graph-freshness.js';
import { FreshnessChip } from './FreshnessChip.js';
import { FreshnessLegend } from './FreshnessLegend.js';

afterEach(cleanup);

const NOW = Date.parse('2026-09-19T12:00:00Z');

describe('FreshnessChip', () => {
  it('renders the tone class, data attributes and the bilingual label from wire fields', () => {
    render(
      <FreshnessChip
        input={{ lastObservedAt: '2026-09-19T11:50:00Z' }}
        asOf={NOW}
        size="s"
        testId="chip"
      />,
    );
    const chip = screen.getByTestId('chip');
    expect(chip.className).toBe('chip chip-ok chip-s');
    expect(chip.getAttribute('data-tone')).toBe('ok');
    expect(chip.getAttribute('data-freshness')).toBe('fresh');
    expect(chip.textContent).toBe('新鲜 Fresh');
  });

  it('accepts a precomputed Freshness and never colours without text', () => {
    const conflict = FRESHNESS_LEGEND.find((row) => row.kind === 'conflict');
    render(
      <FreshnessChip
        freshness={{ kind: 'conflict', tone: 'danger', label: conflict?.label ?? '', ageMs: 0 }}
        testId="chip"
      />,
    );
    const chip = screen.getByTestId('chip');
    expect(chip.className).toContain('chip-danger');
    expect(chip.textContent).toBe('冲突 Conflict');
  });
});

describe('FreshnessLegend', () => {
  it('lists every kind with its chip and states the window', () => {
    render(<FreshnessLegend />);
    const legend = screen.getByTestId('graph-legend');
    expect(legend.querySelectorAll('.graph-legend-row')).toHaveLength(FRESHNESS_LEGEND.length);
    expect(legend.textContent).toContain('2 小时 2 h');
    expect(legend.textContent).toContain('ops.collector_silent');
  });
});
