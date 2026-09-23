import type { ReactNode } from 'react';

export interface BreadcrumbItem {
  readonly label: string;
  /** Omit on the last (current) crumb, and on any crumb with nowhere to link (e.g. a nav group
   *  name — none of the three groups has its own landing page) — it then renders as plain text.
   *  The last crumb always carries `aria-current="page"` regardless of `href`. */
  readonly href?: string;
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** The small-text trail above the title (§5.9 "壳与导航": 面包屑小字 + 标题 + 一句话说明 + 右侧主操作).
   *  Build this with `lib/nav.ts`'s `breadcrumbFor(section)` rather than writing crumbs by hand —
   *  that is the single source the Sidebar's own group/page names come from too (S8 W1-A1, audit
   *  S12: before this, per-page breadcrumbs drifted from the Sidebar and from each other — three
   *  spellings of the same group existed at once). */
  readonly breadcrumb?: readonly BreadcrumbItem[];
  /** The page's single primary action (§5.9 principle 1: one ink button per page), rendered
   *  first, before `actions`. */
  readonly primaryAction?: ReactNode;
  /** Further right-aligned actions (secondary / ghost), after `primaryAction`. */
  readonly actions?: ReactNode;
}

/**
 * components/kit/page-header (S8 W1-A1, docs/development-tasks.md §5e decision F3, audit S1/S12):
 * the first "real" kit component wired into pages — breadcrumb + title + one-line description on
 * the left, primary action and actions on the right. One `<h1>` per page.
 *
 * Layout (audit S1: the legacy `ui/PageHeader` had no min-width on the title column and no
 * `flex-wrap` on the actions row, so a title could shrink to one character per line while actions
 * overflowed past the viewport edge): the title column (`min-w-56`, ~224px) never shrinks below a
 * readable width; the header row is `flex-wrap`, so when the title's min-width and the actions
 * group's natural width no longer both fit, the *entire* actions group (a single flex item) wraps
 * as a whole onto its own line below the title — not manual breakpoint math, so it holds at any
 * width, including the 768px checkpoint the audit's real-window recheck flagged. Inside the
 * actions group, individual buttons also wrap (`flex-wrap`) if they alone overflow a narrow
 * screen.
 *
 * Breadcrumb (audit S6: a 16px-tall hit area): the link/current-crumb box is `min-h-9` (36px, the
 * same §5.9 principle-6 floor `components/kit/button`'s `m` size uses) via `inline-flex
 * items-center`, which grows the invisible tap target without changing the visible text size
 * (still `text-12`).
 *
 * Every class here is token-backed (`scripts/guards/css-tokens.mjs` rejects Tailwind arbitrary
 * values) — colours/sizes resolve through `styles/tailwind.css`'s `@theme inline` aliases onto
 * `styles/tokens.css`, never a literal.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  primaryAction,
  actions,
}: PageHeaderProps) {
  const hasActions = primaryAction !== undefined || actions !== undefined;
  const hasBreadcrumb = breadcrumb !== undefined && breadcrumb.length > 0;
  return (
    <header className="flex flex-col gap-2">
      {hasBreadcrumb ? (
        <nav aria-label="Breadcrumb" className="text-12 text-text-3">
          <ol className="flex flex-wrap items-center gap-x-1">
            {breadcrumb.map((crumb, index) => {
              const last = index === breadcrumb.length - 1;
              return (
                // eslint-disable-next-line react/no-array-index-key -- crumbs are a fixed, ordered trail
                <li key={`${index}:${crumb.label}`} className="flex items-center gap-x-1">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-border-strong">
                      /
                    </span>
                  ) : null}
                  {crumb.href !== undefined && !last ? (
                    <a
                      href={crumb.href}
                      className="inline-flex min-h-9 items-center text-text-3 hover:text-accent"
                    >
                      {crumb.label}
                    </a>
                  ) : (
                    <span
                      aria-current={last ? 'page' : undefined}
                      className="inline-flex min-h-9 items-center text-text-2"
                    >
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <h1 className="text-19 font-semibold text-text">{title}</h1>
          {description !== undefined ? <p className="text-13 text-text-3">{description}</p> : null}
        </div>
        {hasActions ? (
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            {primaryAction}
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
