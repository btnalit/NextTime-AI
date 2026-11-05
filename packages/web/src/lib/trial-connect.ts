import type { Translate } from './i18n.js';

/**
 * lib/trial-connect (S11 AA5b): how the console says the one exception a trial workspace makes to
 * the connector modes (R-40) — the kernel's rule is `application/admin-agent/trial.ts`
 * (AA5a-1, the AA5 plan's F1). In a trial workspace an `http` or `mcp` connection passes a
 * `platform_preset` connector when a platform administrator asks for it and completes it; a
 * `disabled` connector it never passes, and every pass leaves its own audit row
 * (`connection.trial_self_connect`).
 *
 * A workspace owner who is not a platform administrator cannot read the connectors' modes
 * (`list_connectors` is platform-scoped), so what such a reader is told is said conditionally
 * rather than guessed.
 */

/** The connection kinds the exception covers — the generic connectors that can be presets. */
export const TRIAL_SELF_CONNECT_KINDS: ReadonlySet<string> = new Set(['http', 'mcp']);

/** Whether a connection request of `kind` in this workspace falls under the exception at all. */
export function trialSelfConnectApplies(trialWorkspace: boolean, kind: string): boolean {
  return trialWorkspace && TRIAL_SELF_CONNECT_KINDS.has(kind);
}

/** The note on a trial workspace's open request card, for an owner who is not a platform
 *  administrator: who completes it while the platform provides the kind as a preset. */
export function trialRequestNeedsPlatformAdminNote(t: Translate): string {
  return t(
    '试验工作区：平台把这一类系统设为「平台预置」时，只有平台管理员能完成这个连接。',
    'Trial workspace: while the platform provides this kind of system as a preset, only a platform administrator can complete this connection.',
  );
}

/** `connector_not_self_serve` when completing a connection in a trial workspace — what the
 *  refusal means there, by who was refused. */
export function trialConnectorRefusal(platformAdmin: boolean, t: Translate): string {
  return platformAdmin
    ? t(
        '平台禁用了这一类系统，试验工作区也不能自己接入，什么也没有保存。到「平台 → 集成」的「接入包」把它改成「可自连」或「平台预置」，再回来完成。',
        'The platform has switched this kind of system off, so a trial workspace cannot connect it either, and nothing was saved. Under Platform → Integrations → Connectors, set it to self-serve or platform preset, then come back to complete it.',
      )
    : t(
        '平台目前不允许工作区自己接入这一类系统，什么也没有保存。在试验工作区里，平台预置的这类系统要由平台管理员来完成连接；平台禁用的，谁都接不了。请平台管理员来完成它。',
        'The platform does not let a workspace connect this kind of system itself right now, and nothing was saved. In a trial workspace a platform administrator completes a connection the platform provides as a preset; one it switched off nobody can connect. Ask a platform administrator to complete it.',
      );
}
