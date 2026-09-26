import { type FormEvent, type ReactNode, useState } from 'react';
import {
  type AgentPolicy,
  type AgentProfile,
  type SetAgentProfileParams,
  fieldForAgentProfileError,
  narrowByPolicyAllowList,
} from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { describeError } from '../lib/errors.js';
import type { GatekeeperListRow, ModelRow, SkillRow } from '../lib/governance.js';
import { type Translate, useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import type { WorkerDefinitionSummary } from '../lib/tasks.js';
import { definitionName } from '../lib/tasks.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select, Textarea, describedBy } from './ui/Field.js';
import { Notice } from './ui/Notice.js';

const INHERIT_MODEL = '__inherit__';

export interface AgentProfileFormProps {
  readonly http: CapabilityCaller;
  /** The principal this profile belongs to — the profile's own `principalId`, not necessarily the
   *  caller's (an owner may be viewing/editing another principal's). */
  readonly principalId: string;
  readonly profile: AgentProfile;
  /** `undefined` when `get_agent_policy` has not loaded yet or is unavailable (404/403) — every
   *  narrowing/limit this form applies from policy is skipped gracefully rather than blocking the
   *  editor on a read that may not be deployed yet. */
  readonly policy: AgentPolicy | undefined;
  readonly models: readonly ModelRow[];
  readonly skills: readonly SkillRow[];
  readonly gatekeepers: readonly GatekeeperListRow[];
  readonly workerDefinitions: readonly WorkerDefinitionSummary[];
  /** `true` for a member editing their own profile when policy says they may not
   *  (`memberCanEditProfile === false`) — disables every control instead of offering a Save that
   *  can only 403. Owners always may edit (their own or anyone's — the task's fixed contract:
   *  "owner 改任何人"). */
  readonly editForbidden: boolean;
  readonly onSaved: (profile: AgentProfile) => void;
}

/** The three lists hold what the member *excluded* (console redesign D1): everything granted /
 *  published is in use unless unticked here, and anything granted or published later is picked
 *  up automatically — no "inherit" toggle, nothing to go stale. */
interface FormState {
  readonly model: string;
  readonly excludedSkills: readonly string[];
  readonly excludedGatekeepers: readonly string[];
  readonly excludedWorkerDefs: readonly string[];
  readonly promptAddendum: string;
  readonly autoApproveLow: boolean;
}

function initialState(profile: AgentProfile): FormState {
  return {
    model: profile.model ?? INHERIT_MODEL,
    excludedSkills: profile.excludedSkills,
    excludedGatekeepers: profile.excludedGatekeepers,
    excludedWorkerDefs: profile.excludedWorkerDefinitions,
    promptAddendum: profile.promptAddendum ?? '',
    autoApproveLow: profile.autoApproveLow ?? profile.effective.autoApproveLow,
  };
}

function toggleItem(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/**
 * components/AgentProfileForm: the editable half of 我的智能体 My Agent (`/me/agent`, S3.13) —
 * model select, Skills/systems/Worker-definition checklists (ticked = in use; unticking excludes —
 * see `FormState`), prompt addendum with a live char count, and the autoApproveLow toggle. Always
 * sends the full six-field state on `set_agent_profile` (never a partial diff) so a field the
 * reader clears is unambiguously cleared.
 */
export function AgentProfileForm({
  http,
  principalId,
  profile,
  policy,
  models,
  skills,
  gatekeepers,
  workerDefinitions,
  editForbidden,
  onSaved,
}: AgentProfileFormProps) {
  const t = useT();
  const [state, setState] = useState<FormState>(() => initialState(profile));
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [submitError, setSubmitError] = useState<unknown | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const allowedModels = narrowByPolicyAllowList(models, policy?.allowedModels, (m) => m.id);
  const publishedSkills = skills.filter((s) => s.status === 'published');
  const allowedSkills = narrowByPolicyAllowList(
    publishedSkills,
    policy?.allowedSkills,
    (s) => s.id,
  );
  // Only the systems actually granted to this member are on offer (in use or excluded) — a
  // workspace system nobody granted them would show as "in use" without the agent being able to
  // reach it.
  const grantedGateIds = new Set([
    ...profile.effective.enabledGatekeepers,
    ...profile.excludedGatekeepers,
  ]);
  const allowedGatekeepers = narrowByPolicyAllowList(
    gatekeepers,
    policy?.allowedGatekeepers,
    (g) => g.id,
  ).filter((g) => grantedGateIds.has(g.id));

  const maxChars = policy?.maxPromptAddendumChars;
  const overLimit = maxChars !== undefined && state.promptAddendum.length > maxChars;
  const autoApproveLowDisabled = editForbidden || policy?.allowMemberAutoApproveLow === false;

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || editForbidden) return;
    setFieldErrors({});
    setSubmitError(null);

    const params: SetAgentProfileParams = {
      principalId,
      model: state.model === INHERIT_MODEL ? null : state.model,
      excludedSkills: state.excludedSkills,
      excludedGatekeepers: state.excludedGatekeepers,
      excludedWorkerDefinitions: state.excludedWorkerDefs,
      promptAddendum: state.promptAddendum.trim().length > 0 ? state.promptAddendum : null,
      autoApproveLow: state.autoApproveLow,
    };

    setSubmitting(true);
    try {
      const saved = await http.call<AgentProfile>('set_agent_profile', params);
      onSaved(saved);
    } catch (err) {
      const described = describeError(err);
      const field =
        described.code === 'invalid_params'
          ? fieldForAgentProfileError(described.message)
          : undefined;
      if (field) {
        setFieldErrors({ [field]: described.message });
      } else {
        setSubmitError(err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || editForbidden;

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="agent-profile-form"
    >
      {editForbidden ? (
        <Notice tone="warn" testId="agent-profile-edit-forbidden">
          {t(
            '工作区策略不允许成员编辑自己的智能体配置，请工作区所有者在「模型与配额」页开放。',
            'Workspace policy does not allow members to edit their own Agent configuration — ask the workspace owner to allow it on Models & Quotas.',
          )}
        </Notice>
      ) : null}

      {/* S8 W4 (audit M2 "长单列表单无分节"): 模型 / 能力 / 提示词 / 自动批准 四节，与
       *  `EffectivePanel`（同一页只读摘要）共用 `.section`/`.section-header` 外观。 */}
      <section className="section" aria-labelledby="ap-section-model-title">
        <div className="section-header">
          <h2 id="ap-section-model-title">{t('模型', 'Model')}</h2>
        </div>
        <Field
          id="ap-model"
          label={t('模型', 'Model')}
          error={fieldErrors.model}
          hint={t(
            '可选模型来自工作区的模型清单，并按工作区策略收窄。',
            'Options come from the workspace model allow-list, narrowed by workspace policy.',
          )}
        >
          <Select
            id="ap-model"
            value={state.model}
            onChange={(event) => update('model', event.target.value)}
            disabled={disabled}
            invalid={!!fieldErrors.model}
            aria-describedby={describedBy('ap-model', !fieldErrors.model, !!fieldErrors.model)}
          >
            <option value={INHERIT_MODEL}>
              {t('继承工作区默认', 'Inherit workspace default')}
            </option>
            {allowedModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      <section className="section" aria-labelledby="ap-section-capabilities-title">
        <div className="section-header">
          <h2 id="ap-section-capabilities-title">{t('能力', 'Capabilities')}</h2>
        </div>
        <p className="field-hint">
          {t(
            '勾选的都会给你的智能体用；以后新授权的系统、新发布的 Skill 和 Worker 会自动加入。取消勾选即不让它用。',
            'Everything ticked is available to your agent; systems granted and Skills / Workers published later are added automatically. Untick to keep one out.',
          )}
        </p>

        <ChecklistField
          title="Skills"
          subtitle={t('已发布的 Skill', 'Published Skills')}
          options={allowedSkills.map((s) => ({ id: s.id, label: s.name }))}
          excluded={state.excludedSkills}
          onToggle={(id) => update('excludedSkills', toggleItem(state.excludedSkills, id))}
          disabled={disabled}
          error={fieldErrors.excludedSkills}
          testId="agent-profile-skills"
          empty={
            <>
              {t('还没有已发布的 Skill。', 'No published Skills yet.')}{' '}
              <a href={hrefs.catalog('skills')}>{t('去能力目录', 'Open the catalog')}</a>
            </>
          }
        />

        <ChecklistField
          title={t('系统接入', 'Connected systems')}
          subtitle={t('已授权给你的系统', 'Systems granted to you')}
          options={allowedGatekeepers.map((g) => ({ id: g.id, label: g.name }))}
          excluded={state.excludedGatekeepers}
          onToggle={(id) =>
            update('excludedGatekeepers', toggleItem(state.excludedGatekeepers, id))
          }
          disabled={disabled}
          error={fieldErrors.excludedGatekeepers}
          testId="agent-profile-gatekeepers"
          empty={
            <>
              {t(
                '还没有系统授权给你——需要工作区所有者授权后，你的智能体才能调用它。',
                'No system is granted to you yet — a workspace owner has to grant one before your agent can call it.',
              )}{' '}
              <a href={hrefs.access()}>{t('查看授权', 'View grants')}</a>
            </>
          }
        />

        <ChecklistField
          title={t('Worker 定义', 'Worker definitions')}
          subtitle={t('已发布、可被委派的 Worker', 'Published Workers your agent can delegate to')}
          options={workerDefinitions.map((w) => ({
            id: w.id,
            label: definitionName([w], w.id, w.version) ?? w.id,
          }))}
          excluded={state.excludedWorkerDefs}
          onToggle={(id) => update('excludedWorkerDefs', toggleItem(state.excludedWorkerDefs, id))}
          disabled={disabled}
          error={fieldErrors.excludedWorkerDefinitions}
          testId="agent-profile-worker-definitions"
          empty={
            <>
              {t('还没有已发布的 Worker。', 'No published Workers yet.')}{' '}
              <a href={hrefs.catalog('workers')}>{t('去能力目录', 'Open the catalog')}</a>
            </>
          }
        />
      </section>

      <section className="section" aria-labelledby="ap-section-prompt-title">
        <div className="section-header">
          <h2 id="ap-section-prompt-title">{t('提示词', 'Prompt')}</h2>
        </div>
        <Field
          id="ap-prompt"
          label={t('提示词附加', 'Prompt addendum')}
          error={fieldErrors.promptAddendum}
          hint={
            <span data-testid="agent-profile-prompt-count">
              {t(
                `${state.promptAddendum.length}${maxChars !== undefined ? ` / ${maxChars}` : ''} 字`,
                `${state.promptAddendum.length}${maxChars !== undefined ? ` / ${maxChars}` : ''} characters`,
              )}
              {overLimit ? t('（超出工作区上限）', ' (over the workspace limit)') : ''}
            </span>
          }
        >
          <Textarea
            id="ap-prompt"
            value={state.promptAddendum}
            onChange={(event) => update('promptAddendum', event.target.value)}
            rows={4}
            disabled={disabled}
            invalid={!!fieldErrors.promptAddendum || overLimit}
            aria-describedby={describedBy(
              'ap-prompt',
              !fieldErrors.promptAddendum,
              !!fieldErrors.promptAddendum,
            )}
          />
        </Field>
      </section>

      <section className="section" aria-labelledby="ap-section-auto-approve-title">
        <div className="section-header">
          <h2 id="ap-section-auto-approve-title">{t('自动批准', 'Auto-approve')}</h2>
        </div>
        <label className="checkbox" data-testid="agent-profile-auto-approve-low">
          <input
            type="checkbox"
            checked={state.autoApproveLow}
            onChange={(event) => update('autoApproveLow', event.target.checked)}
            disabled={disabled || autoApproveLowDisabled}
          />
          <span>
            {t('低风险动作自动批准', 'Auto-approve low blast-radius actions')}
            {autoApproveLowDisabled && !editForbidden ? (
              <span className="text-3 text-small">
                {' '}
                {t(
                  '— 工作区策略未开放"允许自动批准低风险动作"',
                  'workspace policy does not allow "auto-approve low-impact actions"',
                )}
              </span>
            ) : null}
          </span>
        </label>

        {fieldErrors.autoApproveLow ? (
          <p className="field-error" role="alert">
            {fieldErrors.autoApproveLow}
          </p>
        ) : null}
      </section>

      {submitError !== null ? (
        <ErrorBanner
          error={submitError}
          title={t('无法保存该 Agent profile', 'Could not save this Agent profile')}
        />
      ) : null}

      <Notice testId="agent-profile-effective-note">
        {t(
          '保存后下一轮对话生效（会话重签，常驻容器按需重建）。',
          'Takes effect from the next turn — the entry session re-signs and the resident container rebuilds if needed.',
        )}
      </Notice>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" loading={submitting} disabled={disabled}>
          {t('保存', 'Save')}
        </Button>
      </div>
    </form>
  );
}

/** A checklist of what is on offer: ticked = in use, unticked = excluded (`excluded` holds the
 *  unticked ids). `empty` explains why nothing is listed and where to fix it. */
function ChecklistField({
  title,
  subtitle,
  options,
  excluded,
  onToggle,
  disabled,
  error,
  testId,
  empty,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly excluded: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly disabled: boolean;
  readonly error?: string;
  readonly testId: string;
  readonly empty: ReactNode;
}) {
  return (
    <div className="field" data-testid={testId}>
      <span className="field-label">{title}</span>
      <p className="field-hint">{subtitle}</p>
      {options.length === 0 ? (
        <p className="text-3 text-small" data-testid={`${testId}-empty`}>
          {empty}
        </p>
      ) : (
        <fieldset
          className="stack-s"
          aria-label={title}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          {options.map((option) => (
            <label className="checkbox" key={option.id}>
              <input
                type="checkbox"
                checked={!excluded.includes(option.id)}
                onChange={() => onToggle(option.id)}
                disabled={disabled}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
