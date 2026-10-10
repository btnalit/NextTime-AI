import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ReadinessReader } from './readiness-copy.js';

/** The signed-in reader for `readiness-copy`'s fix helpers: their role once `get_workspace` said
 *  it (`null` before), and the page they are on. */
export function useReadinessReader(http: CapabilityCaller, currentHref?: string): ReadinessReader {
  const identity = useWorkspaceIdentity(http);
  return { role: identity.role.kind === 'known' ? identity.role.role : null, currentHref };
}

/** A readiness fix for the reader (console audit P1-4/P1-5): the link when they can make the fix
 *  and it leads somewhere else, else who to ask, else nothing. */
export function FixHint({
  href,
  label,
  ask,
}: {
  readonly href: string | undefined;
  readonly label: string | undefined;
  readonly ask: string | undefined;
}) {
  if (href !== undefined) {
    return (
      <a href={href} className="link-inline">
        {label}
      </a>
    );
  }
  return ask !== undefined ? (
    <span className="text-3" data-testid="execution-readiness-ask">
      {ask}
    </span>
  ) : null;
}
