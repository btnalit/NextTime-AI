import type { ReactNode } from 'react';

export interface NoticeProps {
  /** `info` (the default) is a quiet note; `warn` asks for care; `danger` is a state that can do
   *  harm if misread — an action that may already have run (legacy 287). */
  readonly tone?: 'info' | 'warn' | 'danger';
  readonly children: ReactNode;
  /** Optional leading icon — `kit/notice` does not import `components/ui/Icon` (S8 risk ①, the
   *  `components/kit/*` boundary), so the caller passes its own icon element (or omits it). The
   *  callers this lane wires up (`GrantGateForm`, `EnableGateConfirm`) render no icon here
   *  today — same visual output as the local `ui/Notice` replicas they replace. */
  readonly icon?: ReactNode;
  readonly testId?: string;
  /** For a control that names this note in its `aria-describedby` (legacy 498). */
  readonly id?: string;
}

/**
 * components/kit/notice (S8 W3 F1, docs/development-tasks.md §5e F3 / S8 risk ①): the kit
 * replacement for `components/ui/Notice` — a quiet inline note (a kernel gap, a permission
 * boundary, a hint), over the same `notice` / `notice-warn` / `notice-danger` CSS classes so a page swapping from the
 * legacy component or a local replica renders pixel-identical. Not for errors — those are
 * `kit/error-banner`.
 */
export function Notice({ tone = 'info', children, icon, testId, id }: NoticeProps) {
  return (
    <div
      id={id}
      className={`notice${tone === 'warn' ? ' notice-warn' : tone === 'danger' ? ' notice-danger' : ''}`}
      data-testid={testId}
      data-tone={tone}
    >
      {icon !== undefined ? icon : null}
      <div className="grow">{children}</div>
    </div>
  );
}
