import type { ReactNode } from 'react';

export interface DrawerSectionProps {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}

/**
 * components/kit/drawer-section (S8 W1-A11, audit L8 "抽屉结构"): the drawer's fixed shell —
 * read-only metadata, related-object links, and the editable form each get one `DrawerSection`,
 * always in that order, sharing the one heading style this file defines. Before this, every
 * hand-written drawer body mixed the three kinds of content with only a bare `<div
 * className="divider" />` between them, and section headings drifted between the legacy
 * `.section-title`'s uppercase tracking (`WORKSPACES USING IT`) and a plain `Field` label's
 * sentence case (`Display name`) — the audit's own example of the inconsistency. `DrawerSection`
 * always renders sentence case; `DrawerSections` lays its children out with one hairline between
 * each, so callers drop the ad hoc dividers entirely.
 *
 * Not every drawer has all three kinds of content (a provider's detail has no related-object
 * links, for instance) — omit the `DrawerSection` that has nothing to show rather than rendering
 * an empty one.
 */
export function DrawerSection({ title, children, testId }: DrawerSectionProps) {
  return (
    <section className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0" data-testid={testId}>
      <h3 className="text-12 font-semibold text-text-2">{title}</h3>
      {children}
    </section>
  );
}

export interface DrawerSectionsProps {
  readonly children: ReactNode;
}

/** Wraps a drawer body's `DrawerSection`s with one hairline between each — the fixed
 *  metadata / related links / edit form order (see the module doc comment above). */
export function DrawerSections({ children }: DrawerSectionsProps) {
  return <div className="flex flex-col divide-y divide-border">{children}</div>;
}
