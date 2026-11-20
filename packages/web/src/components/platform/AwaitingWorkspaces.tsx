import type { GateInstanceWire } from '@nexttime/shared';
import { sentenceGap, useT } from '../../lib/i18n.js';
import { Notice } from '../kit/notice.js';

type Translate = ReturnType<typeof useT>;

/** Legacy 223: how many workspaces still publish another definition than the one this platform
 *  gate instance runs for some of its Operations — the kernel's uncut count, else the listed
 *  ones (`awaitingWorkspaces`), else 0 (a kernel that predates the field). */
export function awaitingWorkspaceCount(instance: GateInstanceWire): number {
  return instance.awaitingWorkspaceCount ?? instance.awaitingWorkspaces?.length ?? 0;
}

/** The list badge for an instance some workspaces have not aligned with yet. */
export function awaitingWorkspacesBadge(count: number, t: Translate): string {
  return t(`${count} 个工作区待对齐 · 调用被拒`, `${count} workspace(s) to align · calls refused`);
}

/** The platform overview's 需要人处理 line for such an instance. */
export function awaitingWorkspacesTitle(instance: GateInstanceWire, t: Translate): string {
  const count = awaitingWorkspaceCount(instance);
  return t(
    `门「${instance.displayName}」：${count} 个工作区还没按生效的清单对齐，门正拒绝它们的部分调用`,
    `Gate "${instance.displayName}": ${count} workspace(s) have not aligned with the manifest in effect; the gate is refusing some of their calls`,
  );
}

/**
 * platform/AwaitingWorkspaces (legacy 223, console half): on a platform gate instance, the
 * workspaces whose calls to some of its Operations the gate refuses because they still publish
 * another definition than the manifest in effect — after the platform adopted it, until each
 * workspace aligns (「与门公告对齐」 in 系统与授权) and publishes the revisions in its catalog.
 * Names only (the kernel never sends a workspace's definitions or drafts to the platform plane),
 * as many as the kernel lists, and how many more it did not. Only a workspace owner can align;
 * the notice says so, so the administrator knows to tell them rather than look for a button here.
 * Renders nothing when no workspace awaits (or the kernel predates the field).
 */
export function AwaitingWorkspaces({ instance }: { readonly instance: GateInstanceWire }) {
  const t = useT();
  const count = awaitingWorkspaceCount(instance);
  if (count === 0) return null;
  const listed = instance.awaitingWorkspaces ?? [];
  const unlisted = count - listed.length;
  return (
    <Notice tone="warn" testId="gate-instance-awaiting-workspaces">
      <div className="stack-s">
        <strong>
          {t(
            `${count} 个工作区还没对齐，门正拒绝它们对下列 Operation 的调用`,
            `${count} workspace(s) have not aligned; the gate is refusing their calls to the Operations below`,
          )}
        </strong>
        <span>
          {[
            t(
              '这些工作区在自己的能力目录里发布的还是和门现在运行的清单不同的定义。',
              'In their own catalogs these workspaces still publish another definition than the manifest the gate now runs.',
            ),
            t(
              '要工作区所有者到「系统与授权」打开这个系统，点「与门公告对齐」，再到「能力目录」发布打开的修订，调用才会恢复。平台这里替不了他们，请通知各工作区的所有者。',
              "Their calls resume once a workspace owner opens this system in Systems & access, clicks Align with the gate's announcement, and publishes the revisions it opens in the catalog. The platform cannot do this for them; let each workspace's owner know.",
            ),
          ].join(sentenceGap(t))}
        </span>
        {listed.length > 0 ? (
          <ul data-testid="gate-instance-awaiting-workspace-list">
            {listed.map((workspace) => (
              <li
                key={workspace.id}
                data-testid="gate-instance-awaiting-workspace"
                data-workspace-id={workspace.id}
              >
                <span>{workspace.name}</span>
                {t('：', ': ')}
                <span className="mono">{workspace.operations.join(t('、', ', '))}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {unlisted > 0 ? (
          <span className="text-3 text-small" data-testid="gate-instance-awaiting-unlisted">
            {t(`另有 ${unlisted} 个工作区未列出。`, `${unlisted} more workspace(s) not shown.`)}
          </span>
        ) : null}
      </div>
    </Notice>
  );
}
