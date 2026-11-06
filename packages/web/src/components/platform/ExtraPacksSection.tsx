import type { ExtraPacksWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { DashboardCard } from '../kit/section.js';
import { SkeletonRows } from '../kit/skeleton.js';

/**
 * components/platform/ExtraPacksSection (S11 AA5d-3): the packs this deployment adds beside the
 * image's (`extra_packs_status`, the host's `config/packs/`, docs/runbooks/operations.md §14.10),
 * on the platform's 模块 page — those read, and those left out with the rule each breaks. A pack
 * left out is otherwise only in the kernel's log: every workspace's 能力包 tab simply does not list
 * it. The kernel reads the directory on every call, so 重新读取 shows a fix as soon as it is made.
 * Extra packs are never modules: nothing here sets a default.
 */
export function ExtraPacksSection({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const status = useCapability<ExtraPacksWire>(http, 'extra_packs_status');

  const reload = (
    <Button
      variant="ghost"
      size="s"
      onClick={() => void status.reload()}
      disabled={status.state.status === 'loading'}
      data-testid="extra-packs-reload"
    >
      {t('重新读取', 'Read again')}
    </Button>
  );

  return (
    <DashboardCard
      title={t('本部署附加的能力包', 'Extra packs of this deployment')}
      actions={reload}
      data-testid="extra-packs"
    >
      <div className="stack-s">
        <p className="text-3 text-small">
          {t(
            '放在主机 config/packs/ 里的能力包，比如由管理员提案导出的包。工作区所有者在「能力目录 · 能力包」里看到它们（标着「本部署附加」），像其他能力包一样审阅和安装。它们不是模块，不能设成默认安装。内核每次都重新读这个目录，改好文件后点「重新读取」就能看到。',
            'Packs in the host’s config/packs/, such as one exported from an admin proposal. Workspace owners find them under Catalog · Packs (marked Added by this deployment), and review and install them like any pack. They are never modules, so none is installed by default. The kernel reads the directory on every call: once a file is fixed, Read again shows it.',
          )}
        </p>
        {status.state.status === 'loading' ? (
          <SkeletonRows count={2} label={t('正在读取附加能力包…', 'Reading extra packs')} />
        ) : status.state.status === 'error' ? (
          <ErrorBanner
            error={status.state.error}
            title={t('无法读取附加能力包', 'Could not read the extra packs')}
            onRetry={() => void status.reload()}
            testId="extra-packs-error"
          />
        ) : (
          <ExtraPacksBody status={status.state.data} />
        )}
      </div>
    </DashboardCard>
  );
}

function ExtraPacksBody({ status }: { readonly status: ExtraPacksWire }) {
  const t = useT();
  if (!status.configured) {
    return (
      <Notice testId="extra-packs-not-configured">
        {t(
          '内核没有设置附加能力包目录（compose 里 kernel 的 EXTRA_PACKS_DIR），所以只有镜像自带的能力包。用标准的 compose 部署，并按 operations.md §14.10 在主机上建好 config/packs/。',
          'The kernel has no extra packs directory set (EXTRA_PACKS_DIR on the kernel in compose), so only the packs its image ships are here. Deploy with the standard compose and make config/packs/ on the host as operations.md §14.10 says.',
        )}
      </Notice>
    );
  }
  return (
    <div className="stack-s">
      {status.unreadable !== null ? (
        <Notice tone="warn" testId="extra-packs-unreadable">
          <span className="wrap-anywhere">
            {t(
              '目录在，但读不了，所以一个附加包也没读进来：',
              'The directory is there but cannot be read, so no extra pack is read: ',
            )}
            {status.unreadable}
          </span>
        </Notice>
      ) : null}
      {status.packs.length === 0 ? (
        status.unreadable === null ? (
          <p className="text-small" data-testid="extra-packs-none">
            {t('目录里还没有能力包。', 'The directory holds no pack yet.')}
          </p>
        ) : null
      ) : (
        <ul className="stack-s extra-packs-list" data-testid="extra-packs-list">
          {status.packs.map((pack) => (
            <li key={pack.name} className="row-wrap" data-testid={`extra-pack-${pack.name}`}>
              <span className="mono">{pack.name}</span>
              <span className="tag tabular">v{pack.latestVersion}</span>
              {pack.summary ? <span className="text-2 wrap-anywhere">{pack.summary}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {status.skipped.length > 0 ? (
        <div className="stack-s" data-testid="extra-packs-skipped">
          <Notice tone="warn">
            {t(
              `有 ${status.skipped.length} 个目录没有当成能力包读进来，工作区里看不到它们。下面是各自违反的规则；依赖了被丢掉的包的，也一起丢掉。`,
              `${status.skipped.length} director(ies) are not read as packs, and no workspace sees them. Below is the rule each breaks; a pack building on one left out is left out too.`,
            )}
          </Notice>
          <ul className="stack-s extra-packs-list">
            {status.skipped.map((skipped) => (
              <li
                key={skipped.name}
                className="stack-s"
                data-testid={`extra-pack-skipped-${skipped.name}`}
              >
                <span className="mono">{skipped.name}</span>
                <span className="text-small text-2 pre-wrap wrap-anywhere">{skipped.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <span className="text-3 text-small">
        {t('读取于 ', 'Read at ')}
        <span data-volatile="">{formatDateTime(status.checkedAt)}</span>
      </span>
    </div>
  );
}
