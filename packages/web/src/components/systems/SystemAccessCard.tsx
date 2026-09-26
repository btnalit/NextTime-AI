import type { ExecutionReadinessGateWire, ExecutionReadinessWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { GrantGateDrawer } from '../access/GrantGateDrawer.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { RefChip } from '../kit/ref-chip.js';
import { DashboardCard } from '../kit/section.js';
import { StatusChip } from '../kit/status-chip.js';
import { gateReasonHref, gateReasonLink, gateReasonText } from '../readiness/readiness-copy.js';

export interface SystemAccessGranteeRow {
  readonly grantId: string;
  readonly principalId: string;
  /** Known from the owner/operator directory read; omitted for the self-only row a plain member
   *  sees (`RefChip` then self-resolves it through `resolve_refs`). */
  readonly principalName?: string;
}

export interface SystemAccessHealth {
  /** Linked to a platform gate instance (`list_available_gate_instances`) — `false` for a gate
   *  registered directly (`create_connection`/`直接注册门`), which carries no health signal. */
  readonly linked: boolean;
  readonly health?: string;
}

export interface SystemAccessCardProps {
  readonly http: CapabilityCaller;
  readonly gate: ExecutionReadinessGateWire;
  readonly healthInfo: SystemAccessHealth;
  readonly draftCount: number;
  readonly canPublish: boolean;
  readonly onPublished: () => void;
  /** `workerDefinitionId -> name`, from the same baseline `execution_readiness` read this card's
   *  own `gate` came from (`gate.workerDefinitionIds`) — see the module doc comment for the
   *  per-viewer caveat this carries. */
  readonly workerNames: ReadonlyMap<string, string>;
  readonly rows: readonly SystemAccessGranteeRow[];
  /** `true` once an owner/operator directory (`list_grants`/`list_principals`) was actually read
   *  — `rows` is then every grantee. `false` degrades to the signed-in member's own row only
   *  (`rows` has exactly one entry, no `grantId`-backed revoke). */
  readonly directory: boolean;
  /** Grant/revoke affordances — owner-only per the kernel (`grant_capability`/`revoke_capability`
   *  are `minRole:'owner'`; `list_grants` itself is operator-readable, so an operator can see
   *  `directory` rows without being able to act on them). */
  readonly canManage: boolean;
  readonly readinessByPrincipal: ReadonlyMap<string, ExecutionReadinessWire>;
  readonly readinessLoading: boolean;
  readonly onOpenDetail: (gatekeeperId: string) => void;
  /** May throw — `Confirm` (`medium` tier) keeps its popover open and renders the error inline. */
  readonly onRevoke: (grantId: string) => Promise<void>;
  readonly onGranted: () => void;
  readonly selfPrincipalId: string | null;
}

/**
 * components/systems/SystemAccessCard (console redesign P2, docs/console-redesign-plan-
 * 2026-09-25.md §4): one system, one card — replaces `RegisteredSystemsSection.tsx`'s
 * `GatekeeperCard` (removed; its per-Operation listing and plain-RefChip grantee list are both
 * superseded here by a one-line ops summary and a per-member *reachability* row, which did not
 * exist before P0's `execution_readiness` per-gate read model). Kept from that component:
 * `data-testid="gatekeeper-card"` / `gatekeeper-grant-button` (every e2e journey that asserts a
 * system got registered, or opens its grant drawer, keeps working unchanged) and the legacy /
 * publish-manifest affordances — no functionality dropped, see the PR report.
 *
 * Reachability per grantee reuses `readiness-copy.ts`'s exact chip wording and reason copy
 * (`ExecutionReadinessCard`'s own `GateRow`, imported not duplicated) — the same three states,
 * same fix links, so this card and the 对话 readiness card never say it two different ways.
 */
export function SystemAccessCard({
  http,
  gate,
  healthInfo,
  draftCount,
  canPublish,
  onPublished,
  workerNames,
  rows,
  directory,
  canManage,
  readinessByPrincipal,
  readinessLoading,
  onOpenDetail,
  onRevoke,
  onGranted,
  selfPrincipalId,
}: SystemAccessCardProps) {
  const t = useT();
  const [grantOpen, setGrantOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<unknown | null>(null);

  async function publish(): Promise<void> {
    setPublishing(true);
    setPublishError(null);
    try {
      await http.call('publish_manifest', { gatekeeperId: gate.gateId });
      onPublished();
    } catch (err) {
      setPublishError(err);
    } finally {
      setPublishing(false);
    }
  }

  const workers = gate.workerDefinitionIds;

  return (
    <DashboardCard
      title={
        <span className="row-wrap">
          <strong>{gate.name}</strong>
          {healthInfo.linked && healthInfo.health !== undefined ? (
            <StatusChip machine="gateHealth" status={healthInfo.health} size="s" />
          ) : !healthInfo.linked ? (
            <span
              className="tag"
              title={t(
                '旧注册：不经平台门实例目录接入',
                'Legacy: registered outside the platform gate-instance catalog',
              )}
            >
              {t('旧注册', 'Legacy')}
            </span>
          ) : null}
        </span>
      }
      actions={
        <span className="row-wrap">
          <Button variant="ghost" size="s" onClick={() => onOpenDetail(gate.gateId)}>
            {t('健康与操作', 'Health & operations')}
          </Button>
          {canPublish ? (
            <Button
              variant={draftCount > 0 ? 'primary' : 'secondary'}
              size="s"
              onClick={() => void publish()}
              disabled={publishing || draftCount === 0}
              title={
                draftCount === 0
                  ? t('没有草稿 Operation 可发布', 'No draft operations to publish')
                  : undefined
              }
              data-testid="gatekeeper-publish-manifest"
            >
              {t('发布清单', 'Publish manifest')}
              {draftCount > 0 ? ` (${draftCount})` : ''}
            </Button>
          ) : null}
          {canManage ? (
            <Button
              variant="secondary"
              size="s"
              onClick={() => setGrantOpen(true)}
              data-testid="gatekeeper-grant-button"
            >
              {t('授权', 'Grant')}
            </Button>
          ) : null}
        </span>
      }
      data-testid="gatekeeper-card"
      data-gatekeeper-id={gate.gateId}
    >
      <div className="stack">
        <p className="text-3 text-small" data-testid="gatekeeper-ops-summary">
          {t(
            `${gate.observeOperationCount} 个只读操作 · ${gate.executeOperationCount} 个写操作`,
            `${gate.observeOperationCount} read operation(s) · ${gate.executeOperationCount} write operation(s)`,
          )}
          {' — '}
          <a href={hrefs.catalog('operations')} className="link-inline">
            {t('去能力目录看 Operation', 'See in Catalog')}
          </a>
        </p>

        {publishError !== null ? (
          <ErrorBanner
            error={publishError}
            title={t('无法发布清单', 'Could not publish the manifest')}
          />
        ) : null}

        <div className="stack-s" data-testid="system-access-list">
          <span className="field-label">{t('谁能用', 'Who can use it')}</span>
          {rows.length === 0 ? (
            <p className="text-3 text-small">{t('还没有成员被授权。', 'No one is granted yet.')}</p>
          ) : (
            rows.map((row) => (
              <GranteeRow
                key={row.grantId || row.principalId}
                http={http}
                row={row}
                readiness={readinessByPrincipal.get(row.principalId)}
                readinessPending={readinessLoading && !readinessByPrincipal.has(row.principalId)}
                gateId={gate.gateId}
                isSelf={row.principalId === selfPrincipalId}
                canRevoke={canManage && directory}
                onRevoke={onRevoke}
              />
            ))
          )}
        </div>

        <div className="stack-s" data-testid="system-worker-coverage">
          <span className="field-label">{t('哪些 Worker 覆盖', 'Covered by Workers')}</span>
          {workers.length === 0 ? (
            <p className="text-3 text-small">
              {t(
                '还没有 Worker 声明覆盖这个系统。',
                'No Worker declares coverage of this system yet.',
              )}
            </p>
          ) : (
            <div className="row-wrap">
              {workers.map((id) => (
                <RefChip
                  key={id}
                  kind="workerDefinition"
                  id={id}
                  name={workerNames.get(id)}
                  href={hrefs.catalog('workers')}
                  http={http}
                  size="s"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <GrantGateDrawer
        http={http}
        open={grantOpen}
        onOpenChange={setGrantOpen}
        lockedGatekeeper={{ id: gate.gateId, name: gate.name }}
        onGranted={onGranted}
      />
    </DashboardCard>
  );
}

function GranteeRow({
  http,
  row,
  readiness,
  readinessPending,
  gateId,
  isSelf,
  canRevoke,
  onRevoke,
}: {
  readonly http: CapabilityCaller;
  readonly row: SystemAccessGranteeRow;
  readonly readiness: ExecutionReadinessWire | undefined;
  readonly readinessPending: boolean;
  readonly gateId: string;
  readonly isSelf: boolean;
  readonly canRevoke: boolean;
  readonly onRevoke: (grantId: string) => Promise<void>;
}) {
  const t = useT();
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const gateStatus = readiness?.gates.find((entry) => entry.gateId === gateId);

  return (
    <div className="row-wrap" data-testid="system-access-row" data-principal-id={row.principalId}>
      <RefChip
        kind="principal"
        id={row.principalId}
        name={row.principalName}
        http={row.principalName ? undefined : http}
        size="s"
      />
      {isSelf ? <span className="tag">{t('你', 'You')}</span> : null}
      {readiness === undefined ? (
        <span className="text-3 text-small">
          {readinessPending
            ? t('正在检查可达性…', 'Checking reachability…')
            : t('无法读取可达性', 'Could not read reachability')}
        </span>
      ) : gateStatus === undefined ? (
        <span className="chip chip-warn chip-s">{t('用不了', 'Not usable')}</span>
      ) : gateStatus.status === 'direct' ? (
        <span className="chip chip-ok chip-s">{t('可直接调用', 'Callable directly')}</span>
      ) : gateStatus.status === 'via_worker' ? (
        <span className="chip chip-info chip-s">{t('需委派', 'Via a Worker')}</span>
      ) : (
        <>
          <span className="chip chip-warn chip-s">{t('用不了', 'Not usable')}</span>
          <span className="text-3 text-small">{gateReasonText(gateStatus.reason, t)}</span>
          {gateStatus.reason !== undefined ? (
            <a href={gateReasonHref(gateStatus.reason)} className="link-inline">
              {gateReasonLink(gateStatus.reason, t)}
            </a>
          ) : null}
        </>
      )}
      {canRevoke && row.grantId ? (
        <Confirm
          tier="medium"
          open={revokeConfirmOpen}
          onOpenChange={setRevokeConfirmOpen}
          anchor={
            <Button
              variant="ghost"
              size="s"
              onClick={() => setRevokeConfirmOpen(true)}
              data-testid={`gatekeeper-revoke-${row.grantId}`}
            >
              {t('撤销', 'Revoke')}
            </Button>
          }
          title={t('撤销授权', 'Revoke this grant')}
          description={t(
            '该成员的入口 agent 将不再能调用这个系统。',
            "This member's entry agent will no longer be able to call this system.",
          )}
          danger
          confirmLabel={t('撤销', 'Revoke')}
          onConfirm={() => onRevoke(row.grantId)}
          testId={`gatekeeper-revoke-confirm-${row.grantId}`}
        />
      ) : null}
    </div>
  );
}
