import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export interface EmptyStateProps {
  readonly icon?: IconName;
  readonly title: string;
  /** One line. What "nothing here" means and, if useful, what produces items. */
  readonly body?: ReactNode;
  /** The primary action, when there is something the reader can do about it. */
  readonly action?: ReactNode;
  readonly testId?: string;
}

/** components/ui/EmptyState: the `ready` state with zero items — icon, one line, one action. */
export function EmptyState({ icon = 'inbox', title, body, action, testId }: EmptyStateProps) {
  return (
    <div className="empty-state" data-testid={testId} data-state="empty">
      <Icon name={icon} size="l" />
      <p className="empty-state-title">{title}</p>
      {body !== undefined ? <p className="empty-state-body">{body}</p> : null}
      {action !== undefined ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
