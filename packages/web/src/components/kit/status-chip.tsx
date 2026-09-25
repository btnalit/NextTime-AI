import { useT } from '../../lib/i18n.js';
import { type StatusMachine, labelText, statusChipStyle } from '../../lib/status-tone.js';

export interface StatusChipProps {
  readonly machine: StatusMachine;
  /** The wire value (`ActionRequest.status`, `Task.status`, ...). */
  readonly status: string;
  readonly size?: 's' | 'm';
  readonly className?: string;
  /** `data-testid` for the chip element. */
  readonly testId?: string;
}

/**
 * components/kit/status-chip (S8 W3 F1, docs/development-tasks.md §5e F3 / S8 risk ①): the kit
 * replacement for `components/ui/StatusChip` — renders a machine's status with the tone
 * `lib/status-tone.ts` assigns to it, over the same `chip` / `chip-<tone>` / `chip-s` / `chip-live`
 * / `chip-unknown` CSS classes so a page swapping from the legacy component or a local replica
 * renders pixel-identical. Carries `data-status` (the raw wire value) so tests and e2e can assert
 * on the exact kernel state, and `data-tone` for the visual. An unknown value renders dashed with
 * the raw string — visible, never mis-styled.
 */
export function StatusChip({ machine, status, size = 'm', className, testId }: StatusChipProps) {
  const t = useT();
  const style = statusChipStyle(machine, status);
  const text = labelText(style, t);
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
      {text}
    </span>
  );
}
