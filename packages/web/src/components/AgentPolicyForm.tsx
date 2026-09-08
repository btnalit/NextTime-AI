import { type FormEvent, useState } from 'react';
import type { AgentPolicy, SetAgentPolicyParams } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { describeError } from '../lib/errors.js';
import type { GatekeeperListRow, ModelRow, SkillRow } from '../lib/governance.js';
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
  const [state, setState] = useState<FormState>(() => initialState(policy));
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [submitError, setSubmitError] = useState<unknown | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const publishedSkills = skills.filter((s) => s.status === 'published');

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

    const params: SetAgentPolicyParams = {
      allowedModels: state.allowedModels,
      defaultModel: state.defaultModel,
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

  const defaultModelOptions =
    state.allowedModels.length > 0 ? state.allowedModels : models.map((m) => m.id);

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="agent-policy-form"
    >
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">
          可选模型 Allowed models
          <span className="field-hint" style={{ margin: 0 }}>
            {' '}
            — 空 = 不限制 empty = unrestricted
          </span>
        </legend>
        <div className="stack-s" data-testid="agent-policy-allowed-models">
          {models.map((m) => (
            <label className="checkbox" key={m.id}>
              <input
                type="checkbox"
                checked={state.allowedModels.includes(m.id)}
                onChange={() => update('allowedModels', toggle(state.allowedModels, m.id))}
                disabled={submitting}
              />
              <span>{m.id}</span>
            </label>
          ))}
        </div>
        {fieldErrors.allowedModels ? (
          <p className="field-error" role="alert">
            {fieldErrors.allowedModels}
          </p>
        ) : null}
      </fieldset>

      <Field id="ap-default-model" label="默认模型 Default model" error={fieldErrors.defaultModel}>
        <Select
          id="ap-default-model"
          value={state.defaultModel}
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
        <span>Member 可编辑自己的智能体配置 Members may edit their own AgentProfile</span>
      </label>

      <Field
        id="ap-max-prompt-chars"
        label="提示词附加字数上限 Max prompt addendum length"
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

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">
          可选 Skills Allowed skills
          <span className="field-hint" style={{ margin: 0 }}>
            {' '}
            — 空 = 不限制 empty = unrestricted
          </span>
        </legend>
        <div className="stack-s" data-testid="agent-policy-allowed-skills">
          {publishedSkills.map((s) => (
            <label className="checkbox" key={s.id}>
              <input
                type="checkbox"
                checked={state.allowedSkills.includes(s.id)}
                onChange={() => update('allowedSkills', toggle(state.allowedSkills, s.id))}
                disabled={submitting}
              />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">
          可选系统接入 Allowed connected systems
          <span className="field-hint" style={{ margin: 0 }}>
            {' '}
            — 空 = 不限制 empty = unrestricted
          </span>
        </legend>
        <div className="stack-s" data-testid="agent-policy-allowed-gatekeepers">
          {gatekeepers.map((g) => (
            <label className="checkbox" key={g.id}>
              <input
                type="checkbox"
                checked={state.allowedGatekeepers.includes(g.id)}
                onChange={() =>
                  update('allowedGatekeepers', toggle(state.allowedGatekeepers, g.id))
                }
                disabled={submitting}
              />
              <span>{g.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={state.allowMemberAutoApproveLow}
          onChange={(event) => update('allowMemberAutoApproveLow', event.target.checked)}
          disabled={submitting}
        />
        <span>
          允许 member 自动批准低风险动作 Allow members to auto-approve low-blast-radius actions
        </span>
      </label>

      {submitError !== null ? (
        <ErrorBanner error={submitError} title="Could not save AgentPolicy" />
      ) : null}

      <Notice>
        变更立即影响所有未显式覆盖该项的 AgentProfile Changes apply immediately to every
        AgentProfile that has not explicitly overridden the affected field.
      </Notice>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" loading={submitting}>
          保存策略 Save policy
        </Button>
      </div>
    </form>
  );
}
