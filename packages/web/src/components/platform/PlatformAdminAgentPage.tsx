import type {
  AdminAgentStatusWire,
  AdminAgentStopResultWire,
  AdminAgentTrialWorkspaceWire,
} from '@nexttime/shared';
import { useState } from 'react';
import { invalidateCapability, useCapability } from '../../hooks/useCapability.js';
import { adminAgentRefusalText } from '../../lib/admin-agent.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { hrefs } from '../../lib/router.js';
import { Button, buttonVariants } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue } from '../kit/key-value.js';
import { Notice } from '../kit/notice.js';
import { PageHeader } from '../kit/page-header.js';
import { RouteLink } from '../kit/route-link.js';
import { DashboardCard } from '../kit/section.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { AdminAgentTargetsDialog } from './admin-agent/AdminAgentTargetsDialog.js';
import { sharedTargetsText } from './admin-agent/text.js';

export interface PlatformAdminAgentPageProps {
  readonly http: CapabilityCaller;
  /** Opens 对话 in that trial workspace (switching to it first when it is not the current one):
   *  `open` lands on the reader's latest admin agent Chat there, or a new one; `view` on the list. */
  readonly onOpenChats: (workspaceId: string, mode: 'open' | 'view') => void;
}

/** The reads this page's changes make stale. */
const STALE_READS = ['get_admin_agent_status'] as const;

/**
 * components/platform/PlatformAdminAgentPage: 平台 · 管理员智能体 (`#/platform/admin-agent`, S11
 * AA4c-3; the AA4 plan F3/F4/F10 and the AA4c plan D1, D6, D7). The reader's own admin agent — a
 * platform administrator's, acting only in trial workspaces and changing nothing outside them but
 * by an admin proposal someone else applies — in each trial workspace they are a person in
 * (`get_admin_agent_status`):
 *
 * - whether it may start there, and if not why, in the reader's words (`refusal`); the platform's
 *   switch is the host environment's and only said here, never changed;
 * - 目标工作区: the workspaces it may propose to (`set_admin_agent_targets`) — one choice for every
 *   admin agent Chat of the reader in that trial workspace, which the page says in so many words;
 * - its session, and 停止 (`stop_admin_agent`) there or everywhere;
 * - 打开管理员对话 — switching to the trial workspace.
 *
 * Its model use is counted in the reader's own user budget, as the entry agent's is.
 */
export function PlatformAdminAgentPage({ http, onOpenChats }: PlatformAdminAgentPageProps) {
  const t = useT();
  const status = useCapability<AdminAgentStatusWire>(http, 'get_admin_agent_status');

  async function reload(): Promise<void> {
    for (const name of STALE_READS) invalidateCapability(http, name);
    await status.reload();
  }

  // What the last 停止 did, said on the page (it stays until the next stop or a reload).
  const [stopped, setStopped] = useState<AdminAgentStopResultWire | null>(null);
  function onStopped(result: AdminAgentStopResultWire): void {
    setStopped(result);
    void reload();
  }

  const data = status.state.status === 'ready' ? status.state.data : null;
  const withSession = data?.workspaces.filter((workspace) => workspace.session !== null) ?? [];

  return (
    <div className="page" data-testid="platform-admin-agent-page">
      <PageHeader
        title={t('管理员智能体', 'Admin agent')}
        description={t(
          '你自己的管理员智能体：它只在试验工作区里替你试做改动，做好后向你选的目标工作区提出管理员提案；平台部分在「管理员提案」里审阅，工作区部分由各工作区的所有者决定。它用的模型额度算在你的用户预算里，和入口智能体一样。',
          'Your own admin agent: it tries changes out for you in trial workspaces only, then makes an admin proposal to the target workspaces you choose; its platform part is reviewed in Admin proposals, and each workspace part is decided by that workspace’s owner. Its model use counts towards your own user budget, as the entry agent’s does.',
        )}
        breadcrumb={breadcrumbFor('platformAdminAgent')}
        actions={
          <>
            <Button variant="ghost" onClick={() => void reload()} data-testid="admin-agent-refresh">
              {t('刷新', 'Refresh')}
            </Button>
            {withSession.length > 1 ? (
              <StopAdminAgent http={http} workspace={null} onStopped={onStopped} />
            ) : null}
          </>
        }
      />

      {status.state.status === 'loading' ? (
        <SkeletonRows count={3} label={t('正在读取管理员智能体…', 'Loading the admin agent')} />
      ) : status.state.status === 'error' ? (
        <ErrorBanner
          error={status.state.error}
          title={t('读不到管理员智能体', 'Could not read the admin agent')}
          onRetry={() => void status.reload()}
          testId="admin-agent-error"
        />
      ) : data !== null ? (
        <div className="stack">
          {stopped !== null ? (
            <Notice testId="admin-agent-stopped">
              {t(
                `管理员智能体已停止：吊销了 ${stopped.revokedSessions} 个会话，停下了 ${stopped.stoppedTurns} 轮。对话都还在，之后再发消息会开一个新会话。`,
                `The admin agent is stopped: ${stopped.revokedSessions} session(s) revoked, ${stopped.stoppedTurns} turn(s) stopped. The chats stay; the next message opens a new session.`,
              )}
            </Notice>
          ) : null}
          {data.enabled ? null : (
            <Notice tone="warn" testId="admin-agent-switched-off">
              {adminAgentRefusalText('switched_off', t)}
            </Notice>
          )}
          {data.workspaces.length === 0 ? (
            <EmptyState
              title={t('你还不在任何试验工作区里', 'You are not in any trial workspace yet')}
              body={t(
                '管理员智能体只在试验工作区里运行：先新建一个试验工作区（你是它的第一位所有者），再回到这里选目标工作区、打开管理员对话。',
                'The admin agent runs only in trial workspaces: create one first (you are its first owner), then come back here to choose its targets and open an admin agent chat.',
              )}
              action={
                <RouteLink
                  href={hrefs.platformWorkspacesCreate('admin_trial')}
                  className={buttonVariants({ variant: 'primary' })}
                  testId="admin-agent-create-trial"
                >
                  {t('新建试验工作区', 'Create a trial workspace')}
                </RouteLink>
              }
              testId="admin-agent-no-trial-workspace"
            />
          ) : (
            data.workspaces.map((workspace) => (
              <TrialWorkspaceCard
                key={workspace.workspaceId}
                http={http}
                workspace={workspace}
                onChanged={() => void reload()}
                onStopped={onStopped}
                onOpenChats={onOpenChats}
              />
            ))
          )}
          <p className="text-3" data-testid="admin-agent-proposals-link">
            {t('它提出的管理员提案在', 'The admin proposals it makes are in')}{' '}
            <RouteLink href={hrefs.platformAdminProposals()}>
              {t('平台 · 管理员提案', 'Platform · Admin proposals')}
            </RouteLink>
            {t('。', '.')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TrialWorkspaceCard({
  http,
  workspace,
  onChanged,
  onStopped,
  onOpenChats,
}: {
  readonly http: CapabilityCaller;
  readonly workspace: AdminAgentTrialWorkspaceWire;
  readonly onChanged: () => void;
  readonly onStopped: (result: AdminAgentStopResultWire) => void;
  readonly onOpenChats: (workspaceId: string, mode: 'open' | 'view') => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const { refusal } = workspace;
  // The switch being off is said once for the page; any other reason is this workspace's own.
  const ownRefusal = refusal !== null && refusal !== 'switched_off' ? refusal : null;
  // Its Chats can still be read with the switch off; every other reason refuses reading too.
  const readable = refusal === null || refusal === 'switched_off';

  return (
    <DashboardCard
      data-testid="admin-agent-workspace"
      data-workspace-id={workspace.workspaceId}
      title={
        <span className="row-wrap">
          <span>{workspace.name}</span>
          <StatusChip machine="workspacePurpose" status="admin_trial" size="s" />
        </span>
      }
      actions={
        refusal === null ? (
          <Button
            variant="primary"
            size="s"
            onClick={() => onOpenChats(workspace.workspaceId, 'open')}
            data-testid="admin-agent-open-chat"
          >
            {t('打开管理员对话', 'Open the admin agent chat')}
          </Button>
        ) : readable ? (
          <Button
            size="s"
            onClick={() => onOpenChats(workspace.workspaceId, 'view')}
            data-testid="admin-agent-view-chats"
          >
            {t('查看管理员对话', 'View admin agent chats')}
          </Button>
        ) : null
      }
    >
      <div className="stack">
        {ownRefusal !== null ? (
          <Notice tone="warn" testId="admin-agent-refusal">
            {t('管理员智能体不能在这里开始：', 'The admin agent cannot start here: ')}
            {adminAgentRefusalText(ownRefusal, t)}
          </Notice>
        ) : null}

        <section className="stack-s" data-testid="admin-agent-targets">
          <div className="row">
            <h3 className="grow text-13 font-semibold">{t('目标工作区', 'Target workspaces')}</h3>
            {readable ? (
              <Button
                size="s"
                onClick={() => setEditing(true)}
                data-testid="admin-agent-choose-targets"
              >
                {t('选择目标工作区', 'Choose target workspaces')}
              </Button>
            ) : null}
          </div>
          <p className="text-3">{sharedTargetsText(t)}</p>
          {workspace.targets.length === 0 ? (
            <p className="text-3" data-testid="admin-agent-no-targets">
              {t(
                '还没有选目标工作区：管理员智能体现在不能向任何工作区提出管理员提案。',
                'No target workspaces yet: the admin agent cannot make an admin proposal to any workspace.',
              )}
            </p>
          ) : (
            <ul className="stack-s" aria-label={t('目标工作区', 'Target workspaces')}>
              {workspace.targets.map((target) => (
                <li
                  key={target.workspaceId}
                  className="row-wrap"
                  data-testid="admin-agent-target"
                  data-workspace-id={target.workspaceId}
                >
                  <span>{target.name}</span>
                  {target.status === 'disabled' ? (
                    <>
                      <StatusChip machine="workspaceStatus" status="disabled" size="s" />
                      <span className="text-3">
                        {t('已停用，向它提议会被拒绝', 'disabled; proposing to it is refused')}
                      </span>
                    </>
                  ) : null}
                  <span className="text-3" title={formatDateTime(target.chosenAt)}>
                    {t('选于', 'chosen')} {formatRelative(target.chosenAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="stack-s" data-testid="admin-agent-session">
          <div className="row">
            <h3 className="grow text-13 font-semibold">{t('会话', 'Session')}</h3>
            {workspace.session !== null ? (
              <StopAdminAgent http={http} workspace={workspace} onStopped={onStopped} />
            ) : null}
          </div>
          {workspace.session !== null ? (
            <KeyValue
              items={[
                {
                  key: 'started',
                  label: t('开始于', 'Started'),
                  value: formatDateTime(workspace.session.startedAt),
                },
                {
                  key: 'expires',
                  label: t('到期', 'Expires'),
                  value:
                    workspace.session.expiresAt === null
                      ? t('不会自动到期', 'Does not expire on its own')
                      : formatDateTime(workspace.session.expiresAt),
                },
              ]}
            />
          ) : (
            <p className="text-3" data-testid="admin-agent-no-session">
              {t(
                '现在没有在用的会话。在管理员对话里发一条消息，就会开一个新会话。',
                'No session is open now. Sending a message in an admin agent chat opens a new one.',
              )}
            </p>
          )}
        </section>
      </div>

      <AdminAgentTargetsDialog
        http={http}
        workspace={editing ? workspace : null}
        onClose={() => setEditing(false)}
        onSaved={onChanged}
      />
    </DashboardCard>
  );
}

/** 停止 — in one trial workspace (`workspace`), or everywhere (`null`). */
function StopAdminAgent({
  http,
  workspace,
  onStopped,
}: {
  readonly http: CapabilityCaller;
  readonly workspace: AdminAgentTrialWorkspaceWire | null;
  readonly onStopped: (result: AdminAgentStopResultWire) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const all = workspace === null;
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      danger
      testId={all ? 'admin-agent-stop-all-confirm' : 'admin-agent-stop-confirm'}
      anchor={
        <Button
          variant="danger"
          size="s"
          onClick={() => setOpen(true)}
          data-testid={all ? 'admin-agent-stop-all' : 'admin-agent-stop'}
        >
          {all ? t('全部停止', 'Stop everywhere') : t('停止', 'Stop')}
        </Button>
      }
      title={
        all
          ? t(
              '在所有试验工作区停止管理员智能体？',
              'Stop the admin agent in every trial workspace?',
            )
          : t('在这个试验工作区停止管理员智能体？', 'Stop the admin agent in this trial workspace?')
      }
      {...(workspace !== null ? { target: workspace.name } : {})}
      impact={[
        t(
          '它的会话和 Handle 立刻吊销，管理员对话里正在跑的这一轮会停下。',
          'Its session and Handle are revoked at once, and a running turn in an admin agent chat stops.',
        ),
        t(
          '对话都还在；之后再发消息，会开一个新会话。',
          'The chats stay; the next message opens a new session.',
        ),
        t('已经提出的管理员提案不受影响。', 'Admin proposals it already made are not affected.'),
      ]}
      confirmLabel={t('停止', 'Stop')}
      onConfirm={async () => {
        const result = await http.call<AdminAgentStopResultWire>(
          'stop_admin_agent',
          workspace !== null ? { trialWorkspaceId: workspace.workspaceId } : {},
        );
        onStopped(result);
      }}
    />
  );
}
