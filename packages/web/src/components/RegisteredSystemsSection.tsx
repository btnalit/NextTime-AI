import type { AvailableGateInstanceWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  type GatekeeperView,
  type OperationView,
  groupOperationsByStatus,
} from '../lib/connections.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { platformGateInstanceHref } from '../lib/gate-instances.js';
import type { GrantRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { GrantGateDrawer } from './access/GrantGateDrawer.js';
import { Confirm } from './kit/confirm.js';
import { RefChip } from './kit/ref-chip.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

export interface GatekeeperCardProps {
  readonly http: CapabilityCaller;
  readonly gatekeeper: GatekeeperView;
  readonly operations: readonly OperationView[];
  /** Owner-only actions hidden when the session has been told 403 for them. */
  readonly canPublish: boolean;
  readonly canGrant: boolean;
  readonly onChanged: () => void;
  readonly onForbidden: (capabilityName: string) => void;
  /** Opens the S3.11 health/operations detail drawer (`get_gatekeeper`) for this gate. Optional —
   *  omitted, the "Health & operations" action does not render (a page rendering the card without
   *  a drawer to open it into, e.g. a future embedded use). */
  readonly onOpenDetail?: (gatekeeperId: string) => void;
  /** S6-C (§5.6 "实例与连接之间的互相链接"): the platform gate instance this Gatekeeper was enabled
   *  from (`list_available_gate_instances` row whose `gatekeeperId` is this gate), when it was —
   *  a self-connected gate (`create_connection`) has none. */
  readonly platformInstance?: AvailableGateInstanceWire | null;
  /** The reader may open the platform 集成 page — the instance row links there only then. */
  readonly platformAdmin?: boolean;
  /** S8 W2-U1 (audit R5/U2 "卡片上看不到谁已获授权"): every active `resourceType:'gatekeeper'`
   *  Grant in the workspace (`ConnectionsPage` loads `list_grants` once, shared across every
   *  card) — the card filters to its own `resourceId`. `undefined` while still loading or when
   *  the session cannot read `list_grants` (operator+ only) — the "已授权成员" section hides
   *  rather than claiming an empty list. */
  readonly grants?: readonly GrantRow[];
  /** A grant or revoke happened — the caller re-reads `list_grants` (shared across cards, same
   *  reasoning as `onChanged` for the registry read). */
  readonly onGrantsChanged?: () => void;
}

/**
 * components/RegisteredSystemsSection: one registered Gatekeeper (a `Gatekeeper` graph Object)
 * with its Operations grouped by lifecycle, plus the two owner actions of the S2.13 flow:
 * `publish_manifest` (every draft → published, I16/I17) and `connect_gatekeeper` (a
 * CapabilityGrant letting a principal's entry agent use this gate). S8 W1-A6: the principal
 * picker is `list_principals` (`ConnectionsPage` loads it once, passed down as `principals`) —
 * this module's doc comment used to say the kernel had no such capability; S8 W1-C added one.
 */
export function GatekeeperCard({
  http,
  gatekeeper,
  operations,
  canPublish,
  canGrant,
  onChanged,
  onForbidden,
  onOpenDetail,
  platformInstance = null,
  platformAdmin = false,
  grants,
  onGrantsChanged,
}: GatekeeperCardProps) {
  const t = useT();
  const toast = useToast();
  const [publishing, setPublishing] = useState(false);
  const [grantDrawerOpen, setGrantDrawerOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<unknown | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const groups = groupOperationsByStatus(operations);
  const draftCount = operations.filter((operation) => operation.status === 'draft').length;
  // S8 W2-U1 (audit R5/U2): active grants scoped to exactly this gate — a workspace-wide "全部门"
  // grant (`resourceId` omitted) covers this gate too but is not enumerated per card; it already
  // shows as "任意" on the Access page. `grants` (not just the filtered result) stays `undefined`
  // when the caller has none to offer yet — that is what gates the section below, never collapsed
  // into an empty array here (an empty array is a real "loaded, nobody granted" answer).
  const gateGrants = (grants ?? []).filter(
    (row) =>
      row.status === 'active' &&
      row.resourceType === 'gatekeeper' &&
      row.resourceId === gatekeeper.id,
  );

  async function publish(): Promise<void> {
    setPublishing(true);
    setError(null);
    try {
      const result = await http.call<{ publishedOperationNames?: readonly string[] }>(
        'publish_manifest',
        { gatekeeperId: gatekeeper.id },
      );
      const count = result.publishedOperationNames?.length ?? 0;
      toast.push({
        tone: 'ok',
        title:
          count > 0
            ? t(
                `已发布 ${count} 个 Operation`,
                `Published ${count} operation${count === 1 ? '' : 's'}`,
              )
            : t('没有草稿可发布', 'No drafts to publish'),
        description: gatekeeper.name,
      });
      onChanged();
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('publish_manifest');
      setError(err);
    } finally {
      setPublishing(false);
    }
  }

  async function revoke(grantId: string): Promise<void> {
    setRevoking(grantId);
    setRevokeError(null);
    try {
      await http.call('revoke_capability', { grantId });
      onGrantsChanged?.();
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('revoke_capability');
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Card
      className="gatekeeper-card"
      title={
        <span className="row-wrap">
          <span>{gatekeeper.name}</span>
          <span className="tag">{gatekeeper.transportKind}</span>
          {/* S8 W2-U1 (audit SY1 "两套接入机制并存，页面不说哪一套决定 agent 能不能用"): a gate with
           *  no platform-instance link was registered through the older `create_connection` /
           *  CLI path — mark it so, next to the "平台实例" fact below when there is one. */}
          {platformInstance === null ? (
            <span
              className="tag"
              title={t(
                '旧注册：不经平台门实例目录接入，未来会建议迁移到「接入一个系统」',
                'Legacy: registered outside the platform gate-instance catalog',
              )}
              data-testid="gatekeeper-legacy-badge"
            >
              {t('旧注册，未关联平台实例', 'Legacy — not linked to a platform instance')}
            </span>
          ) : null}
        </span>
      }
      actions={
        <>
          {onOpenDetail ? (
            <Button
              variant="ghost"
              size="s"
              icon="search"
              onClick={() => onOpenDetail(gatekeeper.id)}
            >
              {t('健康与操作', 'Health & operations')}
            </Button>
          ) : null}
          {canPublish ? (
            <Button
              variant={draftCount > 0 ? 'primary' : 'secondary'}
              size="s"
              onClick={() => void publish()}
              loading={publishing}
              disabled={draftCount === 0}
              title={
                draftCount === 0
                  ? t('没有草稿 Operation 可发布', 'No draft operations to publish')
                  : undefined
              }
            >
              {t('发布清单', 'Publish manifest')}
              {draftCount > 0 ? ` (${draftCount})` : ''}
            </Button>
          ) : null}
          {canGrant ? (
            <Button
              variant="secondary"
              size="s"
              icon="user"
              onClick={() => setGrantDrawerOpen(true)}
              data-testid="gatekeeper-grant-button"
            >
              {t('授权给成员', 'Grant to a member')}
            </Button>
          ) : null}
        </>
      }
      data-testid="gatekeeper-card"
      data-gatekeeper-id={gatekeeper.id}
    >
      <div className="stack">
        <dl className="definition-list">
          <dt>{t('门', 'Gatekeeper')}</dt>
          <dd>
            <CopyId id={gatekeeper.id} label="gatekeeper" />
          </dd>
          <dt>{t('目标', 'Target')}</dt>
          <dd className="mono">{gatekeeper.target || '—'}</dd>
          <dt>{t('端点', 'Endpoint')}</dt>
          <dd className="mono">{gatekeeper.endpoint ?? '—'}</dd>
          <dt>{t('更新于', 'Updated')}</dt>
          <dd>
            <time title={formatDateTime(gatekeeper.updatedAt)}>
              {formatRelative(gatekeeper.updatedAt)}
            </time>
          </dd>
          {platformInstance ? (
            <>
              <dt>{t('平台实例', 'Platform instance')}</dt>
              <dd className="row-wrap" data-testid="gatekeeper-platform-instance">
                {platformAdmin ? (
                  // Deep link to the instance's own drawer on 集成 (`lib/router.ts` parses
                  // `#/platform/integrations/<gateId>` since S6-C integration).
                  <a
                    className="mono"
                    href={platformGateInstanceHref(platformInstance.gateId)}
                    data-testid="gatekeeper-platform-instance-link"
                  >
                    {platformInstance.gateId}
                  </a>
                ) : (
                  <span className="mono">{platformInstance.gateId}</span>
                )}
                <span className="tag">{platformInstance.connector}</span>
                <StatusChip machine="gateInstance" status={platformInstance.status} size="s" />
                <StatusChip machine="gateHealth" status={platformInstance.health} size="s" />
                {!platformAdmin ? (
                  <span className="text-3 text-small">
                    {t(
                      '由平台管理员在「集成」页管理',
                      'Managed by a platform administrator on Integrations',
                    )}
                  </span>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>

        {/* S8 W2-U1 (audit R5/U2 "卡片上看不到谁已获授权"): the gate's own access list — `grants`
         *  is `undefined` while `ConnectionsPage`'s shared `list_grants` is still loading or 403s
         *  for this role, so this hides rather than claiming "no one" incorrectly. */}
        {grants !== undefined ? (
          <div className="stack-s" data-testid="gatekeeper-access-list">
            <span className="section-title">{t('已授权成员', 'Granted to')}</span>
            {gateGrants.length === 0 ? (
              <p className="text-3 text-small">{t('还没有成员被授权。', 'No one granted yet.')}</p>
            ) : (
              <div className="row-wrap">
                {gateGrants.map((row) => (
                  <span className="row-wrap" key={row.id} style={{ gap: 4 }}>
                    <RefChip
                      kind="principal"
                      id={row.principalId}
                      http={http}
                      size="s"
                      testId={`gatekeeper-access-chip-${row.id}`}
                    />
                    {canGrant ? (
                      <Confirm
                        tier="medium"
                        open={revoking === row.id}
                        onOpenChange={(open) => {
                          if (!open) {
                            setRevoking(null);
                            setRevokeError(null);
                          }
                        }}
                        anchor={
                          <Button
                            variant="ghost"
                            size="s"
                            onClick={() => setRevoking(row.id)}
                            data-testid={`gatekeeper-revoke-${row.id}`}
                          >
                            {t('撤销', 'Revoke')}
                          </Button>
                        }
                        title={t('撤销授权', 'Revoke this grant')}
                        description={t(
                          '该成员的入口 agent 将不再能调用这个门。',
                          "This member's entry agent will no longer be able to call this gate.",
                        )}
                        danger
                        confirmLabel={t('撤销', 'Revoke')}
                        onConfirm={() => revoke(row.id)}
                        testId={`gatekeeper-revoke-confirm-${row.id}`}
                      />
                    ) : null}
                  </span>
                ))}
              </div>
            )}
            {revokeError !== null ? (
              <ErrorBanner
                error={revokeError}
                title={t('无法撤销授权', 'Could not revoke this grant')}
              />
            ) : null}
          </div>
        ) : null}

        {error !== null ? <ErrorBanner error={error} /> : null}

        {operations.length === 0 ? (
          <Notice>
            {t('这个门还没有导入任何 Operation。', 'No operations imported for this gate yet.')}
          </Notice>
        ) : (
          groups.map((group) => (
            <div className="stack-s" key={group.status}>
              <div className="op-group-title">
                <StatusChip machine="publishable" status={group.status} size="s" />
                <span>{group.operations.length}</span>
              </div>
              <div className="gatekeeper-ops">
                {group.operations.map((operation) => (
                  <div className="op-item" key={operation.objectId} title={operation.name}>
                    <span className="op-name">{operation.name}</span>
                    {/* S8 W1-A11 (audit L3): mode/blastRadius through the shared StatusChip
                     *  machines — not bare tag/coloured text — same as the target catalog page. */}
                    {operation.mode ? (
                      <StatusChip machine="operationMode" status={operation.mode} size="s" />
                    ) : null}
                    {operation.blastRadius && operation.blastRadius !== 'low' ? (
                      <StatusChip machine="blastRadius" status={operation.blastRadius} size="s" />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <GrantGateDrawer
        http={http}
        open={grantDrawerOpen}
        onOpenChange={setGrantDrawerOpen}
        lockedGatekeeper={{ id: gatekeeper.id, name: gatekeeper.name }}
        onGranted={() => {
          toast.push({ tone: 'ok', title: t('已授权', 'Granted') });
          onGrantsChanged?.();
        }}
      />
    </Card>
  );
}
