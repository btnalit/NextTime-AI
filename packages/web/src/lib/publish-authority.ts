import type { Translate } from './i18n.js';
import type { WorkspaceRole } from './role.js';

/**
 * lib/publish-authority: the console's mirror of D-24's per-row rule (kernel
 * `governance/capability/publish-authority.ts` `mayPublishOrDeprecate`). Every meta-ontology
 * `publish_*` / `deprecate_*` has a builder floor, and on top of it the row must be the caller's
 * own proposal unless the caller is the workspace owner — the kernel refuses anything else with
 * 403 `not_proposer`. The role floor stays `useRoleCan`'s; this only answers the per-row half.
 *
 * Proven only: a role that is not known yet (still inferred), an unknown caller id, or a row
 * without `proposedBy` (an older kernel) keeps the control, and the kernel decides.
 */
export function provenNotProposer(
  row: { readonly proposedBy?: string | null },
  role: WorkspaceRole,
  callerPrincipalId: string | null,
): boolean {
  if (role.kind !== 'known' || role.role === 'owner') return false;
  if (callerPrincipalId === null || typeof row.proposedBy !== 'string') return false;
  return row.proposedBy !== callerPrincipalId;
}

/** Which withheld action a hint explains. `replace`: an Operation revision draft whose publish
 *  would also deprecate a live version someone else proposed (kernel `publishOperation`). */
export type ProposerOnlyAction = 'publish' | 'deprecate' | 'replace';

/** The reason shown where Publish / Deprecate would have been. */
export function proposerOnlyText(action: ProposerOnlyAction, t: Translate): string {
  switch (action) {
    case 'publish':
      return t(
        '只有它的提议人或工作区所有者能发布它。',
        'Only its proposer or the workspace owner can publish it.',
      );
    case 'deprecate':
      return t(
        '只有它的提议人或工作区所有者能弃用它。',
        'Only its proposer or the workspace owner can deprecate it.',
      );
    case 'replace':
      return t(
        '发布这份修订会替换别人提议的现行版本，只有那位提议人或工作区所有者能发布。',
        'Publishing this revision replaces a live version someone else proposed — only that proposer or the workspace owner can publish it.',
      );
  }
}
