// @vitest-environment jsdom
import {
  ACTION_REQUEST_STATUS_VALUES,
  CONNECTION_REQUEST_STATUS_VALUES,
  PUBLISHABLE_STATUS_VALUES,
  TASK_STATUS_VALUES,
  WORKER_RUN_STATUS_VALUES,
} from '@nexttime/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type StatusMachine, statusChipStyle, statusValues } from '../../lib/status-tone.js';
import { StatusChip } from './StatusChip.js';

afterEach(cleanup);

/**
 * StatusChip.test.tsx: exhaustive over every value of every `@nexttime/shared` status enum the
 * console renders — a state added to the kernel's vocabulary that the UI has not been given a
 * tone for fails here (and fails `tsc`, since the maps are `Record<<Status>, ...>`), instead of
 * silently rendering as an unstyled/unknown chip in production.
 */
const MACHINES: readonly { readonly machine: StatusMachine; readonly values: readonly string[] }[] =
  [
    { machine: 'actionRequest', values: ACTION_REQUEST_STATUS_VALUES },
    { machine: 'task', values: TASK_STATUS_VALUES },
    { machine: 'workerRun', values: WORKER_RUN_STATUS_VALUES },
    { machine: 'connectionRequest', values: CONNECTION_REQUEST_STATUS_VALUES },
    { machine: 'publishable', values: PUBLISHABLE_STATUS_VALUES },
  ];

describe('StatusChip', () => {
  it('covers the 13 ActionRequest states, and every other machine, with a known tone', () => {
    expect(ACTION_REQUEST_STATUS_VALUES).toHaveLength(13);
    for (const { machine, values } of MACHINES) {
      expect(statusValues(machine)).toEqual(values);
      for (const status of values) {
        const style = statusChipStyle(machine, status);
        expect(style.unknown, `${machine}:${status} has no tone`).toBe(false);
        expect(style.label.length, `${machine}:${status} has no label`).toBeGreaterThan(0);
        expect(style.label).not.toBe(status);

        const { container, unmount } = render(<StatusChip machine={machine} status={status} />);
        const chip = container.querySelector('.chip');
        expect(chip?.getAttribute('data-status')).toBe(status);
        expect(chip?.getAttribute('data-tone')).toBe(style.tone);
        expect(chip?.classList.contains(`chip-${style.tone}`)).toBe(true);
        expect(chip?.classList.contains('chip-unknown')).toBe(false);
        expect(chip?.textContent).toBe(style.label);
        unmount();
      }
    }
  });

  it('renders an unknown value visibly, dashed, with the raw string — never restyled', () => {
    const { container } = render(<StatusChip machine="task" status="teleported" />);
    const chip = container.querySelector('.chip');
    expect(chip?.classList.contains('chip-unknown')).toBe(true);
    expect(chip?.getAttribute('data-tone')).toBe('neutral');
    expect(chip?.textContent).toBe('teleported');
    expect(chip?.getAttribute('title')).toContain('Unknown task status');
  });

  it('marks in-motion states as live (pulsing dot)', () => {
    expect(statusChipStyle('actionRequest', 'pending_approval').live).toBe(true);
    expect(statusChipStyle('task', 'running').live).toBe(true);
    expect(statusChipStyle('task', 'completed').live).toBeUndefined();
    const { container } = render(<StatusChip machine="task" status="running" />);
    expect(container.querySelector('.chip-live')).toBeTruthy();
  });
});
