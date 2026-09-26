import type { ExecutionReadinessGateWire, ExecutionReadinessWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { transportKindLabel } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { GrantGateDrawer } from '../access/GrantGateDrawer.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../kit/dropdown-menu.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { RefChip } from '../kit/ref-chip.js';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../kit/sheet.js';
import { StatusChip } from '../kit/status-chip.js';
import { gateReasonHref, gateReasonLink, gateReasonText } from '../readiness/readiness-copy.js';

/** A plain "more actions" glyph — this file is not `components/kit/*`, but its own overflow
 *  trigger only needs `kit/button`'s bare label slot, not `components/ui/Icon` (which would add a
 *  fresh `components/ui/*` import this already-migrated page has no other reason to carry — see
 *  `scripts/guards/legacy-ui-importers.json`). Hand-rolled the same way `kit/ref-chip`/`kit/toast`
 *  draw their own icons rather than importing the legacy set. */
function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

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
  /** `AvailableGateInstanceWire.transportKind` (`ssh`/`http`/`mcp`/`cli`) — `undefined` for a
   *  legacy (`!linked`) registration, which carries no transport signal either. */
  readonly transportKind?: string;
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

/** Console redesign P3-3 (V5): one line per grantee, up to two names — the full roster (with
 *  revoke) lives in the detail sheet this text opens. */
function whoCanUseSummary(
  rows: readonly SystemAccessGranteeRow[],
  directory: boolean,
  t: Translate,
): string {
  if (!directory) return t('你', 'You');
  if (rows.length === 0) return t('还没有人可用', 'No one yet');
  const names = rows.map((row) => row.principalName).filter((name): name is string => !!name);
  const preview = names.slice(0, 2);
  const rest = rows.length - preview.length;
  if (preview.length === 0) return t(`${rows.length} 人可用`, `${rows.length} people`);
  return rest > 0
    ? t(`${preview.join('、')} 等 ${rows.length} 人`, `${preview.join(', ')} +${rest} more`)
    : preview.join('、');
}

const GATE_STATUS_TONE: Readonly<Record<ExecutionReadinessGateWire['status'], string>> = {
  direct: 'chip-ok',
  via_worker: 'chip-info',
  unreachable: 'chip-warn',
};

function gateStatusLabel(status: ExecutionReadinessGateWire['status'], t: Translate): string {
  switch (status) {
    case 'direct':
      return t('可直接调用', 'Direct');
    case 'via_worker':
      return t('需委派', 'Via a Worker');
    case 'unreachable':
      return t('用不了', 'Unusable');
  }
}

/** Bugfix (PR #324 review, "remove the reason link that points to the page you are already
 *  on"): `no_published_operation`'s and `not_granted`'s fix-it links both resolve to 系统与授权
 *  itself (`hrefs.systems()`/`hrefs.access()`) — and their actual fix is already a control on this
 *  very row ("发布清单" in the overflow menu, "授权" as the primary action), so the link is a
 *  same-page no-op. The other reasons (`excluded_by_policy`/`excluded_by_profile`/`no_worker`)
 *  send the reader to a genuinely different page and keep their link. */
const SELF_PAGE_HREFS: ReadonlySet<string> = new Set([hrefs.systems(), hrefs.access()]);

function isSelfPageHref(href: string | undefined): boolean {
  return href !== undefined && SELF_PAGE_HREFS.has(href);
}

/** "Reachability for me" (V5): the viewing principal's own status is already on `gate` itself
 *  (`execution_readiness`'s baseline, self read) — no extra lookup, unlike a grantee row's, which
 *  needs a per-principal `execution_readiness` read (`readinessByPrincipal`, see `GranteeRow`).
 *
 * Bugfix (PR #324 review, "system rows are too busy"): the row itself now renders only the chip
 * — the full reason sentence is the chip's own `title` tooltip, and the fully-spelled-out
 * version (+ fix-it link) moved into the "谁能用" detail sheet (`SystemAccessCard`'s own "你的
 * 可达性" section) so it is available on demand without crowding the row. */
function MyReachability({ gate }: { readonly gate: ExecutionReadinessGateWire }) {
  const t = useT();
  const reason = gate.status === 'unreachable' ? gateReasonText(gate.reason, t) : undefined;
  return (
    <span
      className={`chip chip-s ${GATE_STATUS_TONE[gate.status]}`}
      data-testid="gatekeeper-reachability"
      data-status={gate.status}
      title={reason}
    >
      {gateStatusLabel(gate.status, t)}
    </span>
  );
}

/** The drawer's own, fuller rendering of the same reachability — full sentence + a fix-it link
 *  when it points somewhere actually useful (see `isSelfPageHref`). */
function MyReachabilityDetail({ gate }: { readonly gate: ExecutionReadinessGateWire }) {
  const t = useT();
  const href = gate.reason !== undefined ? gateReasonHref(gate.reason) : undefined;
  return (
    <div className="row-wrap" data-testid="system-access-my-reachability">
      <span className={`chip chip-s ${GATE_STATUS_TONE[gate.status]}`}>
        {gateStatusLabel(gate.status, t)}
      </span>
      {gate.status === 'unreachable' ? (
        <>
          <span className="text-3 text-small">{gateReasonText(gate.reason, t)}</span>
          {gate.reason !== undefined && href !== undefined && !isSelfPageHref(href) ? (
            <a href={href} className="link-inline">
              {gateReasonLink(gate.reason, t)}
            </a>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * components/systems/SystemAccessCard (console redesign P2, docs/console-redesign-plan-
 * 2026-09-25.md §4; P3-3 V5 redesign): one row per system in the artboard's list
 * (`Integrations.dc.html`) — name + kind/legacy chip, a one-line capability + health summary,
 * "谁能用" (count/short names, click to open the full roster) and "reachability for me" inline,
 * row actions primary "授权" + an overflow menu ("健康与操作", "发布清单"). The always-expanded
 * "谁能用" list (with revoke), "哪些 Worker 覆盖" and per-member reachability rows that the old
 * per-system card carried inline now live in a `kit/sheet` detail drawer instead — kept behind the
 * "谁能用" summary text as the fewest new controls this needed.
 *
 * Kept unchanged from the pre-redesign card: `data-testid="gatekeeper-card"` /
 * `gatekeeper-grant-button` (every e2e journey that asserts a system got registered, or opens its
 * grant drawer, keeps working unchanged) and the legacy / publish-manifest affordances.
 *
 * Reachability per grantee reuses `readiness-copy.ts`'s exact chip wording and reason copy (the
 * same three states, same fix links `ExecutionReadinessCard` uses) — this card and the 对话
 * readiness strip never say it two different ways.
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
  const [detailOpen, setDetailOpen] = useState(false);
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
    <li className="data-row" data-testid="gatekeeper-card" data-gatekeeper-id={gate.gateId}>
      <div className="data-row-main">
        <div className="data-row-title">
          <strong>{gate.name}</strong>
          {healthInfo.transportKind !== undefined ? (
            <span className="tag">{transportKindLabel(healthInfo.transportKind, t)}</span>
          ) : null}
          {!healthInfo.linked ? (
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
        </div>
        <div className="data-row-meta" data-testid="gatekeeper-ops-summary">
          <span>
            {t(
              `gate ${shortId(gate.gateId)} · ${gate.observeOperationCount} 个只读操作 · ${gate.executeOperationCount} 个写操作`,
              `gate ${shortId(gate.gateId)} · ${gate.observeOperationCount} read op(s) · ${gate.executeOperationCount} write op(s)`,
            )}
          </span>
          {healthInfo.linked && healthInfo.health !== undefined ? (
            <StatusChip machine="gateHealth" status={healthInfo.health} size="s" />
          ) : null}
          <a href={hrefs.catalog('operations')} className="link-inline">
            {t('去能力目录看 Operation', 'See in Catalog')}
          </a>
        </div>
      </div>

      <div className="data-row-trailing">
        <Button
          variant="ghost"
          size="s"
          onClick={() => setDetailOpen(true)}
          data-testid="system-access-summary"
        >
          {whoCanUseSummary(rows, directory, t)}
        </Button>
        <MyReachability gate={gate} />
        {canManage ? (
          <Button
            variant="primary"
            size="s"
            onClick={() => setGrantOpen(true)}
            data-testid="gatekeeper-grant-button"
          >
            {t('授权', 'Grant')}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="s"
              aria-label={t('更多操作', 'More actions')}
              data-testid="gatekeeper-more"
            >
              <MoreIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpenDetail(gate.gateId)}>
              {t('健康与操作', 'Health & operations')}
            </DropdownMenuItem>
            {canPublish ? (
              <DropdownMenuItem
                disabled={publishing || draftCount === 0}
                onSelect={() => void publish()}
                data-testid="gatekeeper-publish-manifest"
              >
                {t('发布清单', 'Publish manifest')}
                {draftCount > 0 ? ` (${draftCount})` : ''}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {publishError !== null ? (
        <ErrorBanner
          error={publishError}
          title={t('无法发布清单', 'Could not publish the manifest')}
        />
      ) : null}

      <GrantGateDrawer
        http={http}
        open={grantOpen}
        onOpenChange={setGrantOpen}
        lockedGatekeeper={{ id: gate.gateId, name: gate.name }}
        onGranted={onGranted}
      />

      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent data-testid="system-access-drawer">
          <SheetHeader>
            <SheetTitle>{gate.name}</SheetTitle>
            <SheetDescription>
              {t(
                '谁能用它、用不了差哪一步，哪些 Worker 覆盖它。',
                'Who can use it, what is missing when they cannot, and which Workers cover it.',
              )}
            </SheetDescription>
          </SheetHeader>

          <div className="stack">
            <div className="stack-s">
              <span className="field-label">{t('你的可达性', 'Your reachability')}</span>
              <MyReachabilityDetail gate={gate} />
            </div>

            <div className="stack-s" data-testid="system-access-list">
              <span className="field-label">{t('谁能用', 'Who can use it')}</span>
              {rows.length === 0 ? (
                <EmptyState
                  variant="inline"
                  title={t('还没有成员被授权', 'No one is granted yet')}
                  testId="system-access-empty"
                />
              ) : (
                rows.map((row) => (
                  <GranteeRow
                    key={row.grantId || row.principalId}
                    http={http}
                    row={row}
                    readiness={readinessByPrincipal.get(row.principalId)}
                    readinessPending={
                      readinessLoading && !readinessByPrincipal.has(row.principalId)
                    }
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
                <EmptyState
                  variant="inline"
                  title={t('还没有 Worker 覆盖这个系统', 'No Worker covers this system yet')}
                  testId="system-worker-empty"
                />
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
        </SheetContent>
      </Sheet>
    </li>
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
          {gateStatus.reason !== undefined &&
          gateReasonHref(gateStatus.reason) !== undefined &&
          !isSelfPageHref(gateReasonHref(gateStatus.reason)) ? (
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
