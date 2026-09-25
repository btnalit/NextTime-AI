import type {
  PiDriftWire,
  PlatformWorkspaceWire,
  ResidentContainerWire,
  RollEntryContainersResultWire,
  RuntimeImageWire,
  RuntimeInventoryWire,
} from '@nexttime/shared';
import { useMemo, useState } from 'react';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { Confirm } from '../kit/confirm.js';
import { DataTable, type DataTableColumn } from '../kit/data-table.js';
import { PageHeader } from '../kit/page-header.js';
import { RefChip as KitRefChip } from '../kit/ref-chip.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { useToast } from '../ui/Toast.js';

export interface PlatformRuntimePageProps {
  readonly http: CapabilityCaller;
}

const ACTIVE_IMAGE_SOURCE_LABEL: Readonly<
  Record<RuntimeInventoryWire['activeImageSource'], { readonly zh: string; readonly en: string }>
> = {
  setting: { zh: '平台设置', en: 'platform setting' },
  env_default: { zh: 'supervisor 环境变量缺省', en: 'worker-supervisor env default' },
  unknown: { zh: '未知（供应商不可达）', en: 'unknown — worker-supervisor unreachable' },
};

/** A digest's own display form — `RuntimeImageWire.id` is always `sha256:<64 hex>` (this platform
 *  never pushes the image to a registry, so this *is* "the image digest" throughout §6.5 — see
 *  the kernel's own `RuntimeImageWireSchema` doc comment). Strips the algorithm prefix and keeps
 *  12 hex characters — enough to tell two builds of the same tag apart in a list; `CopyId` carries
 *  the exact value on hover/copy. */
function shortImageId(id: string): string {
  const stripped = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
  return stripped.length > 12 ? `${stripped.slice(0, 12)}…` : stripped;
}

/**
 * components/platform/PlatformRuntimePage: 运行层 Runtime (`#/platform/runtime`, admin only —
 * design doc §6.5 / §6.7; docs/development-tasks.md §5d S7-E E1–E3). The console side of the
 * runtime layer the S7-E backend lane shipped (`application/platform/runtime.ts` — `runtime_
 * inventory` / `list_runtime_images` / `set_active_runtime_image` / `rollback_runtime_image` /
 * `roll_entry_containers` / `pi_drift`), all `scope:'platform'`.
 *
 * `runtime_inventory` alone carries everything but the drift panel: the active image (and *how*
 * it was resolved — a platform setting, worker-supervisor's own env default, or genuinely
 * unknown), the full image inventory, and the resident-container list with a live-derived
 * `needsRebuild` (E2's "待重建" — compared by resolved image id, never a tag, and never stored:
 * see that field's own wire comment). `pi_drift` is a second, independent read (E3) so a slow or
 * failing drift check never blocks the rest of the page.
 *
 * Neither mutation restarts anything: `set_active_runtime_image` only changes what the *next*
 * `spawn()` requests (E1) and `roll_entry_containers` only ever stops a container that is both
 * flagged `needsRebuild` and has no in-flight Turn per the kernel's own bookkeeping (E2 — "加速
 * 项，仅此而已"; a busy container always comes back `skipped_in_flight`, never forced). Both
 * confirms say this plainly rather than implying a restart is about to happen.
 *
 * S8 W1-A7 (audit RT2): both confirms are `kit/confirm` `medium` popovers anchored to their own
 * button (设为活动 per image row, 回滚 on the "活动镜像" card) — owned by `RuntimeBody` itself
 * rather than this page, since that is where the buttons render; this page only hands down the
 * two plain async mutations. Roll back is disabled with an explanation when the inventory has
 * fewer than two known images — the kernel's own settings history is not itself on the wire
 * (`RuntimeInventoryWire` carries no previous-value field), so "at least two images known" is the
 * honest, checkable proxy for "there is a different value to roll back to" this page can assert
 * without guessing.
 */
export function PlatformRuntimePage({ http }: PlatformRuntimePageProps) {
  const t = useT();
  const toast = useToast();
  const inventory = useCapability<RuntimeInventoryWire>(http, 'runtime_inventory');
  const drift = useCapability<PiDriftWire>(http, 'pi_drift');
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [rolling, setRolling] = useState(false);

  const workspaceNames = useMemo(() => {
    const map = new Map<string, string>();
    if (workspaces.state.status === 'ready') {
      for (const ws of workspaces.state.data.items) map.set(ws.id, ws.name);
    }
    return map;
  }, [workspaces.state]);

  function toggleSelected(principalId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(principalId)) next.delete(principalId);
      else next.add(principalId);
      return next;
    });
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([inventory.reload(), drift.reload()]);
  }

  async function activate(image: RuntimeImageWire): Promise<void> {
    // Review follow-up (PR #233): `activatableRef` — never `tags[0] ?? id` — is the one identifier
    // the kernel already confirmed both exists as a literal tag on this image *and* normalizes
    // (Docker's own implicit `:latest`) into worker-supervisor's allowlist. The button is disabled
    // whenever this is `null` (see below), so `activate` is never reachable in that state.
    if (!image.activatableRef) return;
    await http.call('set_active_runtime_image', { image: image.activatableRef });
    await refreshAll();
  }

  async function rollback(): Promise<void> {
    await http.call('rollback_runtime_image');
    await refreshAll();
  }

  async function rollEntryContainers(): Promise<void> {
    setRolling(true);
    try {
      const params = selected.size > 0 ? { principalIds: [...selected] } : {};
      const result = await http.call<RollEntryContainersResultWire>(
        'roll_entry_containers',
        params,
      );
      const busy = result.outcomes.filter((o) => o.action === 'skipped_in_flight').length;
      const upToDate = result.outcomes.filter((o) => o.action === 'skipped_up_to_date').length;
      toast.push({
        tone: 'ok',
        title: `已重建 ${result.stoppedCount} 个 rebuilt`,
        description: `跳过：忙碌 ${busy} 个，已是最新 ${upToDate} 个。 Skipped: ${busy} busy, ${upToDate} up to date.`,
      });
      setSelected(new Set());
      void inventory.reload();
    } catch (error) {
      toast.push({
        tone: 'danger',
        title: t('重建失败', 'Rebuild failed'),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRolling(false);
    }
  }

  return (
    <div className="page" data-testid="platform-runtime-page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformRuntime')}
        title={t('运行层', 'Runtime')}
        description={t(
          '跑的是哪个版本的 pi / 镜像 / 扩展，谁待重建，怎么升、怎么回滚。',
          'Which pi / image / extension version is running, what is out of date, and how to roll it forward or back.',
        )}
        actions={
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => void refreshAll()}
            loading={inventory.state.status === 'ready' && inventory.state.refreshing}
            data-testid="runtime-refresh"
          >
            {t('刷新', 'Refresh')}
          </Button>
        }
      />

      {inventory.state.status === 'loading' ? (
        <SkeletonRows
          count={4}
          label={t('正在加载运行时清单…', 'Loading runtime inventory')}
          testId="runtime-loading"
        />
      ) : inventory.state.status === 'error' ? (
        <ErrorBanner
          error={inventory.state.error}
          title={t('无法加载运行时清单', 'Could not load the runtime inventory')}
          onRetry={() => void inventory.reload()}
          testId="runtime-error"
        />
      ) : (
        <RuntimeBody
          data={inventory.state.data}
          workspaceNames={workspaceNames}
          selected={selected}
          onToggleSelected={toggleSelected}
          onActivate={activate}
          onRollback={rollback}
          onRollEntryContainers={() => void rollEntryContainers()}
          rolling={rolling}
        />
      )}

      <Card title={t('pi 版本漂移', 'pi drift')}>
        {drift.state.status === 'loading' ? (
          <SkeletonRows
            count={1}
            label={t('正在加载 pi 漂移…', 'Loading pi drift')}
            testId="pi-drift-loading"
          />
        ) : drift.state.status === 'error' ? (
          <ErrorBanner
            error={drift.state.error}
            title={t('无法加载 pi 漂移', 'Could not load pi drift')}
            onRetry={() => void drift.reload()}
            testId="pi-drift-error"
          />
        ) : (
          <PiDriftBody data={drift.state.data} />
        )}
      </Card>
    </div>
  );
}

function RuntimeBody({
  data,
  workspaceNames,
  selected,
  onToggleSelected,
  onActivate,
  onRollback,
  onRollEntryContainers,
  rolling,
}: {
  readonly data: RuntimeInventoryWire;
  readonly workspaceNames: ReadonlyMap<string, string>;
  readonly selected: ReadonlySet<string>;
  readonly onToggleSelected: (principalId: string) => void;
  readonly onActivate: (image: RuntimeImageWire) => Promise<void>;
  readonly onRollback: () => Promise<void>;
  readonly onRollEntryContainers: () => void;
  readonly rolling: boolean;
}) {
  const t = useT();
  const needsRebuildCount = data.residentContainers.filter((c) => c.needsRebuild).length;
  // S8 W1-A7 (audit RT2): both confirms are anchored to their own button, so their open state is
  // owned here rather than by the page — `activatingImageId` keys which image row's popover (if
  // any) is open, since every row shares the same "设为活动" button and each needs its own.
  const [activatingImageId, setActivatingImageId] = useState<string | null>(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  // Roll back needs at least two known images to have a genuinely different one to switch to —
  // see the module doc comment for why this client-side proxy, not a true "has history" field.
  const canRollBack = data.images.length >= 2;

  // S8 W1-A4 (audit S3): both tables below stay under the 768px overflow width (809px content),
  // so layout="card" (the default) applies. Defined here, inline, rather than a top-level
  // xColumns(...) factory: both close over props (`onActivate`/`data.activeImageInfo`,
  // `workspaceNames`/`selected`/`onToggleSelected`) already local to this component.
  const imageColumns: readonly DataTableColumn<RuntimeImageWire>[] = [
    {
      id: 'tags',
      header: t('标签', 'Tags'),
      priority: 'primary',
      cellClassName: 'mono text-small',
      cell: (image) => image.tags.join(', ') || '—',
    },
    {
      id: 'id',
      header: t('镜像 id', 'Id'),
      cell: (image) => (
        <span className="mono text-small" title={image.id}>
          {shortImageId(image.id)}
        </span>
      ),
    },
    {
      id: 'pi',
      header: 'pi',
      cellClassName: 'mono text-small',
      cell: (image) => image.piVersion ?? '—',
    },
    {
      id: 'platformExtension',
      header: 'platform-extension',
      cellClassName: 'mono text-small',
      cell: (image) => image.platformExtensionVersion ?? '—',
    },
    {
      id: 'builtFrom',
      header: t('构建来源', 'Built from'),
      cellClassName: 'mono text-small',
      cell: (image) => image.builtFrom ?? '—',
    },
    {
      id: 'created',
      header: t('创建', 'Created'),
      cellClassName: 'text-small',
      cell: (image) => (
        <time title={formatDateTime(image.createdAt)}>{formatRelative(image.createdAt)}</time>
      ),
    },
    {
      id: 'actions',
      header: '',
      priority: 'high',
      hideInCard: true,
      cell: (image) => {
        const active = image.id === data.activeImageInfo?.id;
        if (active) {
          return (
            <span className="chip chip-ok" data-testid="runtime-image-active-chip">
              {t('当前', 'Active')}
            </span>
          );
        }
        return (
          <>
            <Confirm
              tier="medium"
              open={activatingImageId === image.id}
              onOpenChange={(open) => setActivatingImageId(open ? image.id : null)}
              anchor={
                <Button
                  variant="ghost"
                  size="s"
                  onClick={() => setActivatingImageId(image.id)}
                  disabled={!image.allowed}
                  title={
                    image.allowed
                      ? undefined
                      : t('未在 WORKER_IMAGE_ALLOWLIST 中 ·', 'Not in WORKER_IMAGE_ALLOWLIST')
                  }
                  data-testid="runtime-image-activate"
                >
                  {t('设为活动', 'Set active')}
                </Button>
              }
              title={t('设为活动镜像', 'Set active image')}
              description={t(
                '已运行的入口容器不会立刻重启——它们在各自下一轮对话开始时按规格漂移自然换成新镜像，进行中的对话不受影响。',
                'Running entry containers are not restarted now — each picks up the new image only at the start of its own next turn (spec-drift rebuild); an in-flight turn is unaffected.',
              )}
              // Shows exactly what will be sent (review follow-up, PR #233) — `activatableRef` may
              // differ from `tags[0]` for a multi-tag image where only a later tag is allowlisted.
              target={image.activatableRef ?? image.tags[0] ?? image.id}
              confirmLabel={t('设为活动', 'Set active')}
              onConfirm={() => onActivate(image)}
              testId="runtime-activate-confirm"
            />
            {!image.allowed ? (
              <div className="text-3 text-small" data-testid="runtime-image-not-allowed-hint">
                {t('未在 WORKER_IMAGE_ALLOWLIST 中 ·', 'Not in WORKER_IMAGE_ALLOWLIST')}
              </div>
            ) : null}
          </>
        );
      },
    },
  ];

  const residentColumns: readonly DataTableColumn<ResidentContainerWire>[] = [
    {
      id: 'select',
      header: '',
      priority: 'high',
      cell: (resident) => (
        <input
          type="checkbox"
          checked={selected.has(resident.principalId)}
          onChange={() => onToggleSelected(resident.principalId)}
          disabled={!resident.needsRebuild}
          title={
            resident.needsRebuild
              ? t('选中以单独重建', 'Select to rebuild individually')
              : t('已是最新，无需选中', 'Already up to date')
          }
          data-testid="runtime-resident-select"
        />
      ),
    },
    {
      id: 'user',
      header: t('用户', 'User'),
      priority: 'primary',
      cell: (resident) => <RefChip kind="principal" id={resident.principalId} size="s" />,
    },
    {
      // S8 W5 (audit RT1): the wire already carried `running`/`status` (worker-supervisor's own
      // `ResidentInventoryEntry`) but the page never rendered them — every row, including one
      // that has already exited (e.g. an orphaned container from a purged workspace, leftover 77),
      // read as indistinguishable from a live one save for the unrelated "待重建" chip.
      id: 'containerState',
      header: t('容器', 'Container'),
      priority: 'high',
      cell: (resident) =>
        resident.running ? (
          <span className="chip chip-ok" data-testid="runtime-resident-running">
            {t('运行中', 'Running')}
          </span>
        ) : (
          <span
            className="chip chip-neutral"
            title={resident.status}
            data-testid="runtime-resident-exited"
          >
            {t('已退出', 'Exited')}
          </span>
        ),
    },
    {
      id: 'status',
      header: t('重建', 'Rebuild'),
      priority: 'high',
      cell: (resident) =>
        resident.needsRebuild ? (
          <span className="chip chip-warn" data-testid="runtime-resident-needs-rebuild">
            {t('待重建', 'Needs rebuild')}
          </span>
        ) : (
          <span className="chip chip-ok">{t('已是最新', 'Up to date')}</span>
        ),
    },
    {
      id: 'workspace',
      header: t('工作区', 'Workspace'),
      cellClassName: 'text-small',
      // S8 W1-A6 (audit S10 "常驻容器列显示已清除工作区的 UUID"): `workspaceNames` only has rows
      // for a workspace `list_workspaces` still returns — a purged one is genuinely gone, so this
      // is the chip's own degrade state ("未知 / 已删除"), not a raw id text node. `list_workspaces`
      // is platform-scope; there is no per-workspace session here to self-resolve through
      // `resolve_refs`, hence a caller-supplied `name` (or none) rather than the `http` prop.
      cell: (resident) => (
        <KitRefChip
          kind="workspace"
          id={resident.workspaceId}
          name={workspaceNames.get(resident.workspaceId)}
          size="s"
        />
      ),
    },
    {
      id: 'image',
      header: t('镜像', 'Image'),
      cellClassName: 'mono text-small',
      cell: (resident) => resident.image ?? '—',
    },
    {
      id: 'started',
      header: t('启动', 'Started'),
      cellClassName: 'text-small',
      cell: (resident) => (
        <time title={formatDateTime(resident.startedAt)}>{formatRelative(resident.startedAt)}</time>
      ),
    },
    {
      id: 'idle',
      header: t('空闲', 'Idle'),
      cellClassName: 'text-small',
      cell: (resident) => (
        <time title={formatDateTime(resident.lastTouchedAt)}>
          {formatRelative(resident.lastTouchedAt)}
        </time>
      ),
    },
  ];

  return (
    <>
      {!data.activeImageInfo ? (
        // S8 W5 (audit L7): this used to live inside its own "活动镜像" card alongside a `<dl>`
        // that duplicated fields the 镜像清单 table below already shows for the same image (see
        // that card's own removal below) — this unresolved-state warning is the one piece of
        // information that table cannot show (there is no row for an image that was never found),
        // so it stays, just no longer wrapped in a now-gone card.
        <Notice tone="warn" testId="runtime-active-image-unresolved">
          {data.activeImage ? (
            <>
              {t(
                <>
                  活动镜像引用 <span className="mono">{data.activeImage}</span>（来源：
                  {ACTIVE_IMAGE_SOURCE_LABEL[data.activeImageSource].zh}
                  ）不在下面的镜像清单里——可能没打平台 label，或 worker-supervisor
                  不可达；此时下方“待重建”一律按“无法判断”显示为否，不猜测。
                </>,
                <>
                  The active image reference <span className="mono">{data.activeImage}</span>{' '}
                  (source: {ACTIVE_IMAGE_SOURCE_LABEL[data.activeImageSource].en}) is not in the
                  inventory below (missing platform labels, or worker-supervisor unreachable) —
                  every "needs rebuild" below reads false rather than guessing.
                </>,
              )}
            </>
          ) : (
            <>
              {t(
                '未设置活动镜像，且无法读到 worker-supervisor 自身的缺省镜像。',
                "No active image is set, and worker-supervisor's own default could not be read.",
              )}
            </>
          )}
        </Notice>
      ) : null}

      <Card
        title={t('镜像清单', 'Images')}
        padded={false}
        actions={
          // S8 W5 (audit L7): moved out of the removed "活动镜像" card — it was never a per-row
          // action, so it belongs at the table's own header, not inside any one row.
          <Confirm
            tier="medium"
            open={rollbackOpen}
            onOpenChange={setRollbackOpen}
            anchor={
              <Button
                variant="secondary"
                size="s"
                onClick={() => setRollbackOpen(true)}
                disabled={!canRollBack}
                title={
                  canRollBack
                    ? undefined
                    : t(
                        '只知道一个（或零个）镜像，没有可回滚到的不同值。',
                        'Only one (or zero) images are known — nothing different to roll back to.',
                      )
                }
                data-testid="runtime-rollback"
              >
                {t('回滚到上一个镜像', 'Roll back')}
              </Button>
            }
            title={t('回滚到上一个镜像', 'Roll back to the previous image')}
            description={
              <>
                改回设置历史里最近一个<em>不同</em>
                {t(
                  '的活动镜像值；再次点击会在最近两个不同值之间来回切换。已运行的入口容器同样只在各自下一轮对话时收敛，不会被强制重启。',
                  'Switches to the most recent',
                )}
                <em>different</em> value in the settings history; calling it again toggles between
                the last two distinct values. Running entry containers converge the same way — at
                their own next turn, never forced.
              </>
            }
            confirmLabel={t('回滚', 'Roll back')}
            onConfirm={onRollback}
            testId="runtime-rollback-confirm"
          />
        }
      >
        {data.images.length === 0 ? (
          <EmptyState
            icon="cpu"
            title={t('还没有带平台 label 的镜像', 'No labelled images yet')}
            body={t(
              '在主机 / CI 上运行 docker compose build worker-runtime（打好三个 ai.nexttime.* label）。',
              'Build worker-runtime on the host/CI with the three ai.nexttime.* labels.',
            )}
            testId="runtime-images-empty"
          />
        ) : (
          <DataTable
            columns={imageColumns}
            data={data.images}
            getRowId={(image) => image.id}
            ariaLabel="Runtime images"
            testId="runtime-images-table"
            rowTestId={(image) => `runtime-image-row-${image.id}`}
            // S8 W5 (audit L7): the active image's row is highlighted instead of being repeated
            // in a separate card — `aria-current` is the same "this is the current one" semantic
            // convention `ui/DataList`'s own `.data-row[aria-current="true"]` rule already uses.
            rowDataAttrs={(image): Readonly<Record<string, string>> =>
              image.id === data.activeImageInfo?.id ? { 'aria-current': 'true' } : {}
            }
          />
        )}
      </Card>

      <Card
        title={t('常驻容器', 'Resident containers')}
        actions={
          <Button
            variant="secondary"
            size="s"
            icon="refresh"
            onClick={onRollEntryContainers}
            loading={rolling}
            disabled={needsRebuildCount === 0}
            data-testid="runtime-roll-entry-containers"
          >
            {selected.size > 0
              ? `现在重建选中的 (${selected.size}) Rebuild selected now`
              : t('现在重建空闲的', 'Rebuild idle now')}
          </Button>
        }
        padded={false}
      >
        {data.residentContainers.length === 0 ? (
          <EmptyState
            icon="cpu"
            title={t('没有常驻入口容器', 'No resident entry containers')}
            testId="runtime-residents-empty"
          />
        ) : (
          <DataTable
            columns={residentColumns}
            data={data.residentContainers}
            getRowId={(resident) => resident.containerId}
            ariaLabel="Resident containers"
            testId="runtime-residents-table"
            rowTestId={(resident) => `runtime-resident-row-${resident.principalId}`}
          />
        )}
      </Card>
    </>
  );
}

function PiDriftBody({ data }: { readonly data: PiDriftWire }) {
  const t = useT();
  return (
    <dl className="definition-list" data-testid="pi-drift-body">
      <dt>{t('状态', 'Status')}</dt>
      <dd>
        <StatusChip machine="piDrift" status={data.status} size="s" testId="pi-drift-status" />
      </dd>
      <dt>{t('锁定的 pi 版本', 'Pinned pi version')}</dt>
      <dd className="mono">{data.pinnedPiVersion ?? t('未知', 'unknown')}</dd>
      <dt>{t('活动镜像自带的 pi 版本', "Active image's pi version")}</dt>
      <dd className="mono">{data.activeImagePiVersion ?? '—'}</dd>
      <dt>platform-extension 版本</dt>
      <dd className="mono">{data.platformExtensionVersion ?? '—'}</dd>
      <dt>{t('详情', 'Detail')}</dt>
      <dd>
        {data.status === 'unknown' && data.pinnedPiVersion === null ? (
          // S8 leftover 59: no host in this deployment pulls the nightly pi-drift.yml artifact
          // automatically (docs/runbooks/pi-upgrade.md §6 has the manual `gh run download` steps)
          // — say that plainly instead of leaving "未知" as the only visible signal, with the
          // kernel's own technical detail (PI_DRIFT_FILE path) still one click away for an
          // operator who wants it.
          <>
            <p data-testid="pi-drift-unknown-honest">
              {t(
                '由 CI 夜间检测（pi-drift 工作流），本次部署尚未接收比对结果——见运行手册 pi-upgrade.md §6。',
                'Checked nightly by CI (the pi-drift workflow) — this deployment has not received the comparison result yet; see the pi-upgrade runbook §6.',
              )}
            </p>
            <details className="disclosure">
              <summary>{t('技术细节', 'Technical details')}</summary>
              <p className="text-3 text-small">{data.detail}</p>
            </details>
          </>
        ) : data.status === 'unknown' ? (
          // S8 W1-A10 (audit S14): the kernel's `unknown` detail can name PI_DRIFT_FILE and "see
          // docs/runbooks" (application/platform/runtime.ts) — never shown inline; behind a
          // disclosure for an operator who needs it.
          <details className="disclosure">
            <summary>{t('技术细节', 'Technical details')}</summary>
            <p className="text-3 text-small">{data.detail}</p>
          </details>
        ) : (
          data.detail
        )}
      </dd>
      <dt>{t('检查时间', 'Checked at')}</dt>
      <dd>{data.checkedAt ? formatDateTime(data.checkedAt) : '—'}</dd>
    </dl>
  );
}
