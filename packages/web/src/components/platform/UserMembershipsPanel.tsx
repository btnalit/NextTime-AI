import { ROLE_VALUES, type Role, type UserMembershipWire, type UserWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { WorkspaceOption } from '../../lib/platform-workspaces.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Field, Input, Select } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PlatformError } from './PlatformError.js';

export interface UserMembershipsPanelProps {
  readonly http: CapabilityCaller;
  readonly user: UserWire;
  readonly workspaces: readonly WorkspaceOption[];
  /** A membership was added / re-roled / removed — the caller re-reads `list_users`, which is
   *  what carries `memberships` (there is no per-user read this panel could refresh on its own
   *  without dropping the row's other columns out of sync). */
  readonly onChanged: () => void;
  readonly onBack: () => void;
}

const OTHER_WORKSPACE = '__other__';

/**
 * components/platform/UserMembershipsPanel: the 成员资格 Memberships drawer (P-A1, design §6.1
 * "成员资格抽屉（加入 / 改角色 / 移出）") — `add_membership`, `set_membership_role`,
 * `remove_membership`. Opened from `UserDetailPanel` and rendered in the *same* `Drawer` (the
 * page's single-panel state union), never nested inside it: two focus traps on screen at once
 * fight over Tab and Esc.
 *
 * The workspace picker's options come from `lib/platform-workspaces.ts` (the union of the loaded
 * users' own memberships plus the platform default) and always include a typed-id escape hatch —
 * `list_workspaces` is a P-A2 capability, see that module's doc comment.
 */
export function UserMembershipsPanel({
  http,
  user,
  workspaces,
  onChanged,
  onBack,
}: UserMembershipsPanelProps) {
  const held = new Set(user.memberships.map((membership) => membership.workspaceId));
  const [workspaceChoice, setWorkspaceChoice] = useState('');
  const [otherWorkspaceId, setOtherWorkspaceId] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<unknown | null>(null);

  const workspaceId =
    workspaceChoice === OTHER_WORKSPACE ? otherWorkspaceId.trim() : workspaceChoice;

  async function add(): Promise<void> {
    if (workspaceId === '' || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await http.call<UserMembershipWire>('add_membership', {
        userId: user.id,
        workspaceId,
        role,
      });
      setWorkspaceChoice('');
      setOtherWorkspaceId('');
      onChanged();
    } catch (err) {
      setAddError(err);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="stack" data-testid="user-memberships">
      <div className="row">
        <Button variant="ghost" size="s" icon="arrow-left" onClick={onBack}>
          返回用户 Back to the user
        </Button>
      </div>

      {user.memberships.length === 0 ? (
        <EmptyState
          icon="users"
          title="还不属于任何工作区 No workspace memberships yet"
          testId="user-memberships-empty"
        />
      ) : (
        <ul className="data-list" aria-label="Memberships" data-testid="user-memberships-list">
          {user.memberships.map((membership) => (
            <MembershipRow
              key={membership.workspaceId}
              http={http}
              userId={user.id}
              membership={membership}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}

      <div className="divider" />

      <Field id="um-workspace" label="加入工作区 Add to a workspace">
        <Select
          id="um-workspace"
          value={workspaceChoice}
          onChange={(event) => setWorkspaceChoice(event.target.value)}
          disabled={adding}
        >
          <option value="">选择工作区 Pick a workspace</option>
          {workspaces
            .filter((workspace) => !held.has(workspace.id))
            .map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          <option value={OTHER_WORKSPACE}>其他（输入 id）Other — type an id</option>
        </Select>
      </Field>

      {workspaceChoice === OTHER_WORKSPACE ? (
        <Field id="um-workspace-id" label="工作区 id Workspace id" required>
          <Input
            id="um-workspace-id"
            value={otherWorkspaceId}
            onChange={(event) => setOtherWorkspaceId(event.target.value)}
            disabled={adding}
            mono
          />
        </Field>
      ) : null}

      <Field id="um-role" label="角色 Role" required>
        <Select
          id="um-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          disabled={adding}
        >
          {ROLE_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </Field>

      <PlatformError error={addError} title="无法加入工作区 Could not add this membership" />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => void add()}
          loading={adding}
          disabled={workspaceId === ''}
        >
          加入 Add
        </Button>
      </div>
    </div>
  );
}

function MembershipRow({
  http,
  userId,
  membership,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly userId: string;
  readonly membership: UserMembershipWire;
  readonly onChanged: () => void;
}) {
  const [role, setRole] = useState<Role>(membership.role);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function saveRole(next: Role): Promise<void> {
    setRole(next);
    setSaving(true);
    setError(null);
    try {
      await http.call<UserMembershipWire>('set_membership_role', {
        userId,
        workspaceId: membership.workspaceId,
        role: next,
      });
      onChanged();
    } catch (err) {
      setRole(membership.role);
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    setRemoving(true);
    setError(null);
    try {
      await http.call('remove_membership', { userId, workspaceId: membership.workspaceId });
      setConfirmingRemove(false);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(false);
    }
  }

  const roleFieldId = `um-role-${membership.workspaceId}`;

  return (
    <li className="data-row" data-testid="user-membership-row">
      <div className="data-row-main">
        <div className="data-row-title">
          <span className="truncate">{membership.workspaceName}</span>
          {membership.disabled ? <span className="tag">disabled</span> : null}
          {membership.workspaceStatus === 'disabled' ? (
            <span className="tag text-danger">workspace disabled</span>
          ) : null}
        </div>
        <div className="data-row-meta">
          <span className="mono">{membership.workspaceId}</span>
        </div>
        <div className="row-wrap">
          <label className="field-label" htmlFor={roleFieldId}>
            角色 Role
          </label>
          <Select
            id={roleFieldId}
            value={role}
            onChange={(event) => void saveRole(event.target.value as Role)}
            disabled={saving || removing}
          >
            {ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          {confirmingRemove ? (
            <>
              <Button variant="ghost" size="s" onClick={() => setConfirmingRemove(false)}>
                取消 Cancel
              </Button>
              <Button variant="danger" size="s" onClick={() => void remove()} loading={removing}>
                确认移出 Confirm remove
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="s" onClick={() => setConfirmingRemove(true)}>
              移出 Remove
            </Button>
          )}
        </div>
        {confirmingRemove ? (
          <Notice tone="warn">
            移出会停用该工作区的成员 Principal 并吊销其会话；Principal 行保留做审计溯源。 Removing
            disables the membership Principal and revokes its sessions; the row is kept for audit
            lineage.
          </Notice>
        ) : null}
        <PlatformError error={error} title="无法修改成员资格 Could not change this membership" />
      </div>
    </li>
  );
}
