import { ROLE_VALUES, getCapability, roleMayUseCapability } from '@nexttime/shared';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { useCanOpen } from '../../hooks/useCanOpen.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { roleLabel } from '../../lib/labels.js';
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
  testId,
  ...anchor
}: RouteLinkProps) {
  const t = useT();
  const canOpen = useCanOpen();
  if (canOpen(href) === false) {
    if (whenRefused === 'hide') return null;
    return (
      <span className={anchor.className} data-testid={testId} data-route-refused="true">
        {children}
        {whenRefused === 'text' ? (
          <span className="text-3"> {whoCanOpen(routeRequirement(href), t)}</span>
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
  const capability = getCapability(requirement.capability);
  const holders = ROLE_VALUES.filter(
    (role) => role !== 'owner' && roleMayUseCapability(role, capability),
  ).map((role) => roleLabel(role, t));
  return holders.length === 0
    ? t('（只有工作区所有者能打开）', '(workspace owner only)')
    : t(
        `（只有${holders.join('、')}和工作区所有者能打开）`,
        `(only ${holders.join(', ')} and the workspace owner can open it)`,
      );
}
