import { type StatusMachine, statusChipStyle } from '../../lib/status-tone.js';

export interface StatusChipProps {
  readonly machine: StatusMachine;
  /** The wire value (`ActionRequest.status`, `Task.status`, ...). */
  readonly status: string;
  readonly size?: 's' | 'm';
  readonly className?: string;
}

/**
 * components/ui/StatusChip: renders a machine's status with the tone `lib/status-tone.ts` assigns
 * to it. Carries `data-status` (the raw wire value) so tests and e2e can assert on the exact
 * kernel state, and `data-tone` for the visual. An unknown value renders dashed with the raw
 * string — visible, never mis-styled.
 */
export function StatusChip({ machine, status, size = 'm', className }: StatusChipProps) {
  const style = statusChipStyle(machine, status);
  const classes = [
    'chip',
    `chip-${style.tone}`,
    size === 's' ? 'chip-s' : '',
    style.live ? 'chip-live' : '',
    style.unknown ? 'chip-unknown' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      data-status={status}
      data-tone={style.tone}
      title={style.unknown ? `Unknown ${machine} status: ${status}` : status}
    >
      {style.label}
    </span>
  );
}
