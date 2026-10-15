import { useT } from '../../lib/i18n.js';
import { CopyButton } from '../kit/copy-button.js';
import { Notice } from '../kit/notice.js';

/**
 * components/connect/AskOwnerToEnable (#541 acceptance P3 ①, legacy 242): what a reader who is
 * not the workspace owner sees where enabling a platform gate instance in this workspace would be.
 * Enabling is the owner's (`enable_gate_instance`, `minRole: 'owner'`), and there is no request
 * capability for it yet, so the way forward is a ready-made request the reader copies to the
 * owner — never a bare "owner-only" with nothing to do.
 */
export function AskOwnerToEnable({
  gateName,
  testId,
}: {
  /** The instance in question; omitted for the catalog as a whole. */
  readonly gateName?: string;
  readonly testId?: string;
}) {
  const t = useT();
  const request = gateName
    ? t(
        `请在 NextTime 控制台「系统与授权 → 接入一个系统」里把「${gateName}」在本工作区启用，并授权给我。`,
        `Please enable “${gateName}” in this workspace (NextTime console, Systems & access → Connect a system) and grant it to me.`,
      )
    : t(
        '请在 NextTime 控制台「系统与授权 → 待启用的平台实例」里启用我需要的系统，并授权给我。',
        'Please enable the system I need in this workspace (NextTime console, Systems & access → Platform instances to enable) and grant it to me.',
      );
  return (
    <Notice testId={testId}>
      <span className="stack-s">
        <span>
          {gateName
            ? t(
                `在本工作区启用「${gateName}」由工作区所有者完成。把下面这句发给工作区所有者；启用并授权给你之后，它会出现在你的「系统与授权」里。`,
                `The workspace owner enables “${gateName}” in this workspace. Send them the request below; once it is enabled and granted to you, it shows up under Systems & access.`,
              )
            : t(
                '从平台目录启用由工作区所有者完成。把下面这句发给工作区所有者；启用并授权给你之后，它会出现在你的「系统与授权」里。',
                'The workspace owner enables instances from the platform catalog. Send them the request below; once one is enabled and granted to you, it shows up under Systems & access.',
              )}
        </span>
        <span className="row" style={{ alignItems: 'center' }}>
          <span className="text-2" data-testid={testId ? `${testId}-request` : undefined}>
            {request}
          </span>
          <CopyButton value={request} label={t('给所有者的请求', 'the request')} />
        </span>
      </span>
    </Notice>
  );
}
