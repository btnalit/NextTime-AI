import type { PlatformRoleWire, PlatformSettingsWire } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import { invalidateCapability, useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime } from '../../lib/format.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select, Textarea } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { PlatformError } from './PlatformError.js';

export interface PlatformSettingsPageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/platform/PlatformSettingsPage: 平台设置 Platform settings (`/platform/settings`,
 * design doc §6.6) — `get_platform_settings` / `update_platform_settings`. Only the "软策略"
 * half is here on purpose: auth configuration, internal-plane tokens and the image allow-list stay
 * in env so a hijacked administrator session cannot widen its own reach (§6.6's own reasoning).
 * `envAdmins` mirrors `NEXTTIME_PLATFORM_ADMINS` and is read-only — it is shown so the users page's
 * "cannot be disabled or demoted" refusals have a visible cause.
 *
 * The save is a **partial** update: only the fields the reader actually changed are sent, so two
 * administrators editing different fields do not overwrite each other (`update_platform_settings`
 * leaves omitted fields untouched and bumps `version`). The form is re-seeded by remounting it on
 * the new `version` rather than by syncing state in an effect.
 */
export function PlatformSettingsPage({ http }: PlatformSettingsPageProps) {
  const settings = useCapability<PlatformSettingsWire>(http, 'get_platform_settings');
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  return (
    <div className="page">
      <PageHeader
        title="平台设置 Platform settings"
        description="Site name, announcement, defaults, and password policy for this platform."
      />

      {savedVersion !== null ? (
        <Notice testId="platform-settings-saved">
          已保存 Saved — 版本 version {savedVersion}。
        </Notice>
      ) : null}

      {settings.state.status === 'loading' ? (
        <SkeletonRows
          count={5}
          label="Loading platform settings"
          testId="platform-settings-loading"
        />
      ) : settings.state.status === 'error' ? (
        <ErrorBanner
          error={settings.state.error}
          title="Could not load the platform settings"
          onRetry={() => void settings.reload()}
          testId="platform-settings-error"
        />
      ) : (
        <PlatformSettingsForm
          key={settings.state.data.version}
          http={http}
          initial={settings.state.data}
          onSaved={(next) => {
            invalidateCapability(http, 'get_platform_settings');
            settings.mutate(() => next);
            setSavedVersion(next.version);
          }}
        />
      )}
    </div>
  );
}

/** The editable half of `PlatformSettingsWire` — `envAdmins`, `version` and `updatedAt` are
 *  read-only projections and never part of a patch. */
type EditableKey =
  | 'siteName'
  | 'announcement'
  | 'instanceInstructions'
  | 'defaultWorkspaceId'
  | 'defaultEntryModel'
  | 'defaultDailyCallLimit'
  | 'defaultMonthlyTokenBudget'
  | 'defaultPlatformRole'
  | 'passwordMinLength';

/** Every field is edited as a string; `''` means "not set" for the nullable ones. */
type FormValues = Readonly<Record<EditableKey, string>>;

function toFormValues(settings: PlatformSettingsWire): FormValues {
  return {
    siteName: settings.siteName,
    announcement: settings.announcement,
    instanceInstructions: settings.instanceInstructions,
    defaultWorkspaceId: settings.defaultWorkspaceId ?? '',
    defaultEntryModel: settings.defaultEntryModel ?? '',
    defaultDailyCallLimit:
      settings.defaultDailyCallLimit === null ? '' : String(settings.defaultDailyCallLimit),
    defaultMonthlyTokenBudget:
      settings.defaultMonthlyTokenBudget === null ? '' : String(settings.defaultMonthlyTokenBudget),
    defaultPlatformRole: settings.defaultPlatformRole,
    passwordMinLength: String(settings.passwordMinLength),
  };
}

/** `''` → `null` (clear the setting), anything else → the trimmed string. */
function nullableText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** `''` → `null`, a non-negative integer → that number, anything else → `undefined` (invalid). */
function nullableCount(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function PlatformSettingsForm({
  http,
  initial,
  onSaved,
}: {
  readonly http: CapabilityCaller;
  readonly initial: PlatformSettingsWire;
  readonly onSaved: (next: PlatformSettingsWire) => void;
}) {
  const [values, setValues] = useState<FormValues>(() => toFormValues(initial));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [nothingToSave, setNothingToSave] = useState(false);

  function set(key: EditableKey, value: string): void {
    setValues((prev) => ({ ...prev, [key]: value }));
    setNothingToSave(false);
  }

  const dailyLimit = nullableCount(values.defaultDailyCallLimit);
  const monthlyBudget = nullableCount(values.defaultMonthlyTokenBudget);
  const passwordMinLength = Number(values.passwordMinLength.trim());
  const passwordMinLengthValid =
    Number.isInteger(passwordMinLength) && passwordMinLength >= 8 && passwordMinLength <= 128;
  const siteNameValid = values.siteName.trim().length > 0;
  const valid =
    siteNameValid &&
    passwordMinLengthValid &&
    dailyLimit !== undefined &&
    monthlyBudget !== undefined;

  /** Only the keys whose value actually differs from the loaded row — `update_platform_settings`
   *  leaves everything omitted untouched. */
  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (values.siteName.trim() !== initial.siteName) patch.siteName = values.siteName.trim();
    if (values.announcement !== initial.announcement) patch.announcement = values.announcement;
    if (values.instanceInstructions !== initial.instanceInstructions) {
      patch.instanceInstructions = values.instanceInstructions;
    }
    const workspaceId = nullableText(values.defaultWorkspaceId);
    if (workspaceId !== initial.defaultWorkspaceId) patch.defaultWorkspaceId = workspaceId;
    const entryModel = nullableText(values.defaultEntryModel);
    if (entryModel !== initial.defaultEntryModel) patch.defaultEntryModel = entryModel;
    if (dailyLimit !== initial.defaultDailyCallLimit) patch.defaultDailyCallLimit = dailyLimit;
    if (monthlyBudget !== initial.defaultMonthlyTokenBudget) {
      patch.defaultMonthlyTokenBudget = monthlyBudget;
    }
    if (values.defaultPlatformRole !== initial.defaultPlatformRole) {
      patch.defaultPlatformRole = values.defaultPlatformRole;
    }
    if (passwordMinLength !== initial.passwordMinLength) {
      patch.passwordMinLength = passwordMinLength;
    }
    return patch;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!valid || submitting) return;
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      setNothingToSave(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onSaved(await http.call<PlatformSettingsWire>('update_platform_settings', patch));
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
      data-testid="platform-settings-form"
    >
      <Card title="站点 Site">
        <div className="stack">
          <Field
            id="ps-site-name"
            label="站点名 Site name"
            required
            error={siteNameValid ? null : '不能为空 Cannot be empty'}
          >
            <Input
              id="ps-site-name"
              value={values.siteName}
              onChange={(event) => set('siteName', event.target.value)}
              disabled={submitting}
              invalid={!siteNameValid}
            />
          </Field>

          <Field
            id="ps-announcement"
            label="公告 Announcement"
            hint="Markdown — 显示在控制台顶部；留空表示没有公告。 Shown in the console top bar; empty = none."
          >
            <Textarea
              id="ps-announcement"
              value={values.announcement}
              onChange={(event) => set('announcement', event.target.value)}
              disabled={submitting}
              rows={3}
            />
          </Field>
        </div>
      </Card>

      <Card title="agent 全局指令 Instance instructions">
        <div className="stack">
          <Notice tone="warn">
            这会进入所有 agent 的 system prompt。 Appended to every agent's system prompt — 之后启动
            的容器生效。 Takes effect for containers started afterwards.
          </Notice>
          <Field id="ps-instance-instructions" label="附加指令 Appended instructions">
            <Textarea
              id="ps-instance-instructions"
              value={values.instanceInstructions}
              onChange={(event) => set('instanceInstructions', event.target.value)}
              disabled={submitting}
              rows={5}
            />
          </Field>
        </div>
      </Card>

      <Card title="默认值 Defaults">
        <div className="stack">
          <Field
            id="ps-default-workspace"
            label="默认工作区 Default workspace"
            hint="新建用户默认加入的工作区 id；留空 = 不自动加入。 The workspace new users join; empty = none."
          >
            <Input
              id="ps-default-workspace"
              value={values.defaultWorkspaceId}
              onChange={(event) => set('defaultWorkspaceId', event.target.value)}
              disabled={submitting}
              mono
            />
          </Field>

          <Field
            id="ps-default-entry-model"
            label="默认入口模型 Default entry model"
            hint="<provider>/<id>；留空 = 用 pi 自己的默认值。 Empty = pi's own default."
          >
            <Input
              id="ps-default-entry-model"
              value={values.defaultEntryModel}
              onChange={(event) => set('defaultEntryModel', event.target.value)}
              disabled={submitting}
              mono
            />
          </Field>

          <Field
            id="ps-default-daily-call-limit"
            label="默认每日调用上限 Default daily call limit"
            hint="留空 = 不限。 Empty = none."
            error={
              dailyLimit === undefined ? '必须是非负整数 Must be a non-negative integer' : null
            }
          >
            <Input
              id="ps-default-daily-call-limit"
              value={values.defaultDailyCallLimit}
              onChange={(event) => set('defaultDailyCallLimit', event.target.value)}
              disabled={submitting}
              invalid={dailyLimit === undefined}
              inputMode="numeric"
              mono
            />
          </Field>

          <Field
            id="ps-default-monthly-token-budget"
            label="默认每月 token 预算 Default monthly token budget"
            hint="留空 = 不限。 Empty = none."
            error={
              monthlyBudget === undefined ? '必须是非负整数 Must be a non-negative integer' : null
            }
          >
            <Input
              id="ps-default-monthly-token-budget"
              value={values.defaultMonthlyTokenBudget}
              onChange={(event) => set('defaultMonthlyTokenBudget', event.target.value)}
              disabled={submitting}
              invalid={monthlyBudget === undefined}
              inputMode="numeric"
              mono
            />
          </Field>

          <Field id="ps-default-platform-role" label="新用户默认平台角色 Default platform role">
            <Select
              id="ps-default-platform-role"
              value={values.defaultPlatformRole}
              onChange={(event) =>
                set('defaultPlatformRole', event.target.value as PlatformRoleWire)
              }
              disabled={submitting}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </Select>
          </Field>

          <Field
            id="ps-password-min-length"
            label="密码最短长度 Password minimum length"
            hint="8–128。"
            error={passwordMinLengthValid ? null : '必须是 8–128 的整数 Must be an integer 8–128'}
          >
            <Input
              id="ps-password-min-length"
              value={values.passwordMinLength}
              onChange={(event) => set('passwordMinLength', event.target.value)}
              disabled={submitting}
              invalid={!passwordMinLengthValid}
              inputMode="numeric"
              mono
            />
          </Field>
        </div>
      </Card>

      <Card title="环境管理员 Environment administrators">
        <div className="stack-s">
          <p className="text-3 text-small">
            来自 NEXTTIME_PLATFORM_ADMINS，只读；这些登录名始终是管理员，页面上不可停用或降级。 From
            NEXTTIME_PLATFORM_ADMINS — read-only; these logins are always administrators and can be
            neither disabled nor demoted from the console.
          </p>
          <div className="row-wrap" data-testid="platform-settings-env-admins">
            {initial.envAdmins.length === 0 ? (
              <span className="text-3">—</span>
            ) : (
              initial.envAdmins.map((login) => (
                <span key={login} className="chip chip-s chip-neutral">
                  {login}
                </span>
              ))
            )}
          </div>
        </div>
      </Card>

      <PlatformError
        error={error}
        title="无法保存平台设置 Could not save the platform settings"
        testId="platform-settings-save-error"
      />
      {nothingToSave ? (
        <p className="field-hint" data-testid="platform-settings-unchanged">
          没有改动 Nothing has changed
        </p>
      ) : null}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="text-3 text-small" data-testid="platform-settings-footer">
          版本 version {initial.version} ·{' '}
          {initial.updatedAt === null
            ? '从未修改 Never updated'
            : formatDateTime(initial.updatedAt)}
        </span>
        <Button type="submit" variant="primary" loading={submitting} disabled={!valid}>
          保存 Save
        </Button>
      </div>
    </form>
  );
}
