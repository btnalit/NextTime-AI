import type { Role } from '@nexttime/shared';
import { useCallback } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { type Translate, useT } from '../lib/i18n.js';
import { roleLabel } from '../lib/labels.js';
import { useWorkspaceIdentity } from './useWorkspaceIdentity.js';

/** The role that holds what the reader was refused: operator (the approvals, the member list) or
 *  auditor (the audit log, export, reconstruct). The workspace owner holds both. */
export type AccessHolder = 'operator' | 'auditor';

/** What the reader wanted to do there (`approve`: take part in approvals). */
export type AccessVerb = 'see' | 'approve' | 'export' | 'reconstruct';

/**
 * The "whom to ask" sentence under a role refusal (UX acceptance of #541, P2). A member asks the
 * owner for the role: for a member that is an upgrade. Any other role holds a peer role it would
 * lose by switching — a member has exactly one role — so it asks a holder or the owner to do it
 * for them. An unknown role gets the same sentence, which is right for every role.
 */
export function askForAccess(
  role: Role | null,
  holder: AccessHolder,
  verb: AccessVerb,
  t: Translate,
): string {
  // The role's own label (`lib/status-tone` ROLE_TONES), the one the rest of the console shows.
  const holderZh = roleLabel(holder, t);
  const holderEn = holder === 'operator' ? 'an operator' : 'an auditor';
  if (role === 'member') {
    switch (verb) {
      case 'see':
        return t(
          `要查看，请工作区所有者把你的角色改为${holderZh}。`,
          `To see it, ask the workspace owner to make you ${holderEn}.`,
        );
      case 'approve':
        return t(
          `要参与审批，请工作区所有者把你的角色改为${holderZh}。`,
          `To take part in approvals, ask the workspace owner to make you ${holderEn}.`,
        );
      case 'export':
        return t(
          `要导出，请工作区所有者把你的角色改为${holderZh}。`,
          `To export, ask the workspace owner to make you ${holderEn}.`,
        );
      case 'reconstruct':
        return t(
          `要重建，请工作区所有者把你的角色改为${holderZh}。`,
          `To reconstruct, ask the workspace owner to make you ${holderEn}.`,
        );
    }
  }
  switch (verb) {
    case 'see':
      return t(
        `要查看，请${holderZh}或工作区所有者帮你查看。`,
        `To see it, ask ${holderEn} or the workspace owner to look it up for you.`,
      );
    case 'approve':
      return t(
        `审批由他们处理；要了解某条审批，请${holderZh}或工作区所有者帮你查看。`,
        `They handle approvals; to learn about one, ask ${holderEn} or the workspace owner to look it up for you.`,
      );
    case 'export':
      return t(
        `要导出，请${holderZh}或工作区所有者帮你导出。`,
        `To export, ask ${holderEn} or the workspace owner to export it for you.`,
      );
    case 'reconstruct':
      return t(
        `要重建，请${holderZh}或工作区所有者帮你重建。`,
        `To reconstruct, ask ${holderEn} or the workspace owner to run it for you.`,
      );
  }
}

/** `askForAccess` for the signed-in reader of this workspace. */
export function useAskForAccess(
  http: CapabilityCaller,
): (holder: AccessHolder, verb: AccessVerb) => string {
  const t = useT();
  const { role } = useWorkspaceIdentity(http);
  const known = role.kind === 'known' ? role.role : null;
  return useCallback(
    (holder: AccessHolder, verb: AccessVerb) => askForAccess(known, holder, verb, t),
    [known, t],
  );
}
