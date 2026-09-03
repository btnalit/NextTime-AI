import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Renders a header row with the title left and `actions` right. */
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  /** Pads the body (default). Pass `false` when the body is a list that sets its own edges. */
  readonly padded?: boolean;
}

/** components/ui/Card: a bordered surface. Header only when `title`/`actions` are given. */
export function Card({ title, actions, padded = true, className, children, ...rest }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section className={`card${className ? ` ${className}` : ''}`} {...rest}>
      {hasHeader ? (
        <header className="card-header">
          {title !== undefined ? <h2 className="card-title">{title}</h2> : <span />}
          {actions !== undefined ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      {padded ? <div className="card-body">{children}</div> : children}
    </section>
  );
}
