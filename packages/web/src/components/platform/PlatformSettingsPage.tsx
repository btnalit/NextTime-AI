import type {
  PlatformRoleWire,
  PlatformSettingsWire,
  PlatformWorkspaceWire,
} from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { hrefs } from '../../lib/router.js';
import { PageHeader } from '../kit/page-header.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select, Textarea } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
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
  const t = useT();
  const settings = useCapability<PlatformSettingsWire>(http, 'get_platform_settings');
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformSettings')}
        title={t('平台设置', 'Platform settings')}
        description="Site name, announcement, defaults, and password policy for this platform."
      />

      {savedVersion !== null ? (
        <Notice testId="platform-settings-saved">
          {t('已保存', 'Saved')} — {t('版本', 'version')} {savedVersion}。
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
    defaultDailyCallLimit:
      settings.defaultDailyCallLimit === null ? '' : String(settings.defaultDailyCallLimit),
    defaultMonthlyTokenBudget:
      settings.defaultMonthlyTokenBudget === null ? '' : String(settings.defaultMonthlyTokenBudget),
    defaultPlatformRole: settings.defaultPlatformRole,
    passwordMinLength: String(settings.passwordMinLength),
  };
}

/** S8 W1-A6 (audit S10 "默认工作区是 UUID 文本框"): the picker's own sentinel for "type the id
 *  by hand" — `list_workspaces` lists every workspace regardless of status, but a value already
 *  set to a since-purged workspace's id would otherwise not be selectable at all. */
const OTHER_WORKSPACE = '__other__';

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
  const t = useT();
  const [values, setValues] = useState<FormValues>(() => toFormValues(initial));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [nothingToSave, setNothingToSave] = useState(false);

  // S8 W1-A6 (audit S10): the default-workspace picker's own data source — every workspace,
  // regardless of status, so a currently-set (possibly disabled) id is still shown by name.
  const workspacesList = useCapabilityList<PlatformWorkspaceWire>(
    http,
    'list_workspaces',
    {},
    { autoLoadAll: true },
  );
  const workspaceOptions =
    workspacesList.state.status === 'ready' ? workspacesList.state.data.items : [];
  const workspacesReady = workspacesList.state.status === 'ready';
  const currentWorkspaceKnown =
    values.defaultWorkspaceId === '' ||
    workspaceOptions.some((ws) => ws.id === values.defaultWorkspaceId);
  const [manualWorkspaceEntry, setManualWorkspaceEntry] = useState(false);
  // Once the directory has actually loaded, an id it does not know about (a purged workspace, or
  // one this administrator has not seen yet) forces manual-entry mode too — never silently
  // falls back to "无 None" and loses the reader's already-set value.
  const useManualWorkspaceInput =
    manualWorkspaceEntry || (workspacesReady && !currentWorkspaceKnown);

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
      <Card title={t('站点', 'Site')}>
        <div className="stack">
          <Field
            id="ps-site-name"
            label={t('站点名', 'Site name')}
            required
            error={siteNameValid ? null : t('不能为空', 'Cannot be empty')}
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
            label={t('公告', 'Announcement')}
            hint={t(
              'Markdown — 显示在控制台顶部；留空表示没有公告。 Shown in the console top bar; empty =',
              'none.',
            )}
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

      <Card title={t('agent 全局指令', 'Instance instructions')}>
        <div className="stack">
          <Notice tone="warn">
            {t(
              "这会进入所有 agent 的 system prompt。 Appended to every agent's system prompt — 之后启动 的容器生效。",
              'Takes effect for containers started afterwards.',
            )}
          </Notice>
          <Field id="ps-instance-instructions" label={t('附加指令', 'Appended instructions')}>
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

      <Card title={t('默认值', 'Defaults')}>
        <div className="stack">
          <Field
            id="ps-default-workspace"
            label={t('默认工作区', 'Default workspace')}
            hint={t(
              '新建用户默认加入的工作区；留空 = 不自动加入。 The workspace new users join; empty =',
              'none.',
            )}
          >
            <Select
              id="ps-default-workspace"
              value={useManualWorkspaceInput ? OTHER_WORKSPACE : values.defaultWorkspaceId}
              onChange={(event) => {
                const next = event.target.value;
                if (next === OTHER_WORKSPACE) {
                  setManualWorkspaceEntry(true);
                  return;
                }
                setManualWorkspaceEntry(false);
                set('defaultWorkspaceId', next);
              }}
              disabled={submitting}
            >
              <option value="">{t('无', 'None')}</option>
              {workspaceOptions.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
              <option value={OTHER_WORKSPACE}>{t('其他（输入 id）', 'Other — type an id')}</option>
            </Select>
          </Field>

          {useManualWorkspaceInput ? (
            <Field id="ps-default-workspace-other" label={t('工作区 id', 'Workspace id')}>
              <Input
                id="ps-default-workspace-other"
                value={values.defaultWorkspaceId}
                onChange={(event) => set('defaultWorkspaceId', event.target.value)}
                disabled={submitting}
                mono
              />
            </Field>
          ) : null}

          <p className="text-3 text-small" data-testid="platform-settings-default-model-hint">
            {t(
              '默认入口模型在"模型与供应商"页设置（经目录校验）。',
              'The default entry model is set on the',
            )}{' '}
            <a href={hrefs.platformModels()}>{t('模型与供应商', 'Models &amp; providers')}</a> page
            (validated against the catalog there).
          </p>

          <Field
            id="ps-default-daily-call-limit"
            label={t('默认每日调用上限', 'Default daily call limit')}
            hint={t('留空 = 不限。', 'Empty = none.')}
            error={
              dailyLimit === undefined
                ? t('必须是非负整数', 'Must be a non-negative integer')
                : null
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
            label={t('默认每月 token 预算', 'Default monthly token budget')}
            hint={t('留空 = 不限。', 'Empty = none.')}
            error={
              monthlyBudget === undefined
                ? t('必须是非负整数', 'Must be a non-negative integer')
                : null
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

          <Field
            id="ps-default-platform-role"
            label={t('新用户默认平台角色', 'Default platform role')}
          >
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
            label={t('密码最短长度', 'Password minimum length')}
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

      <Card title={t('环境管理员', 'Environment administrators')}>
        <div className="stack-s">
          <p className="text-3 text-small">
            {t(
              '由主机环境配置指定，只读；这些登录名始终是管理员，页面上不可停用或降级。',
              'Set by the host configuration, read-only; these logins are always administrators and can be neither disabled nor demoted from the console.',
            )}
          </p>
          {/* S8 W1-A10 (audit S14): the env var name is an implementation detail an operator who
           *  set it already knows — never inline, behind a disclosure instead. */}
          <details className="disclosure">
            <summary>{t('技术细节', 'Technical details')}</summary>
            <p className="text-3 text-small mono">NEXTTIME_PLATFORM_ADMINS</p>
          </details>
          <div className="row-wrap" data-testid="platform-settings-env-admins">
            {initial.envAdmins.length === 0 ? (
              <span className="text-3">—</span>
            ) : (
              initial.envAdmins.map((login) => (
                // C17: a login is a label, not a status — no StatusChip machine fits; the `tag`
                // class is what the users page's own `env` badge wears for the same logins.
                <span key={login} className="tag mono" data-testid="platform-settings-env-admin">
                  {login}
                </span>
              ))
            )}
          </div>
        </div>
      </Card>

      <PlatformError
        error={error}
        title={t('无法保存平台设置', 'Could not save the platform settings')}
        testId="platform-settings-save-error"
      />
      {nothingToSave ? (
        <p className="field-hint" data-testid="platform-settings-unchanged">
          {t('没有改动', 'Nothing has changed')}
        </p>
      ) : null}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="text-3 text-small" data-testid="platform-settings-footer">
          {t('版本', 'version')} {initial.version} ·{' '}
          {initial.updatedAt === null
            ? t('从未修改', 'Never updated')
            : formatDateTime(initial.updatedAt)}
        </span>
        <Button type="submit" variant="primary" loading={submitting} disabled={!valid}>
          {t('保存', 'Save')}
        </Button>
      </div>
    </form>
  );
}
