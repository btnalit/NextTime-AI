import type { ReactNode } from 'react';

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** Right-aligned; the page's primary action goes first. */
  readonly actions?: ReactNode;
}

/** components/ui/PageHeader: title + one-line description left, actions right. One per page. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {description !== undefined ? <p className="page-description">{description}</p> : null}
      </div>
      {actions !== undefined ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
