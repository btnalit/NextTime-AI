import type { PlatformUpdatesWire } from '@nexttime/shared';
import { useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import {
  type FeedInvalidNotice,
  type FeedStaleNotice,
  type PiIncompatibleNotice,
  type PiPendingNotice,
  type PlatformReleaseNotice,
  type UpdateNotice,
  buildUpdateNotices,
  readDismissedKeys,
  withDismissedKey,
  writeDismissedKeys,
} from '../../lib/platform-updates.js';
import { Button } from '../kit/button.js';

export interface UpdateReminderProps {
  readonly http: CapabilityCaller;
}

/**
 * components/platform/UpdateReminder (S10 U1, docs/s10-evolution-plan-2026-10-04.md §4.2 ⑤): the
 * reminder banner at the top of 概览 Overview — a newer platform release (with the exact command
 * and checklist to run on the host), an upstream pi that is waiting for a release or does not fit,
 * and a stale / rejected version feed. Every notice has a 「知道了」 button that hides it for that
 * version only (`lib/platform-updates`' dismissal keys), so a newer version or a changed feed
 * state shows again.
 *
 * Its own `platform_updates` read: a loading or failed read renders nothing — the overview never
 * waits on, or shows an error for, a reminder. There is deliberately no upgrade button (decisions
 * 2 and 3): the console only says what to run.
 */
export function UpdateReminder({ http }: UpdateReminderProps) {
  const updates = useCapability<PlatformUpdatesWire>(http, 'platform_updates');
  const [dismissed, setDismissed] = useState<readonly string[]>(() => readDismissedKeys());

  if (updates.state.status !== 'ready') return null;
  const visible = buildUpdateNotices(updates.state.data).filter(
    (notice) => !dismissed.includes(notice.key),
  );
  if (visible.length === 0) return null;

  function dismiss(key: string): void {
    // Merge with what other tabs stored since this one loaded, then remember it for this view too.
    const next = withDismissedKey([...readDismissedKeys(), ...dismissed], key);
    writeDismissedKeys(next);
    setDismissed(next);
  }

  return (
    <div className="stack-s" data-testid="update-reminder">
      {visible.map((notice) => (
        <NoticeBox key={notice.key} notice={notice} onDismiss={() => dismiss(notice.key)} />
      ))}
    </div>
  );
}

function NoticeBox({
  notice,
  onDismiss,
}: {
  readonly notice: UpdateNotice;
  readonly onDismiss: () => void;
}) {
  const t = useT();
  const toneClass =
    notice.tone === 'danger'
      ? ' notice-danger'
      : notice.tone === 'warn'
        ? ' notice-warn'
        : ' notice-info';
  return (
    <div
      className={`notice update-notice${toneClass}`}
      data-testid={`update-notice-${notice.kind}`}
    >
      <div className="grow stack-s">
        <NoticeBody notice={notice} />
      </div>
      <Button
        variant="ghost"
        size="s"
        onClick={onDismiss}
        data-testid={`update-notice-${notice.kind}-dismiss`}
      >
        {t('知道了', 'Got it')}
      </Button>
    </div>
  );
}

function NoticeBody({ notice }: { readonly notice: UpdateNotice }) {
  switch (notice.kind) {
    case 'platform':
      return <PlatformReleaseBody notice={notice} />;
    case 'pi-pending':
      return <PiPendingBody notice={notice} />;
    case 'pi-incompatible':
      return <PiIncompatibleBody notice={notice} />;
    case 'feed-invalid':
      return <FeedInvalidBody notice={notice} />;
    case 'feed-stale':
      return <FeedStaleBody notice={notice} />;
  }
}

function ExternalLink({
  href,
  testId,
  children,
}: {
  readonly href: string;
  readonly testId: string;
  readonly children: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" data-testid={testId}>
      {children}
    </a>
  );
}

function PlatformReleaseBody({ notice }: { readonly notice: PlatformReleaseNotice }) {
  const t = useT();
  const { migrations } = notice;
  const facts = [
    notice.piVersion !== null
      ? t(`内置 pi ${notice.piVersion}`, `bundles pi ${notice.piVersion}`)
      : null,
    migrations.length === 0
      ? t('无迁移', 'no migrations')
      : migrations.length <= 3
        ? t(`迁移 ${migrations.join('、')}`, `migrations ${migrations.join(', ')}`)
        : t(
            `迁移 ${migrations[0]} 等 ${migrations.length} 项`,
            `${migrations.length} migrations from ${migrations[0]}`,
          ),
    notice.breaking
      ? t('含 breaking 变更', 'includes breaking changes')
      : t('非 breaking', 'not breaking'),
  ].filter((fact): fact is string => fact !== null);

  return (
    <>
      <strong className="update-notice-title" data-testid="update-notice-platform-title">
        {notice.releaseCount > 1
          ? t(
              `${notice.latestVersion} 可用（跨 ${notice.releaseCount} 个发版）`,
              `${notice.latestVersion} available (spans ${notice.releaseCount} releases)`,
            )
          : t(`${notice.latestVersion} 可用`, `${notice.latestVersion} available`)}
      </strong>
      <span data-testid="update-notice-platform-facts">{facts.join(' · ')}</span>
      {notice.notesUrl !== null ? (
        <span>
          <ExternalLink href={notice.notesUrl} testId="update-notice-platform-link">
            {t('发版说明', 'Release notes')}
          </ExternalLink>
        </span>
      ) : null}
      <details className="disclosure" data-testid="update-notice-platform-steps">
        <summary>{t('升级步骤', 'Upgrade steps')}</summary>
        <div className="disclosure-body">
          <ol className="stack-s">
            <li>
              {t(
                '在主机的项目目录执行下面这条命令（脚本会先备份，再验证并拉取已签名的镜像、迁移、启动并跑验收）：',
                'Run this in the project directory on the host (the script backs up first, then verifies and pulls the signed images, migrates, starts and runs acceptance):',
              )}
              {notice.applyCommand !== null ? (
                <div>
                  <code className="mono" data-testid="update-notice-platform-command">
                    {notice.applyCommand}
                  </code>
                </div>
              ) : (
                <div className="text-3">
                  {t(
                    '（内核没有给出命令——请按发版说明操作）',
                    '(the kernel gave no command — follow the release notes)',
                  )}
                </div>
              )}
            </li>
            <li data-testid="update-notice-platform-migrations">
              {migrations.length === 0
                ? t('本次升级不跨迁移。', 'This upgrade crosses no migrations.')
                : t(
                    `本次升级会跨越这些迁移：${migrations.join('、')}。`,
                    `This upgrade crosses these migrations: ${migrations.join(', ')}.`,
                  )}
            </li>
            {notice.breaking ? (
              <li>
                {t(
                  '含 breaking 变更：升级前先读完发版说明。',
                  'It includes breaking changes: read the release notes before upgrading.',
                )}
              </li>
            ) : null}
            <li data-testid="update-notice-platform-rollback">
              {notice.rollbackVersion !== null
                ? t(
                    `回滚目标：${notice.rollbackVersion}（步骤见 docs/runbooks/release.md §5）。`,
                    `Rollback target: ${notice.rollbackVersion} (steps in docs/runbooks/release.md §5).`,
                  )
                : t(
                    '回滚步骤见 docs/runbooks/release.md §5。',
                    'Rollback steps are in docs/runbooks/release.md §5.',
                  )}
            </li>
          </ol>
        </div>
      </details>
    </>
  );
}

function PiPendingBody({ notice }: { readonly notice: PiPendingNotice }) {
  const t = useT();
  return (
    <>
      <strong className="update-notice-title">
        {t(
          `pi ${notice.upstreamLatest} 可用，兼容性初查通过，等待平台发版`,
          `pi ${notice.upstreamLatest} is available — initial compatibility check passed, awaiting a platform release`,
        )}
      </strong>
      <span>
        {t(
          'SDK 套件已通过；docs/runbooks/pi-upgrade.md §2 的人工核对项还没做。',
          'The SDK suite passed; the manual checks in docs/runbooks/pi-upgrade.md §2 are still to do.',
        )}
      </span>
      {notice.runUrl !== null ? (
        <span>
          <ExternalLink href={notice.runUrl} testId="update-notice-pi-pending-link">
            {t('检查记录', 'Check run')}
          </ExternalLink>
        </span>
      ) : null}
    </>
  );
}

function PiIncompatibleBody({ notice }: { readonly notice: PiIncompatibleNotice }) {
  const t = useT();
  return (
    <>
      <strong className="update-notice-title">
        {t(
          `pi ${notice.upstreamLatest} 与本平台不兼容，暂不可升`,
          `pi ${notice.upstreamLatest} is incompatible with this platform — cannot upgrade yet`,
        )}
      </strong>
      {notice.failureSummary !== null && notice.failureSummary !== '' ? (
        <span data-testid="update-notice-pi-incompatible-summary">{notice.failureSummary}</span>
      ) : null}
      {notice.runUrl !== null ? (
        <span>
          <ExternalLink href={notice.runUrl} testId="update-notice-pi-incompatible-link">
            {t('检查记录', 'Check run')}
          </ExternalLink>
        </span>
      ) : null}
    </>
  );
}

function FeedStaleBody({ notice }: { readonly notice: FeedStaleNotice }) {
  const t = useT();
  const { age } = notice;
  return (
    <>
      <strong className="update-notice-title" data-testid="update-notice-feed-stale-title">
        {age === null
          ? t('版本信息已陈旧', 'Version information is out of date')
          : age.unit === 'day'
            ? t(
                `版本信息已 ${age.value} 天未更新`,
                `Version information not updated for ${age.value} day(s)`,
              )
            : t(
                `版本信息已 ${age.value} 小时未更新`,
                `Version information not updated for ${age.value} hour(s)`,
              )}
      </strong>
      <span>
        {t(
          '可能是主机取不到 GitHub——请在主机上查看 update-feed 服务的日志。',
          "The host may be unable to reach GitHub — check the update-feed service's logs on the host.",
        )}
      </span>
    </>
  );
}

function FeedInvalidBody({ notice }: { readonly notice: FeedInvalidNotice }) {
  const t = useT();
  return (
    <>
      <strong className="update-notice-title">
        {t('版本信息异常', 'Version information is invalid')}
      </strong>
      <span>
        {t(
          '内核拒绝了下载到的版本记录，暂时不会据此提醒升级。',
          'The kernel rejected the downloaded version record, so no upgrade reminders are shown from it for now.',
        )}
      </span>
      <details className="disclosure">
        <summary>{t('技术细节', 'Technical details')}</summary>
        <div className="disclosure-body">
          <p className="text-3 text-small" data-testid="update-notice-feed-invalid-detail">
            {notice.detail}
          </p>
        </div>
      </details>
    </>
  );
}
