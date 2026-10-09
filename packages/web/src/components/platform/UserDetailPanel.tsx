import type { PlatformRoleWire, ResetUserPasswordResultWire, UserWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { roleLabel } from '../../lib/labels.js';
import { envAdminTitle, platformErrorMessage } from '../../lib/platform-errors.js';
import { SavedNote } from '../../lib/saved-note.js';
import { deriveUserStatus } from '../../lib/status-tone.js';
import { sameDisplayName, useUserDirectoryTap } from '../../lib/users-directory.js';
import { Confirm } from '../kit/confirm.js';
import { Button } from '../ui/Button.js';
import { CopyId } from '../ui/CopyId.js';
import { Field, Input, Select } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { StatusChip } from '../ui/StatusChip.js';
import { PlatformError } from './PlatformError.js';
import { UserPicker } from './UserPicker.js';

export interface UserDetailPanelProps {
  readonly http: CapabilityCaller;
  readonly user: UserWire;
  /** `NEXTTIME_PLATFORM_ADMINS` logins (design §6.6) — never disabled, never demoted. */
  readonly envAdmins: readonly string[];
  /** A capability that answered with a fresh `UserWire` for this row. */
  readonly onChanged: (user: UserWire) => void;
  /** `merge_user` folded this row into another — the row is gone, the list must be re-read. */
  readonly onMerged: () => void;
  readonly onTemporaryPassword: (login: string, password: string) => void;
  readonly onOpenMemberships: () => void;
}

/** `null` for an empty (or all-separator) box (= inherit the platform default), `undefined` for anything that is not
 *  a non-negative integer (the caller refuses to submit). */
function parseBudget(raw: string): number | null | undefined {
  // Thousands separators are fine ("1,000,000" / "1 000" / "1_000"): strip, don't refuse.
  const trimmed = raw.replace(/[,_\s]/g, '');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/** Says what a valid budget looks like instead of just "invalid". */
function budgetRuleError(raw: string, t: Translate): string {
  return t(
    `“${raw.trim()}”不是有效的预算：请填不小于 0 的整数（可用 , 或空格分隔千位），留空表示用平台默认值。`,
    `“${raw.trim()}” is not a valid budget: enter a whole number of 0 or more (thousands separators , or spaces are fine), or leave it empty for the platform default.`,
  );
}

function budgetInput(value: number | null): string {
  return value === null ? '' : String(value);
}

/** The kernel's platform error with the console's bilingual copy as its message, so `kit/confirm`'s
 *  own inline error banner reads the same as `PlatformError` does (the `PurgeWorkspaceDrawer`
 *  convention). Anything unmapped is rethrown as it came. */
function friendly(err: unknown, t: Translate): unknown {
  const mapped = platformErrorMessage(err, t);
  if (mapped === null || !(err instanceof HttpError)) return err;
  return new HttpError(err.kind, mapped, err.code);
}

/**
 * components/platform/UserDetailPanel: one row's drawer body on the users page (P-A1, design
 * §6.1's row actions) — `update_user` (display name + platform role), `set_user_budget`,
 * `reset_user_password`, `set_user_status`, `merge_user`, plus the way into the memberships
 * drawer. Disabling gets a same-drawer confirm step, the shape `PrincipalDetail` established for
 * `disable_principal` (it revokes every console and workspace session the user holds); re-enabling
 * is not destructive and acts directly.
 *
 * R-45 (review 2026-10-02): `merge_user` hard-deletes this row and hands its memberships and roles
 * to the target, so it sits behind `kit/confirm tier="irreversible"` — retype the *target's* login
 * (the real risk is folding into the wrong, live account) — with one impact line per membership
 * that moves. Only active accounts are offered as targets.
 *
 * A login listed in `NEXTTIME_PLATFORM_ADMINS` can be neither disabled nor demoted — the kernel
 * refuses it with `protected_admin`, and this panel says so up front (disabled control plus the
 * `title` explanation) instead of offering a button that can only fail.
 */
export function UserDetailPanel({
  http,
  user,
  envAdmins,
  onChanged,
  onMerged,
  onTemporaryPassword,
  onOpenMemberships,
}: UserDetailPanelProps) {
  const t = useT();
  const protectedAdmin = envAdmins.includes(user.login);

  const [displayName, setDisplayName] = useState(user.displayName);
  const [platformRole, setPlatformRole] = useState<PlatformRoleWire>(user.platformRole);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<unknown | null>(null);
  // Inline "已保存" — set when a save lands, cleared on the next edit of that section.
  const [profileSaved, setProfileSaved] = useState(false);

  const [dailyCallLimit, setDailyCallLimit] = useState(budgetInput(user.dailyCallLimit));
  const [monthlyTokenBudget, setMonthlyTokenBudget] = useState(
    budgetInput(user.monthlyTokenBudget),
  );
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetError, setBudgetError] = useState<unknown | null>(null);
  const [budgetSaved, setBudgetSaved] = useState(false);

  const [customPassword, setCustomPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<unknown | null>(null);

  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusError, setStatusError] = useState<unknown | null>(null);

  const [mergeTarget, setMergeTarget] = useState<UserWire | undefined>(undefined);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  // A pending account is usually a duplicate of someone who already has a real one — the same
  // display name is the strongest hint the directory carries, so those rows come first.
  const directory = useUserDirectoryTap(http, (candidate) =>
    sameDisplayName(candidate.displayName, user.displayName) ? 0 : 1,
  );
  const sameNameCandidates = directory.rows.filter(
    (candidate) =>
      candidate.id !== user.id &&
      candidate.status === 'active' &&
      candidate.hasPassword &&
      sameDisplayName(candidate.displayName, user.displayName),
  );

  const profileDirty =
    displayName.trim() !== user.displayName || platformRole !== user.platformRole;
  const parsedDaily = parseBudget(dailyCallLimit);
  const parsedMonthly = parseBudget(monthlyTokenBudget);
  const budgetValid = parsedDaily !== undefined && parsedMonthly !== undefined;
  const budgetDirty =
    dailyCallLimit !== budgetInput(user.dailyCallLimit) ||
    monthlyTokenBudget !== budgetInput(user.monthlyTokenBudget);

  async function saveProfile(): Promise<void> {
    if (!profileDirty || savingProfile) return;
    const params: Record<string, unknown> = { userId: user.id };
    if (displayName.trim() !== user.displayName) params.displayName = displayName.trim();
    if (platformRole !== user.platformRole) params.platformRole = platformRole;
    setSavingProfile(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      onChanged(await http.call<UserWire>('update_user', params));
      setProfileSaved(true);
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
    setBudgetSaved(false);
    try {
      onChanged(
        await http.call<UserWire>('set_user_budget', {
          userId: user.id,
          dailyCallLimit: parsedDaily,
          monthlyTokenBudget: parsedMonthly,
        }),
      );
      // Show the normalized numbers ("1,000" -> "1000") that were actually saved.
      setDailyCallLimit(budgetInput(parsedDaily));
      setMonthlyTokenBudget(budgetInput(parsedMonthly));
      setBudgetSaved(true);
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

  /** `kit/confirm`'s `onConfirm`: throws on failure so the tier keeps itself open with the error
   *  inline; closes itself on success. */
  async function merge(): Promise<void> {
    if (!mergeTarget) return;
    try {
      await http.call<UserWire>('merge_user', {
        sourceUserId: user.id,
        targetUserId: mergeTarget.id,
      });
    } catch (err) {
      throw friendly(err, t);
    }
    onMerged();
  }

  return (
    <div className="stack" data-testid="user-detail">
      <dl className="definition-list">
        <dt>{t('登录名', 'Login')}</dt>
        <dd className="mono">{user.login}</dd>
        <dt>Id</dt>
        <dd>
          <CopyId id={user.id} label="user" />
        </dd>
        <dt>{t('状态', 'Status')}</dt>
        <dd>
          <StatusChip
            machine="userStatus"
            status={deriveUserStatus(user)}
            size="s"
            testId="user-detail-status"
          />
        </dd>
        <dt>{t('最近登录', 'Last login')}</dt>
        <dd>
          {user.lastLoginAt === null ? (
            t('从未', 'Never')
          ) : (
            <time title={formatDateTime(user.lastLoginAt)}>{formatRelative(user.lastLoginAt)}</time>
          )}
        </dd>
        <dt>{t('创建', 'Created')}</dt>
        <dd>
          <time title={formatDateTime(user.createdAt)}>{formatRelative(user.createdAt)}</time>
        </dd>
      </dl>

      {protectedAdmin ? (
        <Notice tone="warn" testId="user-detail-env-admin">
          {envAdminTitle(t)}{' '}
          {t(
            '— 这个账户始终是管理员，不能在页面上停用或降级。',
            'This account is always an administrator and can be neither disabled nor demoted from here.',
          )}
        </Notice>
      ) : null}

      <div className="divider" />

      <Field id="ud-display-name" label={t('显示名', 'Display name')}>
        <Input
          id="ud-display-name"
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value);
            setProfileSaved(false);
          }}
          disabled={savingProfile}
        />
      </Field>
      <Field id="ud-platform-role" label={t('平台角色', 'Platform role')}>
        <span title={protectedAdmin ? envAdminTitle(t) : undefined}>
          <Select
            id="ud-platform-role"
            value={platformRole}
            onChange={(event) => {
              setPlatformRole(event.target.value as PlatformRoleWire);
              setProfileSaved(false);
            }}
            disabled={savingProfile || protectedAdmin}
          >
            <option value="user">{t('用户', 'User')}</option>
            <option value="admin">{t('管理员', 'Admin')}</option>
          </Select>
        </span>
      </Field>
      <PlatformError error={profileError} title={t('无法保存', 'Could not update this user')} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {profileSaved ? <SavedNote testId="user-profile-saved" /> : null}
        <Button
          variant="secondary"
          onClick={() => void saveProfile()}
          loading={savingProfile}
          disabled={!profileDirty}
        >
          {t('保存', 'Save')}
        </Button>
      </div>

      <div className="divider" />

      <Field
        id="ud-daily-call-limit"
        label={t('每日调用上限', 'Daily call limit')}
        hint={t('留空 = 用平台默认值。', 'Empty = the platform default.')}
        error={parsedDaily === undefined ? budgetRuleError(dailyCallLimit, t) : null}
      >
        <Input
          id="ud-daily-call-limit"
          value={dailyCallLimit}
          onChange={(event) => {
            setDailyCallLimit(event.target.value);
            setBudgetSaved(false);
          }}
          disabled={savingBudget}
          invalid={parsedDaily === undefined}
          inputMode="numeric"
          placeholder={t('默认', 'default')}
          mono
        />
      </Field>
      <Field
        id="ud-monthly-token-budget"
        label={t('每月 token 预算', 'Monthly token budget')}
        hint={t('留空 = 用平台默认值。', 'Empty = the platform default.')}
        error={parsedMonthly === undefined ? budgetRuleError(monthlyTokenBudget, t) : null}
      >
        <Input
          id="ud-monthly-token-budget"
          value={monthlyTokenBudget}
          onChange={(event) => {
            setMonthlyTokenBudget(event.target.value);
            setBudgetSaved(false);
          }}
          disabled={savingBudget}
          invalid={parsedMonthly === undefined}
          inputMode="numeric"
          placeholder={t('默认', 'default')}
          mono
        />
      </Field>
      <PlatformError error={budgetError} title={t('无法保存预算', 'Could not set the budget')} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {budgetSaved ? <SavedNote testId="user-budget-saved" /> : null}
        <Button
          variant="secondary"
          onClick={() => void saveBudget()}
          loading={savingBudget}
          disabled={!budgetDirty || !budgetValid}
        >
          {t('保存预算', 'Save budget')}
        </Button>
      </div>

      <div className="divider" />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>{t('成员资格', 'Memberships')}</span>
        <Button variant="secondary" size="s" icon="users" onClick={onOpenMemberships}>
          {t('管理成员资格', 'Manage memberships')} ({user.memberships.length})
        </Button>
      </div>

      <div className="divider" />

      <Field
        id="ud-password"
        label={t('重置密码', 'Reset password')}
        hint={t(
          '留空则自动生成；新密码只显示一次，且首次登录必须修改。',
          'Empty generates one; it is shown once and must be changed on first login.',
        )}
      >
        <Input
          id="ud-password"
          type="password"
          value={customPassword}
          onChange={(event) => setCustomPassword(event.target.value)}
          disabled={resetting}
          autoComplete="new-password"
          placeholder={t('自动生成', 'Auto-generate')}
          mono
        />
      </Field>
      <PlatformError error={resetError} title={t('无法重置密码', 'Could not reset the password')} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          icon="key"
          onClick={() => void resetPassword()}
          loading={resetting}
        >
          {t('重置密码', 'Reset password')}
        </Button>
      </div>

      <div className="divider" />

      <PlatformError error={statusError} title={t('无法修改状态', 'Could not change the status')} />
      {user.status === 'disabled' ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button
            variant="secondary"
            onClick={() => void setStatus('active')}
            loading={changingStatus}
          >
            {t('启用', 'Enable')}
          </Button>
        </div>
      ) : confirmingDisable ? (
        <div className="stack-s" data-testid="user-disable-confirm">
          <Notice tone="warn">
            {t(
              '停用会立即吊销该用户的全部控制台会话与各 Principal 的工作区会话；对话与上下文保留。',
              'Disabling revokes every console and workspace session immediately; conversations and context are kept.',
            )}
          </Notice>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setConfirmingDisable(false)}>
              {t('取消', 'Cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => void setStatus('disabled')}
              loading={changingStatus}
            >
              {t('确认停用', 'Confirm disable')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <span title={protectedAdmin ? envAdminTitle(t) : undefined}>
            <Button
              variant="danger"
              onClick={() => setConfirmingDisable(true)}
              disabled={protectedAdmin}
            >
              {t('停用', 'Disable')}
            </Button>
          </span>
        </div>
      )}

      {user.hasPassword ? null : (
        <>
          <div className="divider" />
          {/* `UserPicker` already leaves out disabled and not-yet-activated accounts — exactly
           *  the ones that make no sense as a merge target. */}
          <UserPicker
            http={directory.caller}
            id="ud-merge-target"
            label={t('合并到', 'Merge into')}
            hint={
              <>
                {t(
                  '把这个待激活账户的成员资格并入一个已有账户，然后删除它。',
                  "Folds this pending account's memberships into an existing one, then deletes it.",
                )}
                {sameNameCandidates.length > 0 ? (
                  <span data-testid="user-merge-same-name">
                    {' '}
                    {t(
                      `同显示名的账户排在最前：${sameNameCandidates.map((c) => c.login).join('、')}。`,
                      `Accounts with the same display name are listed first: ${sameNameCandidates.map((c) => c.login).join(', ')}.`,
                    )}
                  </span>
                ) : null}
              </>
            }
            value={mergeTarget?.id ?? ''}
            onChange={(userId) => setMergeTarget(directory.find(userId))}
            exclude={[user.id]}
            testId="user-merge-target"
          />
          <Confirm
            tier="irreversible"
            open={confirmingMerge && mergeTarget !== undefined}
            onOpenChange={setConfirmingMerge}
            anchor={
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button
                  variant="secondary"
                  onClick={() => setConfirmingMerge(true)}
                  disabled={mergeTarget === undefined}
                >
                  {t('合并', 'Merge')}
                </Button>
              </div>
            }
            title={t(
              `把 ${user.login} 合并到 ${mergeTarget?.login ?? ''}`,
              `Merge ${user.login} into ${mergeTarget?.login ?? ''}`,
            )}
            description={t(
              `${user.login} 这一行会被删除，不可撤销；下面的成员资格连同角色全部转给 ${mergeTarget?.login ?? ''}，此后由那个账户登录使用。请键入目标账户的登录名确认没有选错人。`,
              `The ${user.login} row is deleted and cannot be restored; every membership below moves, with its role, to ${mergeTarget?.login ?? ''}, who signs in to use them from then on. Type the target account's login to confirm it is the right person.`,
            )}
            target={mergeTarget?.login}
            impact={
              user.memberships.length === 0
                ? [t('没有要转移的成员资格', 'No memberships to move')]
                : user.memberships.map((membership) =>
                    t(
                      `工作区 ${membership.workspaceName} · ${roleLabel(membership.role, t)}${membership.disabled ? '（已停用）' : ''} → ${mergeTarget?.login ?? ''}`,
                      `Workspace ${membership.workspaceName} · ${roleLabel(membership.role, t)}${membership.disabled ? ' (disabled)' : ''} → ${mergeTarget?.login ?? ''}`,
                    ),
                  )
            }
            confirmLabel={t('确认合并', 'Confirm merge')}
            onConfirm={merge}
            testId="user-merge-confirm"
          />
        </>
      )}
    </div>
  );
}
