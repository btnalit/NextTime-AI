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
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmTier } from '../ui/ConfirmTier.js';
import { CopyId } from '../ui/CopyId.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
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

const ACTIVE_IMAGE_SOURCE_LABEL: Readonly<Record<RuntimeInventoryWire['activeImageSource'], string>> = {
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
    await http.call('set_active_runtime_image', { image: image.tags[0] ?? image.id });
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
        breadcrumb={[{ label: '平台 Platform' }, { label: '运行层' }]}
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
          confirm.kind === 'activate' ? (confirm.image.tags[0] ?? confirm.image.id) : undefined
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
  return (
    <>
      <Card
        title="活动镜像 Active image"
        actions={
          <Button
            variant="secondary"
            size="s"
            onClick={onRollback}
            data-testid="runtime-rollback"
          >
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
                below (missing platform labels, or worker-supervisor unreachable) — every
                "needs rebuild" below reads false rather than guessing.
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
          <div className="table-scroll">
            <table className="data-table" data-testid="runtime-images-table">
              <thead>
                <tr>
                  <th>标签 Tags</th>
                  <th>镜像 id Id</th>
                  <th>pi</th>
                  <th>platform-extension</th>
                  <th>构建来源 Built from</th>
                  <th>创建 Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {data.images.map((image) => {
                  const active = image.id === data.activeImageInfo?.id;
                  return (
                    <tr key={image.id} data-testid={`runtime-image-row-${image.id}`}>
                      <td className="mono text-small">{image.tags.join(', ') || '—'}</td>
                      <td>
                        <span className="mono text-small" title={image.id}>
                          {shortImageId(image.id)}
                        </span>
                      </td>
                      <td className="mono text-small">{image.piVersion ?? '—'}</td>
                      <td className="mono text-small">{image.platformExtensionVersion ?? '—'}</td>
                      <td className="mono text-small">{image.builtFrom ?? '—'}</td>
                      <td className="text-small">
                        <time title={formatDateTime(image.createdAt)}>
                          {formatRelative(image.createdAt)}
                        </time>
                      </td>
                      <td>
                        {active ? (
                          <span className="chip chip-ok" data-testid="runtime-image-active-chip">
                            当前 Active
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="s"
                            onClick={() => onActivate(image)}
                            data-testid="runtime-image-activate"
                          >
                            设为活动 Set active
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
          <div className="table-scroll">
            <table className="data-table" data-testid="runtime-residents-table">
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>用户 User</th>
                  <th>工作区 Workspace</th>
                  <th>镜像 Image</th>
                  <th>启动 Started</th>
                  <th>空闲 Idle</th>
                  <th>状态 Status</th>
                </tr>
              </thead>
              <tbody>
                {data.residentContainers.map((resident) => (
                  <ResidentRow
                    key={resident.containerId}
                    resident={resident}
                    workspaceName={workspaceNames.get(resident.workspaceId)}
                    checked={selected.has(resident.principalId)}
                    onToggle={() => onToggleSelected(resident.principalId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function ResidentRow({
  resident,
  workspaceName,
  checked,
  onToggle,
}: {
  readonly resident: ResidentContainerWire;
  readonly workspaceName: string | undefined;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <tr data-testid={`runtime-resident-row-${resident.principalId}`}>
      <td>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!resident.needsRebuild}
          title={
            resident.needsRebuild
              ? '选中以单独重建 Select to rebuild individually'
              : '已是最新，无需选中 Already up to date'
          }
          data-testid="runtime-resident-select"
        />
      </td>
      <td>
        <RefChip kind="principal" id={resident.principalId} size="s" />
      </td>
      <td className="text-small">{workspaceName ?? <span className="text-3">{resident.workspaceId}</span>}</td>
      <td className="mono text-small">{resident.image ?? '—'}</td>
      <td className="text-small">
        <time title={formatDateTime(resident.startedAt)}>{formatRelative(resident.startedAt)}</time>
      </td>
      <td className="text-small">
        <time title={formatDateTime(resident.lastTouchedAt)}>
          {formatRelative(resident.lastTouchedAt)}
        </time>
      </td>
      <td>
        {resident.needsRebuild ? (
          <span className="chip chip-warn" data-testid="runtime-resident-needs-rebuild">
            待重建 Needs rebuild
          </span>
        ) : (
          <span className="chip chip-ok">已是最新 Up to date</span>
        )}
      </td>
    </tr>
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

