import { ROLE_VALUES, type Role, type UserMembershipWire, type UserWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { roleDescription, roleLabel } from '../../lib/labels.js';
import { WorkspacePicker, useActiveWorkspaces } from '../../lib/users-workspace-picker.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Field, Select as LegacySelect } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PlatformError } from './PlatformError.js';

export interface UserMembershipsPanelProps {
  readonly http: CapabilityCaller;
  readonly user: UserWire;
  /** A membership was added / re-roled / removed — the caller re-reads `list_users`, which is
   *  what carries `memberships` (there is no per-user read this panel could refresh on its own
   *  without dropping the row's other columns out of sync). */
  readonly onChanged: () => void;
  readonly onBack: () => void;
}

/**
 * components/platform/UserMembershipsPanel: the 成员资格 Memberships drawer (P-A1, design §6.1
 * "成员资格抽屉（加入 / 改角色 / 移出）") — `add_membership`, `set_membership_role`,
 * `remove_membership`. Opened from `UserDetailPanel` and rendered in the *same* `Drawer` (the
 * page's single-panel state union), never nested inside it: two focus traps on screen at once
 * fight over Tab and Esc.
 *
 * The workspace picker lists every active workspace (`list_workspaces`, via
 * `lib/users-workspace-picker.tsx`) minus the ones this user already holds a membership in —
 * disabled memberships included, since `add_membership` would refuse those as duplicates.
 */
export function UserMembershipsPanel({ http, user, onChanged, onBack }: UserMembershipsPanelProps) {
  const t = useT();
  const held = user.memberships.map((membership) => membership.workspaceId);
  const workspaces = useActiveWorkspaces(http);
  const [workspaceChoice, setWorkspaceChoice] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<unknown | null>(null);

  const workspaceId = workspaceChoice;

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
          {t('返回用户', 'Back to the user')}
        </Button>
      </div>

      {user.memberships.length === 0 ? (
        <EmptyState
          icon="users"
          title={t('还不属于任何工作区', 'No workspace memberships yet')}
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

      <WorkspacePicker
        id="um-workspace"
        label={t('加入工作区', 'Add to a workspace')}
        value={workspaceChoice}
        onChange={setWorkspaceChoice}
        disabled={adding}
        workspaces={workspaces}
        exclude={held}
        leading={<option value="">{t('选择工作区', 'Pick a workspace')}</option>}
        emptyText={t('已加入所有可用的工作区。', 'Already a member of every active workspace.')}
        testId="user-memberships-workspace"
      />

      <Field
        id="um-role"
        label={t('角色', 'Role')}
        required
        hint={roleDescription(role, t) ?? undefined}
      >
        <LegacySelect
          id="um-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          disabled={adding}
        >
          {ROLE_VALUES.map((value) => (
            <option key={value} value={value}>
              {roleLabel(value, t)}
            </option>
          ))}
        </LegacySelect>
      </Field>

      <PlatformError
        error={addError}
        title={t('无法加入工作区', 'Could not add this membership')}
      />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => void add()}
          loading={adding}
          disabled={workspaceId === ''}
        >
          {t('加入', 'Add')}
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
  const t = useT();
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
          {membership.disabled ? <span className="tag">{t('已停用', 'Disabled')}</span> : null}
          {membership.workspaceStatus === 'disabled' ? (
            <span className="tag text-danger">{t('工作区已停用', 'Workspace disabled')}</span>
          ) : null}
        </div>
        <div className="data-row-meta">
          <span className="mono">{membership.workspaceId}</span>
        </div>
        <div className="row-wrap">
          <label className="field-label" htmlFor={roleFieldId}>
            {t('角色', 'Role')}
          </label>
          <LegacySelect
            id={roleFieldId}
            title={roleDescription(role, t) ?? undefined}
            value={role}
            onChange={(event) => void saveRole(event.target.value as Role)}
            disabled={saving || removing}
          >
            {ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value, t)}
              </option>
            ))}
          </LegacySelect>
          {confirmingRemove ? (
            <>
              <Button variant="ghost" size="s" onClick={() => setConfirmingRemove(false)}>
                {t('取消', 'Cancel')}
              </Button>
              <Button variant="danger" size="s" onClick={() => void remove()} loading={removing}>
                {t('确认移出', 'Confirm remove')}
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="s" onClick={() => setConfirmingRemove(true)}>
              {t('移出', 'Remove')}
            </Button>
          )}
        </div>
        {confirmingRemove ? (
          <Notice tone="warn">
            {t(
              '移出会停用该工作区的成员 Principal 并吊销其会话；Principal 行保留做审计溯源。',
              'Removing disables the membership Principal and revokes its sessions; the row is kept for audit lineage.',
            )}
          </Notice>
        ) : null}
        <PlatformError
          error={error}
          title={t('无法修改成员资格', 'Could not change this membership')}
        />
      </div>
    </li>
  );
}
