import {
  type CreateUserResultWire,
  type PlatformRoleWire,
  ROLE_VALUES,
  type Role,
} from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { roleLabel } from '../../lib/labels.js';
import {
  loginError,
  loginNormalizedNote,
  loginRuleText,
  normalizeLoginInput,
} from '../../lib/login-input.js';
import { WorkspacePicker, useActiveWorkspaces } from '../../lib/users-workspace-picker.js';
import { Button } from '../ui/Button.js';
import { Field, Input, Select } from '../ui/Field.js';
import { PlatformError } from './PlatformError.js';

export interface CreateUserFormProps {
  readonly http: CapabilityCaller;
  /** The platform default workspace, for the "默认工作区" option's own hint; `null` = none set. */
  readonly defaultWorkspaceId: string | null;
  readonly defaultPlatformRole: PlatformRoleWire;
  readonly onCreated: (result: CreateUserResultWire) => void;
  readonly onCancel: () => void;
}

/** The workspace picker's two non-workspace choices (`create_user`'s `workspaceId` is
 *  "omit = platform default, `null` = none, a string = that workspace"). */
const DEFAULT_WORKSPACE = '__default__';
const NO_WORKSPACE = '__none__';
/** The platform setting `passwordMinLength` is validated >= 8 (PlatformSettingsPage), so 8 is a
 *  safe client-side floor; a longer platform minimum is still enforced (and explained) by the kernel. */
const MIN_PASSWORD_FLOOR = 8;

/**
 * components/platform/CreateUserForm: `create_user` (P-A1, design §6.1 "新建：登录名、显示名、
 * 平台角色、密码（默认自动生成）、工作区与角色（缺省 = 默认工作区 member）"). The login is
 * validated against the kernel's own `LOGIN_PATTERN` as it is typed, so the common mistake is
 * caught before a round trip; every other rule (login already taken, password policy, workspace
 * disabled) is the kernel's to enforce and is shown through `PlatformError`.
 *
 * The temporary password is not shown here — `onCreated` hands the whole result up to
 * `PlatformUsersPage`, which closes this form and opens `TemporaryPasswordDialog` instead, so the
 * password lives in exactly one place and one panel is open at a time.
 */
export function CreateUserForm({
  http,
  defaultWorkspaceId,
  defaultPlatformRole,
  onCreated,
  onCancel,
}: CreateUserFormProps) {
  const t = useT();
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platformRole, setPlatformRole] = useState<PlatformRoleWire>(defaultPlatformRole);
  const [passwordMode, setPasswordMode] = useState<'auto' | 'custom'>('auto');
  const [password, setPassword] = useState('');
  const [workspaceChoice, setWorkspaceChoice] = useState<string>(DEFAULT_WORKSPACE);
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const workspaces = useActiveWorkspaces(http);
  const defaultWorkspace =
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.find((workspace) => workspace.id === defaultWorkspaceId)
      : undefined;
  // `undefined` while the list loads (the picker says so itself), `null` once it is known the
  // default is not among the active workspaces (disabled, expired, or purged).
  const defaultWorkspaceName =
    defaultWorkspace?.name ?? (workspaces.state.status === 'ready' ? null : undefined);

  // The kernel trims and lower-cases the login (`normalizeLogin`), so "Alice " is fine: we do the
  // same, say what will be saved, and only reject what the kernel would also reject.
  const trimmedLogin = normalizeLoginInput(login);
  const loginMessage = loginError(trimmedLogin, t);
  const loginInvalid = loginMessage !== null;
  const loginNote = loginNormalizedNote(login, t);
  const passwordTooShort =
    passwordMode === 'custom' && password.length > 0 && password.length < MIN_PASSWORD_FLOOR;
  const joinsAWorkspace = workspaceChoice !== NO_WORKSPACE;
  const ready =
    trimmedLogin.length > 0 &&
    !loginInvalid &&
    displayName.trim().length > 0 &&
    (passwordMode === 'auto' || password.length >= MIN_PASSWORD_FLOOR);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready || submitting) return;
    const params: Record<string, unknown> = {
      login: trimmedLogin,
      displayName: displayName.trim(),
      platformRole,
    };
    if (passwordMode === 'custom') params.password = password;
    if (workspaceChoice === NO_WORKSPACE) {
      // Explicit `null` — "no membership at all", distinct from omitting the field.
      params.workspaceId = null;
    } else {
      if (workspaceChoice !== DEFAULT_WORKSPACE) params.workspaceId = workspaceChoice;
      params.role = role;
    }
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await http.call<CreateUserResultWire>('create_user', params));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="create-user-form"
    >
      <Field
        id="cu-login"
        label={t('登录名', 'Login')}
        required
        hint={loginNote ? `${loginRuleText(t)} ${loginNote}` : loginRuleText(t)}
        error={loginMessage}
      >
        <Input
          id="cu-login"
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          onBlur={() => setLogin(normalizeLoginInput(login))}
          disabled={submitting}
          invalid={loginInvalid}
          autoComplete="off"
          spellCheck={false}
          mono
          autoFocus
        />
      </Field>

      <Field id="cu-display-name" label={t('显示名', 'Display name')} required>
        <Input
          id="cu-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
        />
      </Field>

      <Field id="cu-platform-role" label={t('平台角色', 'Platform role')} required>
        <Select
          id="cu-platform-role"
          value={platformRole}
          onChange={(event) => setPlatformRole(event.target.value as PlatformRoleWire)}
          disabled={submitting}
        >
          <option value="user">{t('用户', 'User')}</option>
          <option value="admin">{t('管理员', 'Admin')}</option>
        </Select>
      </Field>

      <Field
        id="cu-password-mode"
        label={t('密码', 'Password')}
        hint={t(
          '无论哪种方式，密码都只显示一次，且首次登录必须修改。',
          'Either way it is shown once and must be changed on first login.',
        )}
      >
        <Select
          id="cu-password-mode"
          value={passwordMode}
          onChange={(event) => setPasswordMode(event.target.value as 'auto' | 'custom')}
          disabled={submitting}
        >
          <option value="auto">{t('自动生成', 'Auto-generate')}</option>
          <option value="custom">{t('自定义', 'Set one')}</option>
        </Select>
      </Field>

      {passwordMode === 'custom' ? (
        <Field
          id="cu-password"
          label={t('临时密码', 'Temporary password')}
          required
          hint={t(
            '至少 8 位（平台设置的最短长度更高时以平台为准）；不想自己想就选“自动生成”。',
            'At least 8 characters (the platform minimum applies if it is higher); choose "Auto-generate" to skip this.',
          )}
          error={
            passwordTooShort
              ? t(
                  `密码太短：当前 ${password.length} 位，至少需要 8 位。`,
                  `Password too short: ${password.length} characters, at least 8 are needed.`,
                )
              : null
          }
        >
          <Input
            id="cu-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            autoComplete="new-password"
            invalid={passwordTooShort}
            mono
          />
        </Field>
      ) : null}

      <WorkspacePicker
        id="cu-workspace"
        label={t('工作区', 'Workspace')}
        hint={
          defaultWorkspaceId === null
            ? t('平台还没有设置默认工作区。', 'No platform default workspace is set yet.')
            : defaultWorkspaceName === null
              ? t(
                  '平台默认工作区已停用或已过期，请直接选一个工作区。',
                  'The platform default workspace is disabled or expired — pick a workspace directly.',
                )
              : defaultWorkspaceName === undefined
                ? undefined
                : t(
                    `默认工作区：${defaultWorkspaceName}`,
                    `Default workspace: ${defaultWorkspaceName}`,
                  )
        }
        value={workspaceChoice}
        onChange={setWorkspaceChoice}
        disabled={submitting}
        workspaces={workspaces}
        leading={
          <>
            <option value={DEFAULT_WORKSPACE}>{t('默认工作区', 'Default workspace')}</option>
            <option value={NO_WORKSPACE}>{t('无', 'None')}</option>
          </>
        }
        emptyText={t('还没有可加入的工作区。', 'There is no workspace to join yet.')}
        testId="create-user-workspace"
      />

      {joinsAWorkspace ? (
        <Field id="cu-role" label={t('工作区角色', 'Workspace role')} required>
          <Select
            id="cu-role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={submitting}
          >
            {ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value, t)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <PlatformError
        error={error}
        title={t('无法创建用户', 'Could not create this user')}
        testId="create-user-error"
      />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!ready}
          data-testid="create-user-submit"
        >
          {t('创建', 'Create')}
        </Button>
      </div>
    </form>
  );
}
