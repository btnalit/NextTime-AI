import { useT } from '../../lib/i18n.js';
import { type StatusMachine, statusChipStyle } from '../../lib/status-tone.js';

export interface StatusChipProps {
  readonly machine: StatusMachine;
  /** The wire value (`ActionRequest.status`, `Task.status`, ...). */
  readonly status: string;
  readonly size?: 's' | 'm';
  readonly className?: string;
  /** `data-testid` for the chip element (S6-A0 / C17: the platform pages' tests key on it). */
  readonly testId?: string;
}

/**
 * components/ui/StatusChip: renders a machine's status with the tone `lib/status-tone.ts` assigns
 * to it. Carries `data-status` (the raw wire value) so tests and e2e can assert on the exact
 * kernel state, and `data-tone` for the visual. An unknown value renders dashed with the raw
 * string — visible, never mis-styled. Every chip shows its label text; the colour is never the
 * only carrier of meaning (§5.9 principle 2).
 */
export function StatusChip({ machine, status, size = 'm', className, testId }: StatusChipProps) {
  const t = useT();
  const style = statusChipStyle(machine, status);
  const labelText = typeof style.label === 'string' ? style.label : t(style.label.zh, style.label.en);
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
      data-testid={testId}
      title={style.unknown ? `Unknown ${machine} status: ${status}` : status}
    >
      {labelText}
    </span>
  );
}
