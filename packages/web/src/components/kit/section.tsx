import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export interface DashboardCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Renders a header row with the title left and `actions` right — same contract as
   *  `components/ui/Card`, so a page dropping this in for that one keeps its existing
   *  `title`/`actions`/`padded` call sites unchanged. */
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  /** Pads the body (default). Pass `false` when the body is a list that sets its own edges. */
  readonly padded?: boolean;
}

/**
 * components/kit/section (S8 W1-A11, docs/console-completion-plan.md §5.9 principle 5, audit L5
 * "分区外壳"): the two section shells every page type converges on instead of three ad hoc ones
 * (bare on the page background / one card per section / one card with dividers, picked
 * per-page). A **dashboard** page (independent, differently-loading widgets — the platform
 * overview's version/checklist/health/audit tiles, a workspace's models/access lists) gets one
 * `DashboardCard` per section, each independently bordered — the Tailwind/Radix counterpart of
 * `components/ui/Card`. A **form** page (one linear submission) gets a single `FormCard`
 * containing one `FormCardSection` per titled sub-section, divided by a hairline instead of
 * separate borders.
 */
export function DashboardCard({
  title,
  actions,
  padded = true,
  className,
  children,
  ...rest
}: DashboardCardProps) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section
      className={cn('rounded-l border border-border bg-surface-1 shadow-card', className)}
      {...rest}
    >
      {hasHeader ? (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          {title !== undefined ? (
            <h2 className="text-14 font-semibold text-text">{title}</h2>
          ) : (
            <span />
          )}
          {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {padded ? <div className="p-4">{children}</div> : children}
    </section>
  );
}

export interface FormCardProps extends HTMLAttributes<HTMLDivElement> {}

/** One bordered surface for a whole form page — its `FormCardSection` children divide with a
 *  hairline instead of each getting its own border (§5.9: "表单页统一「一张卡 + 分割线」"). */
export function FormCard({ className, children, ...rest }: FormCardProps) {
  return (
    <div
      className={cn(
        'flex flex-col divide-y divide-border rounded-l border border-border bg-surface-1 shadow-card',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface FormCardSectionProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}

/** One titled sub-section inside a `FormCard`. Omit `title` for a section with no heading of its
 *  own (rare — most `FormCard` sections are titled). */
export function FormCardSection({ title, description, children, testId }: FormCardSectionProps) {
  return (
    <section className="flex flex-col gap-3 p-5" data-testid={testId}>
      {title !== undefined ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-14 font-semibold text-text">{title}</h3>
          {description !== undefined ? <p className="text-13 text-text-3">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
