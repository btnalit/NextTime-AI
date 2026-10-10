import { useCapability } from '../../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import type { AgentPolicy } from '../../lib/agent-profile.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ReadinessReader } from './readiness-copy.js';

/** The signed-in reader for `readiness-copy`'s fix helpers: their role once `get_workspace` said
 *  it (`null` before), whether the policy lets a member edit their own 我的智能体 (`get_agent_policy`,
 *  member-readable; `null` until read), and the page they are on. Both reads are cached per
 *  session (`useCapability`), so every card on a page shares them. */
export function useReadinessReader(http: CapabilityCaller, currentHref?: string): ReadinessReader {
  const identity = useWorkspaceIdentity(http);
  const policy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  return {
    role: identity.role.kind === 'known' ? identity.role.role : null,
    memberCanEditProfile:
      policy.state.status === 'ready' ? policy.state.data.memberCanEditProfile : null,
    currentHref,
  };
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
      <a href={href} className="link-inline" data-testid="execution-readiness-fix">
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
