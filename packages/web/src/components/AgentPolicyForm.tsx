import { type FormEvent, useState } from 'react';
import type { AgentPolicy, SetAgentPolicyParams } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { describeError } from '../lib/errors.js';
import type { GatekeeperListRow, ModelRow, SkillRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select, describedBy } from './ui/Field.js';
import { Notice } from './ui/Notice.js';

export interface AgentPolicyFormProps {
  readonly http: CapabilityCaller;
  readonly policy: AgentPolicy;
  readonly models: readonly ModelRow[];
  readonly skills: readonly SkillRow[];
  readonly gatekeepers: readonly GatekeeperListRow[];
  readonly onSaved: (policy: AgentPolicy) => void;
}

interface FormState {
  readonly allowedModels: readonly string[];
  /** `''` = not set (sent as `null`). */
  readonly defaultModel: string;
  readonly memberCanEditProfile: boolean;
  readonly maxPromptAddendumChars: string;
  readonly allowedSkills: readonly string[];
  readonly allowedGatekeepers: readonly string[];
  readonly allowMemberAutoApproveLow: boolean;
}

function initialState(policy: AgentPolicy): FormState {
  return {
    allowedModels: policy.allowedModels,
    defaultModel: policy.defaultModel ?? '',
    memberCanEditProfile: policy.memberCanEditProfile,
    maxPromptAddendumChars: String(policy.maxPromptAddendumChars),
    allowedSkills: policy.allowedSkills,
    allowedGatekeepers: policy.allowedGatekeepers,
    allowMemberAutoApproveLow: policy.allowMemberAutoApproveLow,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function toggle(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/**
 * S8 W4 (audit GM1 "'全不勾 = 不限制'是反向语义"): an allow-list here has only two domain states —
 * `[]` (unrestricted) or a non-empty explicit list — so unchecking the last box used to *loosen*
 * the policy, the opposite of what unchecking a box usually means. This wraps the same underlying
 * `[]`-means-unrestricted state behind an explicit "不限制" toggle (UI-only `restricted` state,
 * seeded from whether the incoming policy already had an explicit list) so loosening to
 * unrestricted is a deliberate flip, not an emergent side effect of deselecting everything; if a
 * reader still empties the list while `restricted` stays on, an inline note explains the
 * equivalence rather than silently reinterpreting it.
 */
function AllowListField({
  legend,
  options,
  selected,
  onChange,
  disabled,
  error,
  testId,
}: {
  readonly legend: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly disabled: boolean;
  readonly error?: string;
  readonly testId: string;
}) {
  const t = useT();
  const [restricted, setRestricted] = useState(selected.length > 0);

  function setRestrictedMode(next: boolean): void {
    setRestricted(next);
    if (!next) {
      onChange([]);
    } else if (selected.length === 0) {
      // Seed with everything currently available — switching into restricted mode must not
      // silently change effective behavior at the moment of the toggle.
      onChange(options.map((option) => option.id));
    }
  }

  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="field-label">{legend}</legend>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!restricted}
          onChange={(event) => setRestrictedMode(!event.target.checked)}
          disabled={disabled}
        />
        <span>{t('不限制（全部可用）', 'Unrestricted (everything available)')}</span>
      </label>
      {restricted ? (
        <div className="stack-s" data-testid={testId} style={{ paddingTop: 8 }}>
          {options.map((option) => (
            <label className="checkbox" key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={() => onChange(toggle(selected, option.id))}
                disabled={disabled}
              />
              <span>{option.label}</span>
            </label>
          ))}
          {selected.length === 0 ? (
            <p className="field-hint">
              {t(
                '未勾选任何项等价于"不限制"。',
                'Selecting nothing here has the same effect as "unrestricted".',
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function fieldForPolicyError(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('maxpromptaddendumchars')) return 'maxPromptAddendumChars';
  if (lower.includes('defaultmodel')) return 'defaultModel';
  if (lower.includes('membercaneditprofile')) return 'memberCanEditProfile';
  if (lower.includes('allowmemberautoapprovelow')) return 'allowMemberAutoApproveLow';
  if (lower.includes('gatekeeper')) return 'allowedGatekeepers';
  if (lower.includes('skill')) return 'allowedSkills';
  if (lower.includes('model')) return 'allowedModels';
  return undefined;
}

/**
 * components/AgentPolicyForm: the owner-only AgentPolicy editor on 模型与配额 Models & Quotas
 * (`/govern/models`, S3.13 deliverable 2) — the workspace-wide ceiling every `/me/agent`
 * AgentProfile is narrowed against. Every allow-list (`allowedModels`/`allowedSkills`/
 * `allowedGatekeepers`) is a plain checklist with **no** "inherit" affordance (unlike
 * `AgentProfileForm`'s checklists) — `AgentPolicy` has no parent to inherit from; an empty list
 * here means "unrestricted", not "unset", so it is sent as `[]` verbatim rather than mapped to a
 * sentinel.
 */
export function AgentPolicyForm({
  http,
  policy,
  models,
  skills,
  gatekeepers,
  onSaved,
}: AgentPolicyFormProps) {
  const t = useT();
  const [state, setState] = useState<FormState>(() => initialState(policy));
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [submitError, setSubmitError] = useState<unknown | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const publishedSkills = skills.filter((s) => s.status === 'published');

  const restrictedModels = state.allowedModels.length > 0;
  const defaultModelOptions = restrictedModels ? state.allowedModels : models.map((m) => m.id);
  // Audit P0-1: the select shows exactly what is stored. "Not set" is a real option while the
  // model list is unrestricted (the kernel allows `null` then); with an explicit allow-list the
  // kernel requires a default inside it (`modelPolicyViolation`), so a default that is unset or
  // was just un-ticked shows as "请选择" and blocks the save with a field error — it is never
  // replaced by the first option, on screen or on submit. A stored default the catalog no longer
  // lists stays visible as its own option rather than silently becoming another model.
  // The one exception is derivable, not a guess: when the allow-list leaves a single model, that
  // model is the only valid default, and the select shows it.
  const defaultModelValue =
    state.defaultModel === '' || defaultModelOptions.includes(state.defaultModel)
      ? restrictedModels && state.defaultModel === '' && defaultModelOptions.length === 1
        ? (defaultModelOptions[0] as string)
        : state.defaultModel
      : restrictedModels
        ? defaultModelOptions.length === 1
          ? (defaultModelOptions[0] as string)
          : ''
        : state.defaultModel;
  const defaultModelMissing = restrictedModels && defaultModelValue === '';
  const [noChanges, setNoChanges] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setFieldErrors({});
    setSubmitError(null);
    setNoChanges(false);

    const maxChars = Number(state.maxPromptAddendumChars);
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      setFieldErrors({
        maxPromptAddendumChars: t('请输入大于 0 的整数', 'Enter a whole number above 0.'),
      });
      return;
    }

    // The kernel's `modelPolicyViolation` refuses a non-empty allow-list without a default
    // inside it; say so on the field instead of picking one on the owner's behalf.
    if (defaultModelMissing) {
      setFieldErrors({
        defaultModel: t(
          '限定了可选模型时必须从中选一个默认模型',
          'With a restricted model list, pick a default from it.',
        ),
      });
      return;
    }

    // `set_agent_policy` is a partial update: send only what the owner changed, so saving one
    // toggle never rewrites a field the form merely displayed.
    const original = initialState(policy);
    const params: {
      -readonly [K in keyof SetAgentPolicyParams]: SetAgentPolicyParams[K];
    } = {};
    if (!sameList(state.allowedModels, original.allowedModels))
      params.allowedModels = state.allowedModels;
    if (defaultModelValue !== original.defaultModel)
      params.defaultModel = defaultModelValue === '' ? null : defaultModelValue;
    if (state.memberCanEditProfile !== original.memberCanEditProfile)
      params.memberCanEditProfile = state.memberCanEditProfile;
    if (maxChars !== policy.maxPromptAddendumChars) params.maxPromptAddendumChars = maxChars;
    if (!sameList(state.allowedSkills, original.allowedSkills))
      params.allowedSkills = state.allowedSkills;
    if (!sameList(state.allowedGatekeepers, original.allowedGatekeepers))
      params.allowedGatekeepers = state.allowedGatekeepers;
    if (state.allowMemberAutoApproveLow !== original.allowMemberAutoApproveLow)
      params.allowMemberAutoApproveLow = state.allowMemberAutoApproveLow;
    if (Object.keys(params).length === 0) {
      setNoChanges(true);
      return;
    }

    setSubmitting(true);
    try {
      const saved = await http.call<AgentPolicy>('set_agent_policy', params);
      onSaved(saved);
    } catch (err) {
      const described = describeError(err);
      const field =
        described.code === 'invalid_params' ? fieldForPolicyError(described.message) : undefined;
      if (field) {
        setFieldErrors({ [field]: described.message });
      } else {
        setSubmitError(err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="agent-policy-form"
    >
      <AllowListField
        legend={t('可选模型', 'Allowed models')}
        options={models.map((m) => ({ id: m.id, label: m.id }))}
        selected={state.allowedModels}
        onChange={(next) => update('allowedModels', next)}
        disabled={submitting}
        error={fieldErrors.allowedModels}
        testId="agent-policy-allowed-models"
      />

      <Field
        id="ap-default-model"
        label={t('默认模型', 'Default model')}
        error={fieldErrors.defaultModel}
      >
        <Select
          id="ap-default-model"
          value={defaultModelValue}
          onChange={(event) => update('defaultModel', event.target.value)}
          disabled={submitting}
          invalid={!!fieldErrors.defaultModel}
          data-testid="agent-policy-default-model"
        >
          {restrictedModels ? (
            <option value="" disabled>
              {t('请选择默认模型', 'Choose a default model')}
            </option>
          ) : (
            <option value="">
              {t(
                '不设置（使用入口 Worker 的模型或运行时默认）',
                "Not set (the entry Worker's model or the runtime default)",
              )}
            </option>
          )}
          {defaultModelValue !== '' && !defaultModelOptions.includes(defaultModelValue) ? (
            <option value={defaultModelValue}>
              {t(`${defaultModelValue}（目录中已没有）`, `${defaultModelValue} (no longer listed)`)}
            </option>
          ) : null}
          {defaultModelOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
      </Field>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={state.memberCanEditProfile}
          onChange={(event) => update('memberCanEditProfile', event.target.checked)}
          disabled={submitting}
        />
        <span>{t('成员可编辑自己的智能体配置', 'Members may edit their own Agent profile')}</span>
      </label>

      <Field
        id="ap-max-prompt-chars"
        label={t('提示词附加字数上限', 'Max prompt addendum length')}
        error={fieldErrors.maxPromptAddendumChars}
      >
        <Input
          id="ap-max-prompt-chars"
          type="number"
          min={1}
          value={state.maxPromptAddendumChars}
          onChange={(event) => update('maxPromptAddendumChars', event.target.value)}
          disabled={submitting}
          invalid={!!fieldErrors.maxPromptAddendumChars}
          aria-describedby={describedBy(
            'ap-max-prompt-chars',
            false,
            !!fieldErrors.maxPromptAddendumChars,
          )}
        />
      </Field>

      <AllowListField
        legend={t('可选 Skill', 'Allowed Skills')}
        options={publishedSkills.map((s) => ({ id: s.id, label: s.name }))}
        selected={state.allowedSkills}
        onChange={(next) => update('allowedSkills', next)}
        disabled={submitting}
        error={fieldErrors.allowedSkills}
        testId="agent-policy-allowed-skills"
      />

      <AllowListField
        legend={t('可选系统接入', 'Allowed connected systems')}
        options={gatekeepers.map((g) => ({ id: g.id, label: g.name }))}
        selected={state.allowedGatekeepers}
        onChange={(next) => update('allowedGatekeepers', next)}
        disabled={submitting}
        error={fieldErrors.allowedGatekeepers}
        testId="agent-policy-allowed-gatekeepers"
      />

      <label className="checkbox">
        <input
          type="checkbox"
          checked={state.allowMemberAutoApproveLow}
          onChange={(event) => update('allowMemberAutoApproveLow', event.target.checked)}
          disabled={submitting}
        />
        <span>{t('低风险动作可以自动批准', 'Low-blast-radius actions may be auto-approved')}</span>
      </label>
      {/* R-21 / D-16: an enforced narrowing — the runtime reads exactly this. */}
      <p className="field-hint" data-testid="agent-policy-auto-approve-low-hint">
        {t(
          '关闭后强制生效：工作区内所有人发起的低风险动作都要人工审批，个人的「我的智能体」设置不能改回。开启时，每个人仍可在「我的智能体」里为自己关闭。',
          'Off is enforced: every low-blast-radius action anyone in this workspace requests needs human approval, and no personal My Agent setting can turn it back on. While on, each person can still turn it off for themselves on My Agent.',
        )}
      </p>

      {submitError !== null ? (
        <ErrorBanner error={submitError} title={t('无法保存策略', 'Could not save the policy')} />
      ) : null}

      {noChanges ? (
        <output className="field-hint" data-testid="agent-policy-no-changes">
          {t('没有改动，无需保存。', 'Nothing changed, so nothing was saved.')}
        </output>
      ) : null}

      <Notice>
        {t(
          '变更立即生效。这里的限制对所有成员的智能体强制生效，个人配置只能在此范围内再收窄。',
          'Changes take effect immediately. These limits bind every member’s agent; a personal profile can only narrow further within them.',
        )}
      </Notice>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" loading={submitting}>
          {t('保存策略', 'Save policy')}
        </Button>
      </div>
    </form>
  );
}
