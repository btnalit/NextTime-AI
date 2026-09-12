import type { PlatformWorkspaceWire, UserMembershipWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import type { ModelRow } from '../../lib/governance.js';
import { HttpError } from '../../lib/http-client.js';
import { Button } from '../ui/Button.js';
import { CopyId } from '../ui/CopyId.js';
import { Field, Input } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PlatformError } from './PlatformError.js';
import { UserPicker } from './UserPicker.js';
import { AllowedModelsChecklist, EntryModelSelect } from './WorkspaceModelControls.js';

export interface WorkspaceDetailPanelProps {
  readonly http: CapabilityCaller;
  readonly workspace: PlatformWorkspaceWire;
  /** The llm-proxy catalog (`list_platform_models`). */
  readonly models: readonly ModelRow[];
  /** Whether `models` is the catalog rather than "not read yet / the read failed". A workspace
   *  that does not restrict its models draws the entry-model options from the catalog, so an
   *  empty one would leave the saved `entryModel` with no matching `<option>` — the select would
   *  read 平台默认 and the next interaction would clear it. Both model controls stay disabled
   *  until the catalog is actually known. */
  readonly modelsReady: boolean;
  /** A capability answered with a fresh `PlatformWorkspaceWire` for this row. */
  readonly onChanged: (workspace: PlatformWorkspaceWire) => void;
  /** An owner was delegated — `add_membership`/`set_membership_role` answer with a membership,
   *  not a workspace, so the list has to be re-read to pick up `owners`/`memberCount`. */
  readonly onDelegated: () => void;
  /** The signed-in administrator is a member of this workspace and asked to open its own
   *  configuration pages; `undefined` when they are not a member (P-A2 does not implement acting
   *  in a workspace without a membership). */
  readonly onOpenWorkspaceConfig?: () => void;
}

/**
 * components/platform/WorkspaceDetailPanel: one workspace's drawer body (P-A2, design §2
 * "工作区配置归管理面" / §5 "工作区配置" row) — `update_workspace` (rename + entry model),
 * `set_allowed_models`, `set_workspace_status`, and owner delegation through the platform's own
 * `add_membership` / `set_membership_role`.
 *
 * Disabling gets a same-drawer confirm step (the shape `UserDetailPanel` established for
 * `set_user_status`) because it is the most destructive thing on this page: every session in the
 * workspace dies at once. The platform default workspace cannot be disabled at all — the kernel
 * refuses it with `default_workspace`, and this panel says so up front rather than offering a
 * button that can only fail.
 *
 * The entry-model options come from the workspace's **saved** `allowedModels`, never from the
 * checklist's draft: the two are separate writes, and `set_allowed_models` is exactly where the
 * kernel's `entry_model_not_allowed` rule is meant to be met and shown.
 */
export function WorkspaceDetailPanel({
  http,
  workspace,
  models,
  modelsReady,
  onChanged,
  onDelegated,
  onOpenWorkspaceConfig,
}: WorkspaceDetailPanelProps) {
  const [name, setName] = useState(workspace.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<unknown | null>(null);

  const [savingEntryModel, setSavingEntryModel] = useState(false);
  const [entryModelError, setEntryModelError] = useState<unknown | null>(null);

  const [allowedModels, setAllowedModels] = useState<readonly string[]>(workspace.allowedModels);
  const [savingAllowed, setSavingAllowed] = useState(false);
  const [allowedError, setAllowedError] = useState<unknown | null>(null);

  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusError, setStatusError] = useState<unknown | null>(null);

  const [ownerUserId, setOwnerUserId] = useState('');
  const [delegating, setDelegating] = useState(false);
  const [delegateError, setDelegateError] = useState<unknown | null>(null);

  const nameDirty = name.trim() !== workspace.name && name.trim().length > 0;
  const allowedDirty =
    allowedModels.length !== workspace.allowedModels.length ||
    allowedModels.some((model) => !workspace.allowedModels.includes(model));
  const entryModelOptions =
    workspace.allowedModels.length > 0 ? workspace.allowedModels : models.map((model) => model.id);

  async function saveName(): Promise<void> {
    if (!nameDirty || savingName) return;
    setSavingName(true);
    setNameError(null);
    try {
      onChanged(
        await http.call<PlatformWorkspaceWire>('update_workspace', {
          workspaceId: workspace.id,
          name: name.trim(),
        }),
      );
    } catch (err) {
      setNameError(err);
    } finally {
      setSavingName(false);
    }
  }

  /** Saved as it is picked (a one-control section with no other field to batch it with), the way
   *  `UserMembershipsPanel`'s own role select writes on change. */
  async function saveEntryModel(entryModel: string | null): Promise<void> {
    if (savingEntryModel) return;
    setSavingEntryModel(true);
    setEntryModelError(null);
    try {
      onChanged(
        await http.call<PlatformWorkspaceWire>('update_workspace', {
          workspaceId: workspace.id,
          entryModel,
        }),
      );
    } catch (err) {
      setEntryModelError(err);
    } finally {
      setSavingEntryModel(false);
    }
  }

  async function saveAllowedModels(): Promise<void> {
    if (!allowedDirty || savingAllowed) return;
    setSavingAllowed(true);
    setAllowedError(null);
    try {
      onChanged(
        await http.call<PlatformWorkspaceWire>('set_allowed_models', {
          workspaceId: workspace.id,
          allowedModels: [...allowedModels],
        }),
      );
    } catch (err) {
      setAllowedError(err);
    } finally {
      setSavingAllowed(false);
    }
  }

  async function setStatus(status: 'active' | 'disabled'): Promise<void> {
    if (changingStatus || (status === 'disabled' && workspace.isDefault)) return;
    setChangingStatus(true);
    setStatusError(null);
    try {
      onChanged(
        await http.call<PlatformWorkspaceWire>('set_workspace_status', {
          workspaceId: workspace.id,
          status,
        }),
      );
      setConfirmingDisable(false);
    } catch (err) {
      setStatusError(err);
    } finally {
      setChangingStatus(false);
    }
  }

  /** 委托 owner. A user who is already in the workspace with some other role is not an error to
   *  the administrator's eye — `add_membership` answers 409 `already_member` for exactly that, so
   *  promote them in place instead. `set_membership_role` is keyed by `{userId, workspaceId}`, so
   *  finding their Principal first is not needed. */
  async function delegateOwner(): Promise<void> {
    if (ownerUserId === '' || delegating) return;
    const params = { userId: ownerUserId, workspaceId: workspace.id, role: 'owner' };
    setDelegating(true);
    setDelegateError(null);
    try {
      try {
        await http.call<UserMembershipWire>('add_membership', params);
      } catch (err) {
        if (!(err instanceof HttpError) || err.code !== 'already_member') throw err;
        await http.call<UserMembershipWire>('set_membership_role', params);
      }
      setOwnerUserId('');
      onDelegated();
    } catch (err) {
      setDelegateError(err);
    } finally {
      setDelegating(false);
    }
  }

  return (
    <div className="stack" data-testid="workspace-detail">
      <dl className="definition-list">
        <dt>Id</dt>
        <dd>
          <CopyId id={workspace.id} label="workspace" />
        </dd>
        <dt>状态 Status</dt>
        <dd>
          <span
            className={`chip chip-s ${workspace.status === 'disabled' ? 'chip-neutral' : 'chip-ok'}`}
            data-testid="workspace-detail-status"
          >
            {workspace.status}
          </span>
          {workspace.isDefault ? (
            <span className="tag" data-testid="workspace-detail-default">
              默认 Default
            </span>
          ) : null}
        </dd>
        <dt>成员数 Members</dt>
        <dd className="mono">{workspace.memberCount}</dd>
        <dt>创建 Created</dt>
        <dd>
          <time title={formatDateTime(workspace.createdAt)}>
            {formatRelative(workspace.createdAt)}
          </time>
        </dd>
      </dl>

      <div className="row">
        {onOpenWorkspaceConfig ? (
          <Button
            variant="secondary"
            size="s"
            icon="arrow-left"
            onClick={onOpenWorkspaceConfig}
            data-testid="open-workspace-config"
          >
            打开工作区配置 Open workspace config
          </Button>
        ) : (
          <Notice testId="workspace-no-membership">
            把自己加为 owner 后即可进入该工作区的配置页（成员与授权、访问、能力目录…）。 Add
            yourself as an owner to reach this workspace's own configuration pages.
          </Notice>
        )}
      </div>

      <div className="divider" />

      <Field id="wd-name" label="名称 Name" required>
        <Input
          id="wd-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={savingName}
        />
      </Field>
      <PlatformError error={nameError} title="无法重命名 Could not rename this workspace" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          onClick={() => void saveName()}
          loading={savingName}
          disabled={!nameDirty}
        >
          保存 Save
        </Button>
      </div>

      <div className="divider" />

      <EntryModelSelect
        id="wd-entry-model"
        options={entryModelOptions}
        value={workspace.entryModel}
        onChange={(entryModel) => void saveEntryModel(entryModel)}
        disabled={savingEntryModel || !modelsReady}
        testId="workspace-entry-model"
      />
      <PlatformError
        error={entryModelError}
        title="无法设置入口模型 Could not set the entry model"
      />

      <div className="divider" />

      <AllowedModelsChecklist
        models={models}
        selected={allowedModels}
        onChange={setAllowedModels}
        disabled={savingAllowed || !modelsReady}
        testId="workspace-allowed-models"
      />
      <PlatformError
        error={allowedError}
        title="无法设置允许的模型 Could not set the allowed models"
        testId="workspace-allowed-models-error"
      />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          onClick={() => void saveAllowedModels()}
          loading={savingAllowed}
          disabled={!allowedDirty || !modelsReady}
        >
          保存允许的模型 Save allowed models
        </Button>
      </div>

      <div className="divider" />

      <div className="stack-s">
        <span>Owners</span>
        {workspace.owners.length === 0 ? (
          <span className="text-3">还没有 owner No owner yet</span>
        ) : (
          <div className="row-wrap" data-testid="workspace-owners">
            {workspace.owners.map((owner) => (
              <span
                key={owner.userId}
                className="chip chip-s chip-info"
                title={owner.displayName}
                data-testid="workspace-owner-chip"
              >
                {owner.login}
              </span>
            ))}
          </div>
        )}
      </div>

      <UserPicker
        http={http}
        id="wd-delegate-owner"
        label="委托 owner Delegate an owner"
        hint="该用户将以 owner 身份加入这个工作区，并在「管理 → 工作区配置」里看到它。已经是成员的会就地升为 owner。 The user joins this workspace as an owner; an existing member is promoted in place."
        value={ownerUserId}
        onChange={setOwnerUserId}
        disabled={delegating}
        exclude={workspace.owners.map((owner) => owner.userId)}
        testId="delegate-owner"
      />
      <PlatformError error={delegateError} title="无法委托 owner Could not delegate an owner" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => void delegateOwner()}
          loading={delegating}
          disabled={ownerUserId === ''}
        >
          委托 Delegate
        </Button>
      </div>

      <div className="divider" />

      <PlatformError error={statusError} title="无法修改状态 Could not change the status" />
      {workspace.status === 'disabled' ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button
            variant="secondary"
            onClick={() => void setStatus('active')}
            loading={changingStatus}
            data-testid="workspace-status-toggle"
          >
            启用 Enable
          </Button>
        </div>
      ) : confirmingDisable ? (
        <div className="stack-s" data-testid="workspace-disable-confirm">
          <Notice tone="warn">
            该工作区所有会话立即失效、成员登录后不可见、数据保留。 Every session in it dies
            immediately, it disappears from its members' logins, and the data is kept.
          </Notice>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setConfirmingDisable(false)}>
              取消 Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void setStatus('disabled')}
              loading={changingStatus}
            >
              确认停用 Confirm disable
            </Button>
          </div>
        </div>
      ) : (
        <>
          {workspace.isDefault ? (
            <Notice testId="workspace-default-undisablable">
              这是平台默认工作区，不能停用；先把默认工作区指到别处。 This is the platform default
              workspace — point the default at another workspace before disabling it.
            </Notice>
          ) : null}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="danger"
              onClick={() => setConfirmingDisable(true)}
              disabled={workspace.isDefault}
              data-testid="workspace-status-toggle"
            >
              停用 Disable
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
