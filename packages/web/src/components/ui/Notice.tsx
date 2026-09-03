import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export interface NoticeProps {
  readonly tone?: 'info' | 'warn';
  readonly children: ReactNode;
  readonly testId?: string;
}

/** components/ui/Notice: a quiet inline note (a kernel gap, a permission boundary, a hint). Not
 *  for errors — those are `ErrorBanner`. */
export function Notice({ tone = 'info', children, testId }: NoticeProps) {
  return (
    <div className={`notice${tone === 'warn' ? ' notice-warn' : ''}`} data-testid={testId}>
      <Icon name={tone === 'warn' ? 'alert' : 'info'} size="s" />
      <div className="grow">{children}</div>
    </div>
  );
}
