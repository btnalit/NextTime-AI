import type { AdminAgentStatusWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';

/**
 * components/chat/AdminAgentTargetsHint (S11 AA4e, UX P3-1 on #945): above an admin agent chat's
 * composer, while this trial workspace has no target workspaces chosen — before the reader asks it
 * to propose and the Turn fails for it. Read from `get_admin_agent_status` (the reader's own, which
 * the 管理员智能体 page also reads and its targets dialog invalidates); nothing while it loads, fails,
 * or when the agent cannot start here at all (the page says why), and nothing once a target is
 * chosen. 去选择 opens this trial workspace's 选择目标工作区 there.
 */
export function AdminAgentTargetsHint({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const { workspaceId } = useWorkspaceIdentity(http);
  const status = useCapability<AdminAgentStatusWire>(http, 'get_admin_agent_status');
  if (workspaceId === null || status.state.status !== 'ready') return null;
  const here = status.state.data.workspaces.find((w) => w.workspaceId === workspaceId);
  if (here === undefined || here.refusal !== null || here.targets.length > 0) return null;
  return (
    <Notice tone="warn" testId="chat-admin-agent-no-targets">
      {t(
        '还没有选目标工作区：管理员智能体现在不能提出管理员提案。',
        'No target workspaces chosen yet: the admin agent cannot make an admin proposal now.',
      )}{' '}
      <RouteLink
        href={hrefs.platformAdminAgent(workspaceId, { targets: true })}
        testId="chat-admin-agent-choose-targets"
      >
        {t('去选择', 'Choose them')}
      </RouteLink>
    </Notice>
  );
}
