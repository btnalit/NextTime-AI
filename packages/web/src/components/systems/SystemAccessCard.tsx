import type {
  ExecutionReadinessGateWire,
  ExecutionReadinessWire,
  RefreshOperationGovernanceResultWire,
  Role,
  RotateConnectionSecretResultWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { shortId } from '../../lib/format.js';
import { gateGrantMakesApprover } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { transportKindLabel } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { GrantGateDrawer } from '../access/GrantGateDrawer.js';
import { ConnectionSecretReveal } from '../connect/ConnectionSecretReveal.js';
import { DefinitionMismatchNotice } from '../connect/DefinitionDrift.js';
import { RefreshOperationGovernanceConfirm } from '../connect/RefreshOperationGovernanceConfirm.js';
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
  /** From the same directory read — drives the R-39 approver disclosure (`gateGrantMakesApprover`):
   *  an operator grantee is also an approver of every action on this gate. Omitted with the name. */
  readonly principalRole?: Role;
}

export interface SystemAccessHealth {
  /** Linked to a platform gate instance (`list_available_gate_instances`) — `false` for a gate
   *  registered directly (`create_connection`/`直接注册门`), which carries no health signal. */
  readonly linked: boolean;
  readonly health?: string;
  /** `AvailableGateInstanceWire.transportKind` (`ssh`/`http`/`mcp`/`cli`) — `undefined` for a
   *  legacy (`!linked`) registration, which carries no transport signal either. */
  readonly transportKind?: string;
  /** `AvailableGateInstanceWire.gateId` — the *platform* gate instance id (distinct from this
   *  card's own `gate.gateId`, which is the Gatekeeper Object id) — only present when `linked`.
   *  Closing wave C6 (G3): what `preview_gate_instance_enable`/`RefreshOperationGovernanceConfirm`
   *  read the announced manifest from. */
  readonly platformGateId?: string;
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
  /** `session.user?.platformRole === 'admin'` — a refused call that waits on the platform adopting
   *  the gate's new manifest then links to the gate instance (UX acceptance of #538). */
  readonly platformAdmin?: boolean;
}

/** Console redesign P3-3 (V5): one line per grantee, up to two names — the full roster (with
 *  revoke) lives in the detail sheet this text opens. */
function whoCanUseSummary(
  rows: readonly SystemAccessGranteeRow[],
  directory: boolean,
  t: Translate,
): string {
  if (!directory) return t('你', 'You');
  if (rows.length === 0) return t('还没有人被授权', 'No one granted yet');
  const names = rows.map((row) => row.principalName).filter((name): name is string => !!name);
  const preview = names.slice(0, 2);
  const rest = rows.length - preview.length;
  if (preview.length === 0) return t(`${rows.length} 人已授权`, `${rows.length} people`);
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

/** Legacy K (UX acceptance of #538): the gate refuses calls to some of this system's Operations
 *  — it runs another definition — while the system itself still reads usable through the others.
 *  When every one is refused the reachability chip already says so (`definition_mismatch`). The
 *  drawer's `DefinitionMismatchNotice` says which, and whose step it is. */
function RefusedOperationsChip({ gate }: { readonly gate: ExecutionReadinessGateWire }) {
  const t = useT();
  const count = gate.definitionMismatch.length;
  if (count === 0 || gate.reason === 'definition_mismatch') return null;
  return (
    <span
      className="chip chip-s chip-warn"
      data-testid="gatekeeper-refused-operations"
      title={t(
        `门运行的定义和已发布的不一样：${gate.definitionMismatch.map((entry) => entry.operation).join('、')}`,
        `The gate runs another definition than the published one: ${gate.definitionMismatch.map((entry) => entry.operation).join(', ')}`,
      )}
    >
      {t(`${count} 个 Operation 调用被拒`, `${count} operation(s) refused`)}
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
  platformAdmin = false,
}: SystemAccessCardProps) {
  const t = useT();
  const [grantOpen, setGrantOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<unknown | null>(null);
  // R-01 (D-01): a gate the workspace connected itself (not a catalog instance) authenticates the
  // kernel with its own connection secret; the owner can issue a new one here — also how a gate
  // connected before per-connection secrets gets its first. Shown once, in the sheet below.
  const canRotateSecret = canManage && !healthInfo.linked;
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

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

  function moreMenu() {
    return (
      // `modal={false}` when the menu hands off to the rotation confirm (same reason as
      // graph/FactRow.tsx's menu: a modal menu keeps its outside-pointer lock while the next
      // surface opens).
      <DropdownMenu modal={canRotateSecret ? false : undefined}>
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
          {canRotateSecret ? (
            <DropdownMenuItem
              onSelect={() => setRotateOpen(true)}
              data-testid="gatekeeper-rotate-secret"
            >
              {t('重新签发连接密钥', 'Issue a new connection secret')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

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
        <RefusedOperationsChip gate={gate} />
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
        {canRotateSecret ? (
          <Confirm
            tier="medium"
            danger
            open={rotateOpen}
            onOpenChange={setRotateOpen}
            anchor={moreMenu()}
            title={t('重新签发连接密钥', 'Issue a new connection secret')}
            target={gate.name}
            impact={[
              t(
                '旧密钥立即失效：在门里换上新密钥并重启之前，内核调不通这个门',
                'The old secret stops working now — the kernel cannot reach this gate until it holds the new one and restarts',
              ),
              t('新密钥只显示一次', 'The new secret is shown once'),
            ]}
            confirmLabel={t('签发', 'Issue')}
            onConfirm={async () => {
              const result = await http.call<RotateConnectionSecretResultWire>(
                'rotate_connection_secret',
                { gatekeeperId: gate.gateId },
              );
              setRotatedSecret(result.connectionSecret);
            }}
            testId="gatekeeper-rotate-secret-confirm"
          />
        ) : (
          moreMenu()
        )}
      </div>

      {publishError !== null ? (
        <ErrorBanner
          error={publishError}
          title={t('无法发布清单', 'Could not publish the manifest')}
        />
      ) : null}

      <Sheet
        open={rotatedSecret !== null}
        onOpenChange={(open) => {
          if (!open) setRotatedSecret(null);
        }}
      >
        <SheetContent data-testid="gatekeeper-rotated-secret">
          <SheetHeader>
            <SheetTitle>{t('新的连接密钥', 'New connection secret')}</SheetTitle>
            <SheetDescription>{gate.name}</SheetDescription>
          </SheetHeader>
          <div className="stack">
            {rotatedSecret !== null ? <ConnectionSecretReveal secret={rotatedSecret} /> : null}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" size="s" onClick={() => setRotatedSecret(null)}>
                {t('我已复制', "I've copied it — Done")}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

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
            <DefinitionMismatchNotice
              mismatch={gate.definitionMismatch}
              platformAdmin={platformAdmin}
              platformGateId={healthInfo.platformGateId}
              canManage={canManage}
              testId="system-definition-mismatch"
            />
            <div className="stack-s">
              <span className="field-label">{t('你的可达性', 'Your reachability')}</span>
              <MyReachabilityDetail gate={gate} />
            </div>

            <div className="stack-s" data-testid="system-access-list">
              <span className="field-label">
                {t(
                  '谁被授权（写操作；只读不需要授权）',
                  'Who is granted (writes; reads need no grant)',
                )}
              </span>
              <p className="field-hint" data-testid="system-access-approver-hint">
                {t(
                  '授权给 operator 时，他同时成为这个门上所有动作的审批者，能批准或驳回其他成员的写操作；owner 本来就能审批一切。',
                  'A grant to an operator also makes them an approver of every action on this gate — they can approve or reject other members’ writes. Owners can approve everything anyway.',
                )}
              </p>
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

            {canManage && healthInfo.linked && healthInfo.platformGateId !== undefined ? (
              <div className="stack-s" data-testid="system-governance-align">
                <span className="field-label">
                  {t('已部署 Operation 的治理字段', 'Deployed operations’ governance fields')}
                </span>
                <RefreshOperationGovernanceConfirm
                  http={http}
                  gatekeeperId={gate.gateId}
                  platformGateId={healthInfo.platformGateId}
                  gateDisplayName={gate.name}
                  platformAdmin={platformAdmin}
                  onRefreshed={() => onPublished()}
                  testId="system-governance-refresh"
                />
              </div>
            ) : null}
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
  const approver = row.principalRole !== undefined && gateGrantMakesApprover(row.principalRole);

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
      {approver ? (
        <span
          className="tag"
          title={t(
            '这份授权也让他成为这个门上所有动作的审批者',
            'This grant also makes them an approver of every action on this gate',
          )}
          data-testid="system-access-approver-tag"
        >
          {t('也是审批者', 'Also an approver')}
        </span>
      ) : null}
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
          description={
            approver
              ? t(
                  '该成员将不能再经 Worker 对这个系统执行写操作，也不再是这个门上动作的审批者；只读操作不需要授权，不受影响。',
                  'This member will no longer be able to act on this system through a Worker, and is no longer an approver of actions on this gate; read operations need no grant and are unaffected.',
                )
              : t(
                  '该成员将不能再经 Worker 对这个系统执行写操作；只读操作不需要授权，不受影响。',
                  'This member will no longer be able to act on this system through a Worker; read operations need no grant and are unaffected.',
                )
          }
          danger
          confirmLabel={t('撤销', 'Revoke')}
          onConfirm={() => onRevoke(row.grantId)}
          testId={`gatekeeper-revoke-confirm-${row.grantId}`}
        />
      ) : null}
    </div>
  );
}
