import type { ReactNode } from 'react';

export interface BreadcrumbItem {
  readonly label: string;
  /** Omit on the last (current) crumb — it renders as plain text with `aria-current="page"`. */
  readonly href?: string;
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** S6-A0 (§5.9 "壳与导航": 面包屑小字 + 标题 + 一句话说明 + 右侧主操作): the small-text trail above
   *  the title, e.g. `[{label:'治理', href:'#/govern/members'}, {label:'成员与授权'}]`. */
  readonly breadcrumb?: readonly BreadcrumbItem[];
  /** The page's single primary action (an ink `Button variant="primary"`), rendered first on the
   *  right. One per page (§5.9 principle 1). */
  readonly primaryAction?: ReactNode;
  /** Further right-aligned actions (secondary / ghost), after `primaryAction`. Pre-S6-A0 callers
   *  pass their whole action group here — that keeps working unchanged. */
  readonly actions?: ReactNode;
}

/**
 * components/ui/PageHeader: breadcrumb + title + one-line description left, primary action and
 * actions right. One per page. `breadcrumb` and `primaryAction` are S6-A0 additions; the
 * original `title` / `description` / `actions` API is unchanged.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  primaryAction,
  actions,
}: PageHeaderProps) {
  const hasActions = primaryAction !== undefined || actions !== undefined;
  return (
    <header className="page-header">
      <div className="page-header-text">
        {breadcrumb !== undefined && breadcrumb.length > 0 ? (
          <nav className="page-breadcrumb" aria-label="Breadcrumb">
            <ol>
              {breadcrumb.map((crumb, index) => {
                const last = index === breadcrumb.length - 1;
                return (
                  <li key={`${index}:${crumb.label}`}>
                    {crumb.href !== undefined && !last ? (
                      <a href={crumb.href}>{crumb.label}</a>
                    ) : (
                      <span aria-current={last ? 'page' : undefined}>{crumb.label}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}
        <h1>{title}</h1>
        {description !== undefined ? <p className="page-description">{description}</p> : null}
      </div>
      {hasActions ? (
        <div className="page-header-actions">
          {primaryAction}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
