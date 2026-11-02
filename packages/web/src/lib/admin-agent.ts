import { ADMIN_AGENT_REFUSAL_REASON_VALUES, type AdminAgentRefusalReason } from '@nexttime/shared';
import type { ErrorOverrides } from './errors.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * lib/admin-agent (S11 AA4c-3; the AA4 plan F3, F10-1 and the AA4c plan D7): the console's copy
 * for a platform administrator's 管理员智能体 — why it cannot start in a trial workspace
 * (`get_admin_agent_status`'s `refusal`, and `new_chat`'s 403 `admin_agent_refused`
 * `details.reason`), worded for the person it is about. Keyed by the shared
 * `AdminAgentRefusalReason`, so a reason added there does not compile until it has its sentence.
 *
 * The switch is the deployment's: the copy says where it is, never names the setting (as
 * `platform-errors.ts` does for the platform administrators list).
 */
export const ADMIN_AGENT_REFUSAL_TEXT: Readonly<
  Record<AdminAgentRefusalReason, { readonly zh: string; readonly en: string }>
> = {
  switched_off: {
    zh: '平台没有开启管理员智能体，需要维护者在主机环境里打开。已有的管理员对话照常能读。',
    en: 'The platform has not switched the admin agent on; a maintainer turns it on in the host environment. Existing admin agent chats can still be read.',
  },
  unknown_principal: {
    zh: '你不是这个工作区的成员。',
    en: 'You are not a member of this workspace.',
  },
  not_a_person: {
    zh: '只有人能使用管理员智能体，智能体或服务身份不能。',
    en: 'Only a person can use the admin agent, not an agent or a service identity.',
  },
  no_platform_user: {
    zh: '你在这个工作区的成员身份没有绑定平台用户。请平台管理员在「平台 → 用户」里绑定。',
    en: 'Your membership here is not bound to a platform user. Ask a platform administrator to bind it in Platform → Users.',
  },
  principal_disabled: {
    zh: '你在这个工作区的成员身份已被停用。',
    en: 'Your membership in this workspace is disabled.',
  },
  user_disabled: {
    zh: '你的平台账号已被停用。',
    en: 'Your platform account is disabled.',
  },
  workspace_disabled: {
    zh: '这个试验工作区已停用。',
    en: 'This trial workspace is disabled.',
  },
  not_trial_workspace: {
    zh: '管理员智能体只在试验工作区里运行，这个工作区不是试验工作区。',
    en: 'The admin agent runs only in trial workspaces, and this workspace is not one.',
  },
  not_platform_admin: {
    zh: '你现在不是平台管理员。',
    en: 'You are no longer a platform administrator.',
  },
  user_changed: {
    zh: '你的成员身份刚刚绑定到了另一个平台用户。刷新后再试。',
    en: 'Your membership was just bound to another platform user. Refresh and retry.',
  },
};

/** Why the admin agent cannot start, in the reader's language. */
export function adminAgentRefusalText(reason: AdminAgentRefusalReason, t: Translate): string {
  const entry = ADMIN_AGENT_REFUSAL_TEXT[reason];
  return t(entry.zh, entry.en);
}

function isRefusalReason(value: unknown): value is AdminAgentRefusalReason {
  return (
    typeof value === 'string' &&
    (ADMIN_AGENT_REFUSAL_REASON_VALUES as readonly string[]).includes(value)
  );
}

/** `admin_agent_refused`'s sentence from its `details.reason`, else `null` (`presentError`). */
export function adminAgentRefusalMessage(err: unknown, t: Translate): string | null {
  if (!(err instanceof HttpError) || err.code !== 'admin_agent_refused') return null;
  const reason = err.details?.reason;
  return isRefusalReason(reason) ? adminAgentRefusalText(reason, t) : null;
}

/** What `set_admin_agent_targets` refuses with, said for the targets dialog (an `InlineError`'s
 *  `overrides`): each says that nothing changed and what to do. */
export function adminAgentTargetsErrorOverrides(t: Translate): ErrorOverrides {
  return {
    admin_role_not_stored: t(
      '你的平台管理员身份只来自部署配置，没有存进平台，所以还不能选目标工作区。请另一位平台管理员在「平台 → 用户」里把你设为平台管理员，再回来选。',
      'Your platform administrator role comes only from the deployment’s configuration and is not stored on the platform, so you cannot choose targets yet. Ask another platform administrator to make you one in Platform → Users, then come back.',
    ),
    not_found: t(
      '你已经不在这个试验工作区里了，什么也没改。刷新页面看看现在的样子。',
      'You are no longer in this trial workspace; nothing changed. Refresh to see how things stand.',
    ),
    invalid_params: t(
      '选中的工作区里有的已经停用、被删除或成了试验工作区，什么也没改。刷新列表后重新选。',
      'Some of the chosen workspaces are disabled, gone or trial workspaces now; nothing changed. Refresh the list and choose again.',
    ),
  };
}
