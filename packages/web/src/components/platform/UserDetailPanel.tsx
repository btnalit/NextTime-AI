import type { PlatformRoleWire, ResetUserPasswordResultWire, UserWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { ENV_ADMIN_TITLE } from '../../lib/platform-errors.js';
import { Button } from '../ui/Button.js';
import { CopyId } from '../ui/CopyId.js';
import { Field, Input, Select } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PlatformError } from './PlatformError.js';

export interface UserDetailPanelProps {
  readonly http: CapabilityCaller;
  readonly user: UserWire;
  /** Every loaded user — the merge target picker's source (design §6.1 "合并（仅待激活用户）"). */
  readonly users: readonly UserWire[];
  /** `NEXTTIME_PLATFORM_ADMINS` logins (design §6.6) — never disabled, never demoted. */
  readonly envAdmins: readonly string[];
  /** A capability that answered with a fresh `UserWire` for this row. */
  readonly onChanged: (user: UserWire) => void;
  /** `merge_user` folded this row into another — the row is gone, the list must be re-read. */
  readonly onMerged: () => void;
  readonly onTemporaryPassword: (login: string, password: string) => void;
  readonly onOpenMemberships: () => void;
}

/** `null` for an empty box (= inherit the platform default), `undefined` for anything that is not
 *  a non-negative integer (the caller refuses to submit). */
function parseBudget(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function budgetInput(value: number | null): string {
  return value === null ? '' : String(value);
}

/**
 * components/platform/UserDetailPanel: one row's drawer body on the users page (P-A1, design
 * §6.1's row actions) — `update_user` (display name + platform role), `set_user_budget`,
 * `reset_user_password`, `set_user_status`, `merge_user`, plus the way into the memberships
 * drawer. Disabling gets a same-drawer confirm step, the shape `PrincipalDetail` established for
 * `disable_principal` (it revokes every console and workspace session the user holds); re-enabling
 * is not destructive and acts directly.
 *
 * A login listed in `NEXTTIME_PLATFORM_ADMINS` can be neither disabled nor demoted — the kernel
 * refuses it with `protected_admin`, and this panel says so up front (disabled control plus the
 * `title` explanation) instead of offering a button that can only fail.
 */
export function UserDetailPanel({
  http,
  user,
  users,
  envAdmins,
  onChanged,
  onMerged,
  onTemporaryPassword,
  onOpenMemberships,
}: UserDetailPanelProps) {
  const protectedAdmin = envAdmins.includes(user.login);

  const [displayName, setDisplayName] = useState(user.displayName);
  const [platformRole, setPlatformRole] = useState<PlatformRoleWire>(user.platformRole);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<unknown | null>(null);

  const [dailyCallLimit, setDailyCallLimit] = useState(budgetInput(user.dailyCallLimit));
  const [monthlyTokenBudget, setMonthlyTokenBudget] = useState(
    budgetInput(user.monthlyTokenBudget),
  );
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetError, setBudgetError] = useState<unknown | null>(null);

  const [customPassword, setCustomPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<unknown | null>(null);

  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusError, setStatusError] = useState<unknown | null>(null);

  const [mergeTargetId, setMergeTargetId] = useState('');
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<unknown | null>(null);

  const profileDirty =
    displayName.trim() !== user.displayName || platformRole !== user.platformRole;
  const parsedDaily = parseBudget(dailyCallLimit);
  const parsedMonthly = parseBudget(monthlyTokenBudget);
  const budgetValid = parsedDaily !== undefined && parsedMonthly !== undefined;
  const budgetDirty =
    dailyCallLimit !== budgetInput(user.dailyCallLimit) ||
    monthlyTokenBudget !== budgetInput(user.monthlyTokenBudget);
  const mergeTargets = users.filter((candidate) => candidate.id !== user.id);

  async function saveProfile(): Promise<void> {
    if (!profileDirty || savingProfile) return;
    const params: Record<string, unknown> = { userId: user.id };
    if (displayName.trim() !== user.displayName) params.displayName = displayName.trim();
    if (platformRole !== user.platformRole) params.platformRole = platformRole;
    setSavingProfile(true);
    setProfileError(null);
    try {
      onChanged(await http.call<UserWire>('update_user', params));
    } catch (err) {
      setProfileError(err);
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveBudget(): Promise<void> {
    if (!budgetValid || !budgetDirty || savingBudget) return;
    setSavingBudget(true);
    setBudgetError(null);
    try {
      onChanged(
        await http.call<UserWire>('set_user_budget', {
          userId: user.id,
          dailyCallLimit: parsedDaily,
          monthlyTokenBudget: parsedMonthly,
        }),
      );
    } catch (err) {
      setBudgetError(err);
    } finally {
      setSavingBudget(false);
    }
  }

  async function resetPassword(): Promise<void> {
    if (resetting) return;
    const params: Record<string, unknown> = { userId: user.id };
    if (customPassword.length > 0) params.password = customPassword;
    setResetting(true);
    setResetError(null);
    try {
      const result = await http.call<ResetUserPasswordResultWire>('reset_user_password', params);
      setCustomPassword('');
      onTemporaryPassword(user.login, result.temporaryPassword);
    } catch (err) {
      setResetError(err);
    } finally {
      setResetting(false);
    }
  }

  async function setStatus(status: 'active' | 'disabled'): Promise<void> {
    if (changingStatus) return;
    setChangingStatus(true);
    setStatusError(null);
    try {
      onChanged(await http.call<UserWire>('set_user_status', { userId: user.id, status }));
      setConfirmingDisable(false);
    } catch (err) {
      setStatusError(err);
    } finally {
      setChangingStatus(false);
    }
  }

  async function merge(): Promise<void> {
    if (mergeTargetId === '' || merging) return;
    setMerging(true);
    setMergeError(null);
    try {
      await http.call<UserWire>('merge_user', {
        sourceUserId: user.id,
        targetUserId: mergeTargetId,
      });
      setConfirmingMerge(false);
      onMerged();
    } catch (err) {
      setMergeError(err);
    } finally {
      setMerging(false);
    }
  }

  return (
    <div className="stack" data-testid="user-detail">
      <dl className="definition-list">
        <dt>登录名 Login</dt>
        <dd className="mono">{user.login}</dd>
        <dt>Id</dt>
        <dd>
          <CopyId id={user.id} label="user" />
        </dd>
        <dt>状态 Status</dt>
        <dd>
          <span
            className={`chip chip-s ${user.status === 'disabled' ? 'chip-neutral' : user.hasPassword ? 'chip-ok' : 'chip-warn'}`}
            data-testid="user-detail-status"
          >
            {user.status === 'disabled'
              ? 'disabled'
              : user.hasPassword
                ? 'active'
                : '待激活 Pending activation'}
          </span>
        </dd>
        <dt>最近登录 Last login</dt>
        <dd>
          {user.lastLoginAt === null ? (
            '从未 Never'
          ) : (
            <time title={formatDateTime(user.lastLoginAt)}>{formatRelative(user.lastLoginAt)}</time>
          )}
        </dd>
        <dt>创建 Created</dt>
        <dd>
          <time title={formatDateTime(user.createdAt)}>{formatRelative(user.createdAt)}</time>
        </dd>
      </dl>

      {protectedAdmin ? (
        <Notice tone="warn" testId="user-detail-env-admin">
          {ENV_ADMIN_TITLE} — 这个账户始终是管理员，不能在页面上停用或降级。 This account is always
          an administrator and can be neither disabled nor demoted from here.
        </Notice>
      ) : null}

      <div className="divider" />

      <Field id="ud-display-name" label="显示名 Display name">
        <Input
          id="ud-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={savingProfile}
        />
      </Field>
      <Field id="ud-platform-role" label="平台角色 Platform role">
        <span title={protectedAdmin ? ENV_ADMIN_TITLE : undefined}>
          <Select
            id="ud-platform-role"
            value={platformRole}
            onChange={(event) => setPlatformRole(event.target.value as PlatformRoleWire)}
            disabled={savingProfile || protectedAdmin}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </Select>
        </span>
      </Field>
      <PlatformError error={profileError} title="无法保存 Could not update this user" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          onClick={() => void saveProfile()}
          loading={savingProfile}
          disabled={!profileDirty}
        >
          保存 Save
        </Button>
      </div>

      <div className="divider" />

      <Field
        id="ud-daily-call-limit"
        label="每日调用上限 Daily call limit"
        hint="留空 = 用平台默认值。 Empty = the platform default."
        error={parsedDaily === undefined ? '必须是非负整数 Must be a non-negative integer' : null}
      >
        <Input
          id="ud-daily-call-limit"
          value={dailyCallLimit}
          onChange={(event) => setDailyCallLimit(event.target.value)}
          disabled={savingBudget}
          invalid={parsedDaily === undefined}
          inputMode="numeric"
          placeholder="默认 default"
          mono
        />
      </Field>
      <Field
        id="ud-monthly-token-budget"
        label="每月 token 预算 Monthly token budget"
        hint="留空 = 用平台默认值。 Empty = the platform default."
        error={parsedMonthly === undefined ? '必须是非负整数 Must be a non-negative integer' : null}
      >
        <Input
          id="ud-monthly-token-budget"
          value={monthlyTokenBudget}
          onChange={(event) => setMonthlyTokenBudget(event.target.value)}
          disabled={savingBudget}
          invalid={parsedMonthly === undefined}
          inputMode="numeric"
          placeholder="默认 default"
          mono
        />
      </Field>
      <PlatformError error={budgetError} title="无法保存预算 Could not set the budget" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          onClick={() => void saveBudget()}
          loading={savingBudget}
          disabled={!budgetDirty || !budgetValid}
        >
          保存预算 Save budget
        </Button>
      </div>

      <div className="divider" />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>成员资格 Memberships</span>
        <Button variant="secondary" size="s" icon="users" onClick={onOpenMemberships}>
          管理成员资格 Manage memberships ({user.memberships.length})
        </Button>
      </div>

      <div className="divider" />

      <Field
        id="ud-password"
        label="重置密码 Reset password"
        hint="留空则自动生成；新密码只显示一次，且首次登录必须修改。 Empty generates one; it is shown once and must be changed on first login."
      >
        <Input
          id="ud-password"
          type="password"
          value={customPassword}
          onChange={(event) => setCustomPassword(event.target.value)}
          disabled={resetting}
          autoComplete="new-password"
          placeholder="自动生成 Auto-generate"
          mono
        />
      </Field>
      <PlatformError error={resetError} title="无法重置密码 Could not reset the password" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          icon="key"
          onClick={() => void resetPassword()}
          loading={resetting}
        >
          重置密码 Reset password
        </Button>
      </div>

      <div className="divider" />

      <PlatformError error={statusError} title="无法修改状态 Could not change the status" />
      {user.status === 'disabled' ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button
            variant="secondary"
            onClick={() => void setStatus('active')}
            loading={changingStatus}
          >
            启用 Enable
          </Button>
        </div>
      ) : confirmingDisable ? (
        <div className="stack-s" data-testid="user-disable-confirm">
          <Notice tone="warn">
            停用会立即吊销该用户的全部控制台会话与各 Principal 的工作区会话；对话与上下文保留。
            Disabling revokes every console and workspace session immediately; conversations and
            context are kept.
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
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <span title={protectedAdmin ? ENV_ADMIN_TITLE : undefined}>
            <Button
              variant="danger"
              onClick={() => setConfirmingDisable(true)}
              disabled={protectedAdmin}
            >
              停用 Disable
            </Button>
          </span>
        </div>
      )}

      {user.hasPassword ? null : (
        <>
          <div className="divider" />
          <Field
            id="ud-merge-target"
            label="合并到 Merge into"
            hint="把这个待激活账户的成员资格并入一个已有账户，然后删除它。 Folds this pending account's memberships into an existing one, then deletes it."
          >
            <Select
              id="ud-merge-target"
              value={mergeTargetId}
              onChange={(event) => {
                setMergeTargetId(event.target.value);
                setConfirmingMerge(false);
              }}
              disabled={merging}
            >
              <option value="">选择目标账户 Pick a target account</option>
              {mergeTargets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.login} — {candidate.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <PlatformError error={mergeError} title="无法合并 Could not merge this user" />
          {confirmingMerge ? (
            <div className="stack-s" data-testid="user-merge-confirm">
              <Notice tone="warn">
                合并后这一行会消失，且不可撤销。 This row disappears afterwards and the merge cannot
                be undone.
              </Notice>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setConfirmingMerge(false)}>
                  取消 Cancel
                </Button>
                <Button variant="danger" onClick={() => void merge()} loading={merging}>
                  确认合并 Confirm merge
                </Button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                onClick={() => setConfirmingMerge(true)}
                disabled={mergeTargetId === ''}
              >
                合并 Merge
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
