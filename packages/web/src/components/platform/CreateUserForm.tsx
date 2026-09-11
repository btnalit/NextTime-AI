import {
  type CreateUserResultWire,
  type PlatformRoleWire,
  ROLE_VALUES,
  type Role,
} from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { LOGIN_PATTERN } from '../../lib/platform-errors.js';
import type { WorkspaceOption } from '../../lib/platform-workspaces.js';
import { Button } from '../ui/Button.js';
import { Field, Input, Select } from '../ui/Field.js';
import { PlatformError } from './PlatformError.js';

export interface CreateUserFormProps {
  readonly http: CapabilityCaller;
  readonly workspaces: readonly WorkspaceOption[];
  /** The platform default workspace, for the "默认工作区" option's own hint; `null` = none set. */
  readonly defaultWorkspaceId: string | null;
  readonly defaultPlatformRole: PlatformRoleWire;
  readonly onCreated: (result: CreateUserResultWire) => void;
  readonly onCancel: () => void;
}

/** The workspace picker's three non-workspace choices (`create_user`'s `workspaceId` is
 *  "omit = platform default, `null` = none, a string = that workspace"). */
const DEFAULT_WORKSPACE = '__default__';
const NO_WORKSPACE = '__none__';
const OTHER_WORKSPACE = '__other__';

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
  workspaces,
  defaultWorkspaceId,
  defaultPlatformRole,
  onCreated,
  onCancel,
}: CreateUserFormProps) {
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platformRole, setPlatformRole] = useState<PlatformRoleWire>(defaultPlatformRole);
  const [passwordMode, setPasswordMode] = useState<'auto' | 'custom'>('auto');
  const [password, setPassword] = useState('');
  const [workspaceChoice, setWorkspaceChoice] = useState<string>(DEFAULT_WORKSPACE);
  const [otherWorkspaceId, setOtherWorkspaceId] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const trimmedLogin = login.trim();
  const loginInvalid = trimmedLogin.length > 0 && !LOGIN_PATTERN.test(trimmedLogin);
  const needsTypedWorkspace = workspaceChoice === OTHER_WORKSPACE;
  const joinsAWorkspace = workspaceChoice !== NO_WORKSPACE;
  const ready =
    trimmedLogin.length > 0 &&
    !loginInvalid &&
    displayName.trim().length > 0 &&
    (passwordMode === 'auto' || password.length > 0) &&
    (!needsTypedWorkspace || otherWorkspaceId.trim().length > 0);

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
      if (workspaceChoice === OTHER_WORKSPACE) params.workspaceId = otherWorkspaceId.trim();
      else if (workspaceChoice !== DEFAULT_WORKSPACE) params.workspaceId = workspaceChoice;
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
        label="登录名 Login"
        required
        hint="3–64 chars of a-z 0-9 . _ - — 小写字母或数字开头。"
        error={loginInvalid ? '登录名格式不合法 Invalid login — 3–64 chars of a-z 0-9 . _ -' : null}
      >
        <Input
          id="cu-login"
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          disabled={submitting}
          invalid={loginInvalid}
          autoComplete="off"
          spellCheck={false}
          mono
          autoFocus
        />
      </Field>

      <Field id="cu-display-name" label="显示名 Display name" required>
        <Input
          id="cu-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
        />
      </Field>

      <Field id="cu-platform-role" label="平台角色 Platform role" required>
        <Select
          id="cu-platform-role"
          value={platformRole}
          onChange={(event) => setPlatformRole(event.target.value as PlatformRoleWire)}
          disabled={submitting}
        >
          <option value="user">user</option>
          <option value="admin">admin</option>
        </Select>
      </Field>

      <Field
        id="cu-password-mode"
        label="密码 Password"
        hint="无论哪种方式，密码都只显示一次，且首次登录必须修改。 Either way it is shown once and must be changed on first login."
      >
        <Select
          id="cu-password-mode"
          value={passwordMode}
          onChange={(event) => setPasswordMode(event.target.value as 'auto' | 'custom')}
          disabled={submitting}
        >
          <option value="auto">自动生成 Auto-generate</option>
          <option value="custom">自定义 Set one</option>
        </Select>
      </Field>

      {passwordMode === 'custom' ? (
        <Field id="cu-password" label="临时密码 Temporary password" required>
          <Input
            id="cu-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            autoComplete="new-password"
            mono
          />
        </Field>
      ) : null}

      <Field
        id="cu-workspace"
        label="工作区 Workspace"
        hint={
          defaultWorkspaceId === null
            ? '平台还没有设置默认工作区。 No platform default workspace is set yet.'
            : `默认工作区 Default workspace: ${defaultWorkspaceId}`
        }
      >
        <Select
          id="cu-workspace"
          value={workspaceChoice}
          onChange={(event) => setWorkspaceChoice(event.target.value)}
          disabled={submitting}
        >
          <option value={DEFAULT_WORKSPACE}>默认工作区 Default workspace</option>
          <option value={NO_WORKSPACE}>无 None</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
          <option value={OTHER_WORKSPACE}>其他（输入 id）Other — type an id</option>
        </Select>
      </Field>

      {needsTypedWorkspace ? (
        <Field id="cu-workspace-id" label="工作区 id Workspace id" required>
          <Input
            id="cu-workspace-id"
            value={otherWorkspaceId}
            onChange={(event) => setOtherWorkspaceId(event.target.value)}
            disabled={submitting}
            mono
          />
        </Field>
      ) : null}

      {joinsAWorkspace ? (
        <Field id="cu-role" label="工作区角色 Workspace role" required>
          <Select
            id="cu-role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={submitting}
          >
            {ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <PlatformError
        error={error}
        title="无法创建用户 Could not create this user"
        testId="create-user-error"
      />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          取消 Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting} disabled={!ready}>
          创建 Create
        </Button>
      </div>
    </form>
  );
}
