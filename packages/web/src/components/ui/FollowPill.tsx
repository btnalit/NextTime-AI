import { Icon } from './Icon.js';

export interface FollowPillProps {
  /** Messages that arrived below the fold since the reader scrolled up. */
  readonly count: number;
  readonly onClick: () => void;
  readonly testId?: string;
}

/**
 * components/ui/FollowPill (S6-A0, §5.9 — the visible half of the W3 fix): the floating
 * "跟随最新输出 · N 条新消息" pill a chat shows while the reader has scrolled away from the live
 * end. Clicking re-follows the latest output. `count` 0 renders the bare "跟随最新输出" form —
 * the pill itself is the affordance, the number is the urgency.
 */
export function FollowPill({ count, onClick, testId }: FollowPillProps) {
  const label =
    count > 0
      ? `跟随最新输出 · ${count > 99 ? '99+' : count} 条新消息`
      : '跟随最新输出 Follow latest';
  return (
    <button
      type="button"
      className="follow-pill"
      onClick={onClick}
      data-testid={testId}
      data-count={count}
      aria-label={
        count > 0
          ? `Follow latest output — ${count} new message${count === 1 ? '' : 's'}`
          : 'Follow latest output'
      }
    >
      <Icon name="arrow-down" size="s" />
      <span className="follow-pill-label">{label}</span>
    </button>
  );
}
