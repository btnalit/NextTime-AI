import {
  type CapabilityName,
  ROLE_VALUES,
  type Role,
  getCapability,
  roleMayUseCapability,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';
import { roleLabel } from './labels.js';

/** The workspace roles other than the owner that may use `capability`, by the kernel's own
 *  predicate (`roleMayUseCapability`) — the owner clears every one. */
export function holderRoles(capability: CapabilityName): readonly Role[] {
  const definition = getCapability(capability);
  return ROLE_VALUES.filter((role) => role !== 'owner' && roleMayUseCapability(role, definition));
}

/**
 * 「操作员和工作区所有者」 / 「操作员或工作区所有者」: who may use `capability`, named with the role
 * labels the rest of the console shows (`lib/status-tone` `ROLE_TONES`), read from the registry
 * instead of written into each sentence (#541 review, legacy 243 ③). `'or'` for "one of them
 * does it", `'and'` for "they can see it".
 */
export function capabilityHolders(
  capability: CapabilityName,
  t: Translate,
  joiner: 'and' | 'or' = 'and',
): string {
  const roles = holderRoles(capability);
  const zh = roles.map((role) => roleLabel(role, t));
  if (roles.length === 0) return t('工作区所有者', 'the workspace owner');
  if (joiner === 'or') {
    return t(
      `${zh.join('、')}或工作区所有者`,
      `${roles.map((role) => withArticle(roleLabel(role, t).toLowerCase())).join(', ')} or the workspace owner`,
    );
  }
  return t(
    `${zh.join('、')}和工作区所有者`,
    `${roles.map((role) => `${roleLabel(role, t).toLowerCase()}s`).join(', ')} and the workspace owner`,
  );
}

function withArticle(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}
