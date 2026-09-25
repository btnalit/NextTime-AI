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
    defaultModel: policy.defaultModel,
    memberCanEditProfile: policy.memberCanEditProfile,
    maxPromptAddendumChars: String(policy.maxPromptAddendumChars),
    allowedSkills: policy.allowedSkills,
    allowedGatekeepers: policy.allowedGatekeepers,
    allowMemberAutoApproveLow: policy.allowMemberAutoApproveLow,
  };
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

  const defaultModelOptions =
    state.allowedModels.length > 0 ? state.allowedModels : models.map((m) => m.id);
  // C11 (console-completion-plan §2b), mirroring `platform/CreateWorkspaceForm.tsx`'s guard:
  // un-ticking the current default must not leave the `<select>` bound to a value that is no
  // longer an option (React renders the first option while the state still holds the stale id,
  // and that stale id is what used to be submitted — a guaranteed `entry_model_not_allowed`).
  // The first remaining option becomes the effective default, both on screen and on submit.
  const defaultModelValue = defaultModelOptions.includes(state.defaultModel)
    ? state.defaultModel
    : (defaultModelOptions[0] ?? '');

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setFieldErrors({});
    setSubmitError(null);

    const maxChars = Number(state.maxPromptAddendumChars);
    if (!Number.isFinite(maxChars) || maxChars < 0) {
      setFieldErrors({ maxPromptAddendumChars: 'Must be a non-negative number.' });
      return;
    }

    // C11: the kernel's `modelPolicyViolation` refuses a non-empty allow-list whose default is
    // not in it; the guarded value below is what the select shows, so submit exactly that.
    if (state.allowedModels.length > 0 && defaultModelValue === '') {
      setFieldErrors({
        defaultModel: t('请先勾选至少一个模型作为默认', 'Pick a default from the allowed models.'),
      });
      return;
    }

    const params: SetAgentPolicyParams = {
      allowedModels: state.allowedModels,
      defaultModel: defaultModelValue,
      memberCanEditProfile: state.memberCanEditProfile,
      maxPromptAddendumChars: maxChars,
      allowedSkills: state.allowedSkills,
      allowedGatekeepers: state.allowedGatekeepers,
      allowMemberAutoApproveLow: state.allowMemberAutoApproveLow,
    };

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
        >
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
          min={0}
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
        <span>
          {t(
            '允许 member 自动批准低风险动作',
            'Allow members to auto-approve low-blast-radius actions',
          )}
        </span>
      </label>

      {submitError !== null ? (
        <ErrorBanner error={submitError} title={t('无法保存策略', 'Could not save the policy')} />
      ) : null}

      <Notice>
        {t(
          '变更立即影响所有未显式覆盖该项的智能体配置。',
          'Changes apply immediately to every Agent profile that has not explicitly overridden this field.',
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
