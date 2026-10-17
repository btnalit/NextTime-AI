import type {
  AvailableGateInstanceWire,
  EnableGateInstanceResultWire,
  GateHostTokenWire,
  GateInstanceWire,
} from '@nexttime/shared';
import { useEffect, useState } from 'react';
import { type CapabilityListResult, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { type Translate, useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import { AskOwnerToEnable } from './connect/AskOwnerToEnable.js';
import { EnableGateConfirm } from './connect/EnableGateConfirm.js';
import { HeldDraftsNotice } from './connect/GateOwnedParams.js';
// Bugfix (PR #324 review): "待启用的平台实例" was still the legacy dashed-border EmptyState —
// `kit/empty-state` (block variant, no dashed border) instead, matching V9. The rest of this
// file's `components/ui/*` imports are unchanged (this file stays on
// `scripts/guards/legacy-ui-importers.json`; out of this lane's scope to migrate fully).
import { DataTable, type DataTableColumn } from './kit/data-table.js';
import { EmptyState } from './kit/empty-state.js';
import { RouteLink } from './kit/route-link.js';
import { GateCredentialEntry } from './platform/GateCredentialEntry.js';
import {
  enabledHere,
  hiddenFromWorkspaces,
  useConnectorsByName,
} from './platform/integrations/connector-visibility.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

export interface AvailableGateInstancesSectionProps {
  readonly http: CapabilityCaller;
  /** S6-C: the catalog read is owned by `ConnectionsPage` now (it also feeds the launcher and the
   *  registered-system → platform-instance links), passed in rather than read twice. */
  readonly available: CapabilityListResult<AvailableGateInstanceWire>;
  /** The Registered systems section below must reload too: `enable_gate_instance` registers a
   *  Gatekeeper object that section reads independently. */
  readonly onEnabled: () => void;
  /** Owner-only: shows the 启用 button. Members still see the list and, on linked rows, the
   *  per-member credential entry (P-B2a). */
  readonly canEnable: boolean;
  /** The reader's role may enter its own credential for an enabled instance
   *  (`issue_gate_credential_token`) — not an auditor (#541 acceptance must-fix 2). */
  readonly canEnterCredential?: boolean;
  /** The signed-in user is a platform administrator: the empty state reads the platform's own
   *  instance list to say which step is actually missing, with a direct link to it. */
  readonly platformAdmin?: boolean;
}

/**
 * components/AvailableGateInstancesSection: "从平台目录启用 Enable from platform catalog"
 * (`ConnectionsPage`, P-B1, design §6.3) — `list_available_gate_instances` /
 * `enable_gate_instance`, the workspace-owner half of P-B1's platform catalog. Rendered only for
 * an owner (`ConnectionsPage`'s existing `canCreate` — `create_connection`'s own owner-only
 * `deniedClosure`, which `enable_gate_instance`/`list_available_gate_instances` share).
 *
 * B7 (docs/console-completion-plan.md §2b, §4 "接入三层"): a row here is a *platform* instance —
 * its `status` / `health` are the platform's (`enabled · ok` means "the administrator enabled it
 * and it is healthy"), while the button is about *this workspace*. The old raw `enabled · ok`
 * text next to a 启用 button read as a contradiction. Now the two facts are two `StatusChip`s and
 * the button says what it does — 在本工作区启用 Enable here — and appears only while the workspace
 * has no link yet (`gatekeeperId === null`) and the platform side is `enabled` (the only status
 * the kernel accepts, `requireAvailable`'s `gate_not_enabled`); a linked row shows the Gatekeeper
 * link instead.
 */
export function AvailableGateInstancesSection({
  http,
  available,
  onEnabled,
  canEnable,
  canEnterCredential = true,
  platformAdmin = false,
}: AvailableGateInstancesSectionProps) {
  const t = useT();
  const toast = useToast();
  const permissions = usePermissions();
  const forbidden = available.state.status === 'error' && isForbiddenError(available.state.error);
  useEffect(() => {
    if (forbidden) permissions.markDenied('list_available_gate_instances');
  }, [forbidden, permissions]);

  const rows = available.state.status === 'ready' ? available.state.data.items : [];

  // Each row's enable result lives here, not in its cell: the cell remounts when the list switches
  // between table and cards at 768px (legacy 388), and the notice under 已启用 must survive that.
  const [enabledResults, setEnabledResults] = useState<
    ReadonlyMap<string, EnableGateInstanceResultWire>
  >(() => new Map());

  // S8 W2-U1 (audit J4): `EnableGateConfirm` cannot import `components/ui/Toast` itself (S8 risk
  // ① — a new file under `components/kit`-adjacent boundaries may not reach into legacy
  // `components/ui/*`), so this already-allowlisted caller reports `linkedExisting` instead.
  function handleEnabled(
    row: AvailableGateInstanceWire,
    result: EnableGateInstanceResultWire,
  ): void {
    setEnabledResults((previous) => new Map(previous).set(row.gateId, result));
    const skipped = result.skippedOperationNames.length;
    const held = result.gateOwnedParamDrafts?.length ?? 0;
    toast.push({
      tone: 'ok',
      title: result.linkedExisting
        ? t(
            `已启用：${row.displayName}，本工作区自己接入的同址门改由它接入`,
            `Enabled ${row.displayName}; the gate this workspace connected at that address now comes from it`,
          )
        : t(
            `已在本工作区启用：${row.displayName}`,
            `Enabled in this workspace: ${row.displayName}`,
          ),
      description: t(
        `已发布 ${result.publishedOperationNames.length} 个 Operation${skipped > 0 ? `，跳过 ${skipped} 个已存在的` : ''}${held > 0 ? `，${held} 个没有发布（见下方）` : ''}。`,
        `Published ${result.publishedOperationNames.length} operation(s)${skipped > 0 ? `, skipped ${skipped} already there` : ''}${held > 0 ? `, ${held} not published (see below)` : ''}.`,
      ),
    });
    available.mutate((data) => ({
      ...data,
      items: data.items.map((item) =>
        item.gateId === result.gateId
          ? { ...item, gatekeeperId: result.gatekeeperId, status: 'enabled' }
          : item,
      ),
    }));
    onEnabled();
  }

  return (
    <div aria-labelledby="available-gates-title">
      <div className="section-header">
        {/* S8 W2-U1 (audit SY1 "两套接入机制并存"): `h3` — nested under `ConnectionsPage`'s own
         *  "已接入系统" `h2`, which now wraps this sub-group and 已注册系统 as one page section. */}
        <h3 id="available-gates-title">
          {t('待启用的平台实例', 'Platform instances pending enable')}
        </h3>
        <Button
          variant="ghost"
          size="s"
          icon="refresh"
          onClick={() => void available.reload()}
          loading={available.state.status === 'ready' && available.state.refreshing}
        >
          {t('刷新', 'Refresh')}
        </Button>
      </div>

      {available.state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label={t('正在加载平台目录…', 'Loading the platform catalog')}
          testId="available-gates-loading"
        />
      ) : forbidden ? (
        <AskOwnerToEnable testId="available-gates-forbidden" />
      ) : available.state.status === 'error' ? (
        <ErrorBanner
          error={available.state.error}
          title={t('无法加载平台目录', 'Could not load the platform catalog')}
          onRetry={() => void available.reload()}
          testId="available-gates-error"
        />
      ) : rows.length === 0 ? (
        platformAdmin ? (
          <EmptyCatalogForAdmin http={http} />
        ) : (
          <EmptyState
            title={t('平台目录里还没有可启用的实例', 'Nothing to enable yet')}
            body={t(
              '需要平台管理员在「平台 → 集成」里启用一个门实例，并把它的接入包设为「平台预置」，它才会出现在这里。请联系平台管理员。',
              'A platform administrator has to enable a gate instance under Platform → Integrations and set its connector to platform preset before it shows up here. Ask a platform administrator.',
            )}
            testId="available-gates-empty"
          />
        )
      ) : (
        // Legacy 388 (UX acceptance of #632): at ≤ 768px each instance is one card — its name and
        // what this workspace can do with it (启用, or 已启用 with 录入我的凭证, or why not) in the
        // card's header, connector, platform status, health and Operation count under it — instead
        // of a six-column table whose 本工作区 column sat off-screen to the right.
        <DataTable
          columns={availableGateColumns(
            { http, canEnable, canEnterCredential, platformAdmin, enabledResults },
            handleEnabled,
            t,
          )}
          data={rows}
          getRowId={(row) => row.gateId}
          ariaLabel={t('待启用的平台实例', 'Platform instances pending enable')}
          testId="available-gates-table"
          rowTestId={(row) => `available-gate-${row.gateId}`}
        />
      )}
      {platformAdmin && rows.length > 0 ? <HiddenInstancesForAdmin http={http} /> : null}
    </div>
  );
}

/**
 * UX acceptance of #538 (out of scope there): the empty catalog already says when enabled
 * instances are missing because their connector is not platform preset (`EmptyCatalogForAdmin`);
 * a catalog that lists some instances said nothing about the others. For a platform administrator
 * only — the one who can change it — and silent when the platform reads fail.
 */
function HiddenInstancesForAdmin({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const instances = useCapabilityList<GateInstanceWire>(
    http,
    'list_gate_instances',
    ALL_GATE_INSTANCES,
  );
  const connectors = useConnectorsByName(http);
  const { workspaceId } = useWorkspaceIdentity(http);
  // UX acceptance of #567 P2: an instance this workspace already enabled is right above, as a
  // system card, and keeps working — only the ones this workspace has not enabled are missing
  // here. The enabling-workspace list is capped (`enablingWorkspaces`), so a row whose list is
  // cut short and does not name this workspace is left out rather than claimed missing.
  const notEnabledHere = (row: GateInstanceWire): boolean =>
    enabledHere(row, workspaceId) === false;
  const hidden =
    instances.state.status === 'ready' && workspaceId !== null
      ? instances.state.data.items.filter(
          (row) => hiddenFromWorkspaces(row, connectors) !== null && notEnabledHere(row),
        )
      : [];
  if (hidden.length === 0) return null;
  return (
    <Notice testId="available-gates-hidden">
      {t(
        `平台上另有 ${hidden.length} 个已启用、但本工作区还没启用的门实例这里看不到：${hidden.map((row) => row.displayName).join('、')}。它们的接入包不是「平台预置」。`,
        `${hidden.length} more enabled gate instance(s) this workspace has not enabled do not show up here: ${hidden.map((row) => row.displayName).join(', ')}. Their connectors are not platform preset.`,
      )}
      {t('', ' ')}
      <RouteLink
        href={hrefs.platformIntegrations()}
        testId="available-gates-hidden-link"
        whenRefused="hide"
      >
        {t('打开平台集成', 'Open platform integrations')}
      </RouteLink>
    </Notice>
  );
}

interface AvailableGateCellContext {
  readonly http: CapabilityCaller;
  readonly canEnable: boolean;
  readonly canEnterCredential: boolean;
  readonly platformAdmin: boolean;
  readonly enabledResults: ReadonlyMap<string, EnableGateInstanceResultWire>;
}

/** The 待启用的平台实例 table's columns (`kit/data-table`): the instance is the card title and what
 *  this workspace can do with it sits next to it (`primary` / `high`); connector, platform status,
 *  health and Operation count become label / value pairs at ≤ 768px. Cells that can run long wrap
 *  instead of being cut (`whitespace-normal` — a card's title and values are single-line by
 *  default). */
function availableGateColumns(
  context: AvailableGateCellContext,
  onEnabled: (row: AvailableGateInstanceWire, result: EnableGateInstanceResultWire) => void,
  t: Translate,
): readonly DataTableColumn<AvailableGateInstanceWire>[] {
  return [
    {
      id: 'name',
      header: t('名称', 'Name'),
      priority: 'primary',
      cell: (row) => (
        <div className="whitespace-normal">
          <div>{row.displayName}</div>
          <div className="mono text-3 text-small font-normal" style={{ overflowWrap: 'anywhere' }}>
            {row.gateId}
          </div>
        </div>
      ),
    },
    {
      id: 'connector',
      header: t('接入包', 'Connector'),
      cellClassName: 'mono',
      cell: (row) => row.connector,
    },
    {
      id: 'status',
      header: t('平台状态', 'Platform status'),
      cell: (row) => (
        <StatusChip
          machine="gateInstance"
          status={row.status}
          size="s"
          testId={`available-gate-status-${row.gateId}`}
        />
      ),
    },
    {
      id: 'health',
      header: t('健康', 'Health'),
      cell: (row) => <StatusChip machine="gateHealth" status={row.health} size="s" />,
    },
    {
      id: 'operations',
      header: 'Operation 数',
      cellClassName: 'mono',
      cell: (row) => row.operationCount,
    },
    {
      id: 'workspace',
      header: t('本工作区', 'This workspace'),
      priority: 'high',
      cell: (row) => (
        <AvailableGateWorkspaceCell
          {...context}
          row={row}
          enabledResult={context.enabledResults.get(row.gateId) ?? null}
          onEnabled={(result) => onEnabled(row, result)}
        />
      ),
    },
  ];
}

/** One row's 本工作区 cell — a component, not a cell function, because `GateCredentialEntry` and
 *  `EnableGateConfirm` own state of their own. */
function AvailableGateWorkspaceCell({
  http,
  row,
  enabledResult,
  onEnabled,
  canEnable,
  canEnterCredential,
  platformAdmin,
}: Omit<AvailableGateCellContext, 'enabledResults'> & {
  readonly row: AvailableGateInstanceWire;
  readonly enabledResult: EnableGateInstanceResultWire | null;
  readonly onEnabled: (result: EnableGateInstanceResultWire) => void;
}) {
  const t = useT();

  // B7: the platform side must be `enabled` for the kernel to accept a workspace enable; a row
  // that is here only because this workspace linked it earlier (platform `disabled` / `lost`)
  // shows its link but no button.
  const platformEnabled = row.status === 'enabled';
  // The kernel refuses a workspace enable of an instance that has announced no Operations yet
  // (`requireAvailable`'s 409 `gate_not_ready`: it would publish nothing and leave a useless link),
  // so that row says so instead of offering the button.
  const announcedOperations = row.operationCount > 0;
  const published = enabledResult?.publishedOperationNames.length ?? null;

  return (
    <div className="whitespace-normal">
      {row.gatekeeperId ? (
        <div className="stack-s">
          {/* Legacy 388: on a card this cell has no 本工作区 header over it, and 平台状态 also
              reads 已启用 — so the link says whose. */}
          <a href={hrefs.gatekeeper(row.gatekeeperId)}>{t('本工作区已启用', 'Enabled here')}</a>
          {canEnterCredential ? (
            <GateCredentialEntry
              requestToken={() =>
                http.call<GateHostTokenWire>('issue_gate_credential_token', {
                  gateId: row.gateId,
                })
              }
              tokenButtonLabel={t('录入我的凭证', 'Enter my credential')}
            />
          ) : null}
        </div>
      ) : !platformEnabled ? (
        <span className="muted" data-testid={`available-gate-not-enableable-${row.gateId}`}>
          {t('平台侧未启用', 'Not enabled on the platform')}
        </span>
      ) : !announcedOperations ? (
        <span className="muted" data-testid={`available-gate-not-ready-${row.gateId}`}>
          {t(
            '还没有声明任何 Operation，暂不能启用：等门自注册后再来。',
            'No Operations announced yet, so it cannot be enabled — come back once the gate announces.',
          )}
        </span>
      ) : canEnable ? (
        <EnableGateConfirm
          key={row.gateId}
          http={http}
          gateId={row.gateId}
          gateDisplayName={row.displayName}
          onEnabled={onEnabled}
          platformAdmin={platformAdmin}
          testId={`enable-gate-${row.gateId}`}
        />
      ) : (
        // #554 acceptance (242① class): not a bare "owner enables" — the request to send them.
        <AskOwnerToEnable
          compact
          gateName={row.displayName}
          testId={`available-gate-ask-owner-${row.gateId}`}
        />
      )}
      {published !== null ? (
        <Notice>
          {t(`已发布 ${published} 个 Operation`, `Published ${published} operation(s)`)}
        </Notice>
      ) : null}
      {enabledResult !== null ? (
        <HeldDraftsNotice
          drafts={enabledResult.gateOwnedParamDrafts}
          gatekeeperId={enabledResult.gatekeeperId}
          fix="align"
          testId={`available-gate-held-${row.gateId}`}
        />
      ) : null}
    </div>
  );
}

const ALL_GATE_INSTANCES: Readonly<Record<string, unknown>> = {};

/**
 * Audit P0-4: an empty workspace catalog has three different causes, and only the platform's own
 * instance list (`list_gate_instances`, admin-only) can tell them apart — instances discovered but
 * not enabled (the common first-run case: the step is 启用 in that instance's drawer), instances
 * enabled whose connector is not platform preset, or no instance at all. Each gets its own
 * sentence and a link to the exact place the next step happens.
 */
function EmptyCatalogForAdmin({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const instances = useCapabilityList<GateInstanceWire>(
    http,
    'list_gate_instances',
    ALL_GATE_INSTANCES,
  );
  if (instances.state.status === 'loading') {
    return (
      <SkeletonRows
        count={1}
        label={t('正在查看平台上的门实例…', 'Checking the platform gate instances')}
        testId="available-gates-empty-loading"
      />
    );
  }
  if (instances.state.status === 'error') {
    return (
      <ErrorBanner
        error={instances.state.error}
        title={t('无法读取平台门实例', 'Could not read the platform gate instances')}
        onRetry={() => void instances.reload()}
        testId="available-gates-empty-error"
      />
    );
  }
  const items = instances.state.data.items;
  const notEnabled = items.filter(
    (row) => row.status === 'discovered' || row.status === 'disabled',
  );
  const enabled = items.filter((row) => row.status === 'enabled');
  if (notEnabled.length > 0) {
    return (
      <EmptyState
        title={t(
          `平台上有 ${notEnabled.length} 个门实例还没启用`,
          `${notEnabled.length} gate instance(s) on the platform are not enabled yet`,
        )}
        body={t(
          '打开实例，确认它公布的 Operation 后点「启用」；接入包是「平台预置」时，它随即出现在这里供本工作区启用。',
          'Open the instance, check the operations it announces and press Enable; once its connector is platform preset it shows up here for this workspace.',
        )}
        action={
          <span className="row row-wrap">
            {notEnabled.slice(0, 3).map((row) => (
              <RouteLink
                key={row.gateId}
                href={hrefs.platformGateInstance(row.gateId)}
                className="inline-flex min-h-9 items-center"
                testId="available-gates-enable-link"
                refused={t(
                  `请平台管理员启用：${row.displayName}`,
                  `Ask a platform administrator to enable ${row.displayName}`,
                )}
              >
                {t(`去启用：${row.displayName}`, `Enable ${row.displayName}`)}
              </RouteLink>
            ))}
          </span>
        }
        testId="available-gates-empty"
      />
    );
  }
  if (enabled.length > 0) {
    return (
      <EmptyState
        title={t(
          `平台已启用 ${enabled.length} 个门实例，但它们的接入包还不是「平台预置」`,
          `${enabled.length} gate instance(s) are enabled, but their connectors are not platform preset`,
        )}
        body={t(
          '在「平台 → 集成」里把接入包设为「平台预置」后，它的实例就会出现在这里。',
          'Set the connector to platform preset under Platform → Integrations and its instances show up here.',
        )}
        action={
          <RouteLink
            href={hrefs.platformIntegrations()}
            className="inline-flex min-h-9 items-center"
            testId="available-gates-integrations-link"
            whenRefused="hide"
          >
            {t('打开平台集成', 'Open platform integrations')}
          </RouteLink>
        }
        testId="available-gates-empty"
      />
    );
  }
  return (
    <EmptyState
      title={t('平台上还没有任何门实例', 'No gate instance on the platform yet')}
      body={t(
        '门实例启动后会自己出现在「平台 → 集成」里。用本页的「接入一个系统」按步骤开始。',
        'A gate instance appears under Platform → Integrations once it starts. Use Connect a system on this page to begin.',
      )}
      testId="available-gates-empty"
    />
  );
}
