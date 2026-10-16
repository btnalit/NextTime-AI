import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { useCanOpen } from '../../hooks/useCanOpen.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { capabilityHolders } from '../../lib/role-holders.js';
import { type RouteRequirement, routeRequirement } from '../../lib/route-access.js';

export interface RouteLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children'> {
  /** An in-app `#/…` href (`lib/router`'s `hrefs`, `auditHref`, …). */
  readonly href: string;
  readonly children: ReactNode;
  /** What stands in when the reader cannot open it: `'text'` (default) — the label as plain text
   *  and who can open it; `'plain'` — the label alone (the sentence around it already says who);
   *  `'hide'` — nothing. */
  readonly whenRefused?: 'text' | 'plain' | 'hide';
  /** What stands in, as plain text, when the reader cannot open it and the label is an action
   *  only someone else can take (「去启用：X」 → 「请平台管理员启用：X」, #541 acceptance P3 ②).
   *  Takes precedence over `whenRefused`. */
  readonly refused?: ReactNode;
  readonly testId?: string;
}

/**
 * components/kit/route-link (#541 review N2): an in-app link that is only a link when the reader
 * can open where it goes (`lib/route-access`'s table, the kernel's role predicate) — otherwise
 * the label stays as text with who can open it, never a link onto a page that only says "not
 * your role".
 */
export function RouteLink({
  href,
  children,
  whenRefused = 'text',
  refused,
  testId,
  ...anchor
}: RouteLinkProps) {
  const t = useT();
  const canOpen = useCanOpen();
  if (canOpen(href) === false) {
    if (refused !== undefined) {
      return (
        <span className={anchor.className} data-testid={testId} data-route-refused="true">
          {refused}
        </span>
      );
    }
    if (whenRefused === 'hide') return null;
    return (
      <span className={anchor.className} data-testid={testId} data-route-refused="true">
        {children}
        {whenRefused === 'text' ? (
          <span className="text-3">
            {t('', ' ')}
            {whoCanOpen(routeRequirement(href), t)}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <a {...anchor} href={href} data-testid={testId}>
      {children}
    </a>
  );
}

/** "（只有 operator 和工作区所有者能打开）" — who may open a route the reader cannot, by the same
 *  predicate the table is judged with. */
export function whoCanOpen(requirement: RouteRequirement | undefined, t: Translate): string {
  if (requirement === undefined) return '';
  if (!('capability' in requirement)) {
    return t('（只有平台管理员能打开）', '(platform administrators only)');
  }
  return t(
    `（只有${capabilityHolders(requirement.capability, t)}能打开）`,
    `(only ${capabilityHolders(requirement.capability, t)} can open it)`,
  );
}
