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
import { breadcrumbFor } from '../../lib/nav.js';
import { DataTable, type DataTableColumn } from '../kit/data-table.js';
import { PageHeader } from '../kit/page-header.js';
import { RefChip as KitRefChip } from '../kit/ref-chip.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmTier } from '../ui/ConfirmTier.js';
import { CopyId } from '../ui/CopyId.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { useToast } from '../ui/Toast.js';

export interface PlatformRuntimePageProps {
  readonly http: CapabilityCaller;
}

const PI_DRIFT_CHIP_CLASS: Readonly<Record<PiDriftWire['status'], string>> = {
  consistent: 'chip-ok',
  drifted: 'chip-danger',
  unknown: 'chip-neutral',
};

const ACTIVE_IMAGE_SOURCE_LABEL: Readonly<
  Record<RuntimeInventoryWire['activeImageSource'], string>
> = {
  setting: '平台设置 platform setting',
  env_default: 'supervisor 环境变量缺省 worker-supervisor env default',
  unknown: '未知（供应商不可达）unknown — worker-supervisor unreachable',
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

type ConfirmState =
  | { readonly kind: 'none' }
  | { readonly kind: 'activate'; readonly image: RuntimeImageWire }
  | { readonly kind: 'rollback' };

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
 */
export function PlatformRuntimePage({ http }: PlatformRuntimePageProps) {
  const toast = useToast();
  const inventory = useCapability<RuntimeInventoryWire>(http, 'runtime_inventory');
  const drift = useCapability<PiDriftWire>(http, 'pi_drift');
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces');
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: 'none' });
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
        title: '重建失败 Rebuild failed',
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
        title="运行层 Runtime"
        description="跑的是哪个版本的 pi / 镜像 / 扩展，谁待重建，怎么升、怎么回滚。 Which pi / image / extension version is running, what is out of date, and how to roll it forward or back."
        actions={
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => void refreshAll()}
            loading={inventory.state.status === 'ready' && inventory.state.refreshing}
            data-testid="runtime-refresh"
          >
            刷新 Refresh
          </Button>
        }
      />

      {inventory.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading runtime inventory" testId="runtime-loading" />
      ) : inventory.state.status === 'error' ? (
        <ErrorBanner
          error={inventory.state.error}
          title="Could not load the runtime inventory"
          onRetry={() => void inventory.reload()}
          testId="runtime-error"
        />
      ) : (
        <RuntimeBody
          data={inventory.state.data}
          workspaceNames={workspaceNames}
          selected={selected}
          onToggleSelected={toggleSelected}
          onActivate={(image) => setConfirm({ kind: 'activate', image })}
          onRollback={() => setConfirm({ kind: 'rollback' })}
          onRollEntryContainers={() => void rollEntryContainers()}
          rolling={rolling}
        />
      )}

      <Card title="pi 版本漂移 pi drift">
        {drift.state.status === 'loading' ? (
          <SkeletonRows count={1} label="Loading pi drift" testId="pi-drift-loading" />
        ) : drift.state.status === 'error' ? (
          <ErrorBanner
            error={drift.state.error}
            title="Could not load pi drift"
            onRetry={() => void drift.reload()}
            testId="pi-drift-error"
          />
        ) : (
          <PiDriftBody data={drift.state.data} />
        )}
      </Card>

      <ConfirmTier
        tier="medium"
        open={confirm.kind === 'activate'}
        title="设为活动镜像 Set active image"
        description="已运行的入口容器不会立刻重启——它们在各自下一轮对话开始时按规格漂移自然换成新镜像，进行中的对话不受影响。 Running entry containers are not restarted now — each picks up the new image only at the start of its own next turn (spec-drift rebuild); an in-flight turn is unaffected."
        target={
          // Shows exactly what will be sent (review follow-up, PR #233) — `activatableRef` may
          // differ from `tags[0]` for a multi-tag image where only a later tag is allowlisted.
          confirm.kind === 'activate'
            ? (confirm.image.activatableRef ?? confirm.image.tags[0] ?? confirm.image.id)
            : undefined
        }
        confirmLabel="设为活动 Set active"
        onConfirm={() => (confirm.kind === 'activate' ? activate(confirm.image) : undefined)}
        onClose={() => setConfirm({ kind: 'none' })}
        testId="runtime-activate-confirm"
      />
      <ConfirmTier
        tier="medium"
        open={confirm.kind === 'rollback'}
        title="回滚到上一个镜像 Roll back to the previous image"
        description="改回设置历史里最近一个不同的活动镜像值；再次点击会在最近两个不同值之间来回切换。已运行的入口容器同样只在各自下一轮对话时收敛，不会被强制重启。 Switches to the most recent *different* value in the settings history; calling it again toggles between the last two distinct values. Running entry containers converge the same way — at their own next turn, never forced."
        confirmLabel="回滚 Roll back"
        onConfirm={() => (confirm.kind === 'rollback' ? rollback() : undefined)}
        onClose={() => setConfirm({ kind: 'none' })}
        testId="runtime-rollback-confirm"
      />
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
  readonly onActivate: (image: RuntimeImageWire) => void;
  readonly onRollback: () => void;
  readonly onRollEntryContainers: () => void;
  readonly rolling: boolean;
}) {
  const needsRebuildCount = data.residentContainers.filter((c) => c.needsRebuild).length;

  // S8 W1-A4 (audit S3): both tables below stay under the 768px overflow width (809px content),
  // so layout="card" (the default) applies. Defined here, inline, rather than a top-level
  // xColumns(...) factory: both close over props (`onActivate`/`data.activeImageInfo`,
  // `workspaceNames`/`selected`/`onToggleSelected`) already local to this component.
  const imageColumns: readonly DataTableColumn<RuntimeImageWire>[] = [
    {
      id: 'tags',
      header: '标签 Tags',
      priority: 'primary',
      cellClassName: 'mono text-small',
      cell: (image) => image.tags.join(', ') || '—',
    },
    {
      id: 'id',
      header: '镜像 id Id',
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
      header: '构建来源 Built from',
      cellClassName: 'mono text-small',
      cell: (image) => image.builtFrom ?? '—',
    },
    {
      id: 'created',
      header: '创建 Created',
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
        return active ? (
          <span className="chip chip-ok" data-testid="runtime-image-active-chip">
            当前 Active
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="s"
              onClick={() => onActivate(image)}
              disabled={!image.allowed}
              title={
                image.allowed
                  ? undefined
                  : '未在 WORKER_IMAGE_ALLOWLIST 中 · Not in WORKER_IMAGE_ALLOWLIST'
              }
              data-testid="runtime-image-activate"
            >
              设为活动 Set active
            </Button>
            {!image.allowed ? (
              <div className="text-3 text-small" data-testid="runtime-image-not-allowed-hint">
                未在 WORKER_IMAGE_ALLOWLIST 中 · Not in WORKER_IMAGE_ALLOWLIST
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
              ? '选中以单独重建 Select to rebuild individually'
              : '已是最新，无需选中 Already up to date'
          }
          data-testid="runtime-resident-select"
        />
      ),
    },
    {
      id: 'user',
      header: '用户 User',
      priority: 'primary',
      cell: (resident) => <RefChip kind="principal" id={resident.principalId} size="s" />,
    },
    {
      id: 'status',
      header: '状态 Status',
      priority: 'high',
      cell: (resident) =>
        resident.needsRebuild ? (
          <span className="chip chip-warn" data-testid="runtime-resident-needs-rebuild">
            待重建 Needs rebuild
          </span>
        ) : (
          <span className="chip chip-ok">已是最新 Up to date</span>
        ),
    },
    {
      id: 'workspace',
      header: '工作区 Workspace',
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
      header: '镜像 Image',
      cellClassName: 'mono text-small',
      cell: (resident) => resident.image ?? '—',
    },
    {
      id: 'started',
      header: '启动 Started',
      cellClassName: 'text-small',
      cell: (resident) => (
        <time title={formatDateTime(resident.startedAt)}>{formatRelative(resident.startedAt)}</time>
      ),
    },
    {
      id: 'idle',
      header: '空闲 Idle',
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
      <Card
        title="活动镜像 Active image"
        actions={
          <Button variant="secondary" size="s" onClick={onRollback} data-testid="runtime-rollback">
            回滚到上一个镜像 Roll back
          </Button>
        }
      >
        {data.activeImageInfo ? (
          <dl className="definition-list" data-testid="runtime-active-image">
            <dt>标签 Tags</dt>
            <dd className="mono">{data.activeImageInfo.tags.join(', ') || '—'}</dd>
            <dt>镜像 id Image id</dt>
            <dd>
              <CopyId id={data.activeImageInfo.id} label="Image" full />
            </dd>
            <dt>pi 版本</dt>
            <dd className="mono">{data.activeImageInfo.piVersion ?? '—'}</dd>
            <dt>platform-extension 版本</dt>
            <dd className="mono">{data.activeImageInfo.platformExtensionVersion ?? '—'}</dd>
            <dt>构建来源 Built from</dt>
            <dd className="mono">{data.activeImageInfo.builtFrom ?? '—'}</dd>
            <dt>来源 Source</dt>
            <dd>{ACTIVE_IMAGE_SOURCE_LABEL[data.activeImageSource]}</dd>
          </dl>
        ) : (
          <Notice tone="warn" testId="runtime-active-image-unresolved">
            {data.activeImage ? (
              <>
                活动镜像引用 <span className="mono">{data.activeImage}</span>
                （来源：{ACTIVE_IMAGE_SOURCE_LABEL[data.activeImageSource]}）不在下面的镜像清单
                里——可能没打平台 label，或 worker-supervisor 不可达；此时下方"待重建"一律按
                "无法判断"显示为否，不猜测。 The active image reference is not in the inventory
                below (missing platform labels, or worker-supervisor unreachable) — every "needs
                rebuild" below reads false rather than guessing.
              </>
            ) : (
              <>
                未设置活动镜像，且无法读到 worker-supervisor 自身的缺省镜像。 No active image is
                set, and worker-supervisor's own default could not be read.
              </>
            )}
          </Notice>
        )}
      </Card>

      <Card title="镜像清单 Images" padded={false}>
        {data.images.length === 0 ? (
          <EmptyState
            icon="cpu"
            title="还没有带平台 label 的镜像 No labelled images yet"
            body="在主机 / CI 上运行 docker compose build worker-runtime（打好三个 ai.nexttime.* label）。 Build worker-runtime on the host/CI with the three ai.nexttime.* labels."
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
          />
        )}
      </Card>

      <Card
        title="常驻容器 Resident containers"
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
              : '现在重建空闲的 Rebuild idle now'}
          </Button>
        }
        padded={false}
      >
        {data.residentContainers.length === 0 ? (
          <EmptyState
            icon="cpu"
            title="没有常驻入口容器 No resident entry containers"
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
  return (
    <dl className="definition-list" data-testid="pi-drift-body">
      <dt>状态 Status</dt>
      <dd>
        <span className={`chip ${PI_DRIFT_CHIP_CLASS[data.status]}`} data-testid="pi-drift-status">
          {data.status}
        </span>
      </dd>
      <dt>锁定的 pi 版本 Pinned pi version</dt>
      <dd className="mono">{data.pinnedPiVersion ?? '未知 unknown'}</dd>
      <dt>活动镜像自带的 pi 版本 Active image's pi version</dt>
      <dd className="mono">{data.activeImagePiVersion ?? '—'}</dd>
      <dt>platform-extension 版本</dt>
      <dd className="mono">{data.platformExtensionVersion ?? '—'}</dd>
      <dt>详情 Detail</dt>
      <dd>{data.detail}</dd>
      <dt>检查时间 Checked at</dt>
      <dd>{data.checkedAt ? formatDateTime(data.checkedAt) : '—'}</dd>
    </dl>
  );
}
