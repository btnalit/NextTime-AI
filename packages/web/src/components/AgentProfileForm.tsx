import { type FormEvent, useState } from 'react';
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

interface FormState {
  readonly model: string;
  readonly skillsInherit: boolean;
  readonly skills: readonly string[];
  readonly gatekeepersInherit: boolean;
  readonly gatekeepers: readonly string[];
  readonly workerDefsInherit: boolean;
  readonly workerDefs: readonly string[];
  readonly promptAddendum: string;
  readonly autoApproveLow: boolean;
}

function initialState(profile: AgentProfile): FormState {
  return {
    model: profile.model ?? INHERIT_MODEL,
    skillsInherit: profile.enabledSkills === null,
    skills: profile.enabledSkills ?? [],
    gatekeepersInherit: profile.enabledGatekeepers === null,
    gatekeepers: profile.enabledGatekeepers ?? [],
    workerDefsInherit: profile.enabledWorkerDefinitions === null,
    workerDefs: profile.enabledWorkerDefinitions ?? [],
    promptAddendum: profile.promptAddendum ?? '',
    autoApproveLow: profile.autoApproveLow ?? profile.effective.autoApproveLow,
  };
}

function toggleItem(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/**
 * components/AgentProfileForm: the editable half of 我的智能体 My Agent (`/me/agent`, S3.13) —
 * model select, Skills/systems/Worker-definition checklists (each with its own "inherit workspace
 * default" toggle — `AgentProfile`'s `null` fields, `lib/agent-profile.ts`'s own doc comment: an
 * inherited empty checklist and an explicitly-empty one are different effective states, "give me
 * everything currently available" vs. "give me nothing"), prompt addendum with a live char count,
 * and the autoApproveLow toggle. Always sends the full six-field state on `set_agent_profile`
 * (never a partial diff) so a field the reader clears is unambiguously cleared.
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
  const allowedGatekeepers = narrowByPolicyAllowList(
    gatekeepers,
    policy?.allowedGatekeepers,
    (g) => g.id,
  );

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
      enabledSkills: state.skillsInherit ? null : state.skills,
      enabledGatekeepers: state.gatekeepersInherit ? null : state.gatekeepers,
      enabledWorkerDefinitions: state.workerDefsInherit ? null : state.workerDefs,
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
          工作区策略不允许成员编辑自己的智能体配置 Workspace policy does not allow members to edit
          their own Agent configuration (<code>memberCanEditProfile</code>). Ask the workspace owner
          to change it in 模型与配额.
        </Notice>
      ) : null}

      <Field
        id="ap-model"
        label="模型 Model"
        error={fieldErrors.model}
        hint="Options are the llm-proxy allow-list, narrowed by workspace policy."
      >
        <Select
          id="ap-model"
          value={state.model}
          onChange={(event) => update('model', event.target.value)}
          disabled={disabled}
          invalid={!!fieldErrors.model}
          aria-describedby={describedBy('ap-model', true, !!fieldErrors.model)}
        >
          <option value={INHERIT_MODEL}>继承工作区默认 Inherit workspace default</option>
          {allowedModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </Select>
      </Field>

      <ChecklistField
        title="Skills"
        subtitle="已发布的 Skill，工作区策略可收窄 Published Skills, narrowed by workspace policy"
        inherit={state.skillsInherit}
        onInheritChange={(value) => update('skillsInherit', value)}
        options={allowedSkills.map((s) => ({ id: s.id, label: s.name }))}
        selected={state.skills}
        onToggle={(id) => update('skills', toggleItem(state.skills, id))}
        disabled={disabled}
        error={fieldErrors.enabledSkills}
        testId="agent-profile-skills"
      />

      <ChecklistField
        title="系统接入 Connected systems"
        subtitle="调用方可见的门，工作区策略可收窄 Gatekeepers you can see, narrowed by workspace policy"
        inherit={state.gatekeepersInherit}
        onInheritChange={(value) => update('gatekeepersInherit', value)}
        options={allowedGatekeepers.map((g) => ({ id: g.id, label: g.name }))}
        selected={state.gatekeepers}
        onToggle={(id) => update('gatekeepers', toggleItem(state.gatekeepers, id))}
        disabled={disabled}
        error={fieldErrors.enabledGatekeepers}
        testId="agent-profile-gatekeepers"
      />

      <ChecklistField
        title="Worker 定义 Worker definitions"
        subtitle="可选 Optional"
        inherit={state.workerDefsInherit}
        onInheritChange={(value) => update('workerDefsInherit', value)}
        options={workerDefinitions.map((w) => ({
          id: w.id,
          label: definitionName([w], w.id, w.version) ?? w.id,
        }))}
        selected={state.workerDefs}
        onToggle={(id) => update('workerDefs', toggleItem(state.workerDefs, id))}
        disabled={disabled}
        error={fieldErrors.enabledWorkerDefinitions}
        testId="agent-profile-worker-definitions"
      />

      <Field
        id="ap-prompt"
        label="提示词附加 Prompt addendum"
        error={fieldErrors.promptAddendum}
        hint={
          <span data-testid="agent-profile-prompt-count">
            {state.promptAddendum.length}
            {maxChars !== undefined ? ` / ${maxChars}` : ''} characters
            {overLimit ? ' — over the workspace limit' : ''}
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
          aria-describedby={describedBy('ap-prompt', true, !!fieldErrors.promptAddendum)}
        />
      </Field>

      <label className="checkbox" data-testid="agent-profile-auto-approve-low">
        <input
          type="checkbox"
          checked={state.autoApproveLow}
          onChange={(event) => update('autoApproveLow', event.target.checked)}
          disabled={disabled || autoApproveLowDisabled}
        />
        <span>
          低风险动作自动批准 Auto-approve low blast-radius actions
          {autoApproveLowDisabled && !editForbidden ? (
            <span className="text-3 text-small">
              {' '}
              — 工作区策略不允许 workspace policy does not allow this (
              <code>allowMemberAutoApproveLow</code>)
            </span>
          ) : null}
        </span>
      </label>

      {fieldErrors.autoApproveLow ? (
        <p className="field-error" role="alert">
          {fieldErrors.autoApproveLow}
        </p>
      ) : null}

      {submitError !== null ? (
        <ErrorBanner error={submitError} title="Could not save this Agent profile" />
      ) : null}

      <Notice testId="agent-profile-effective-note">
        保存后下一轮对话生效（会话重签，常驻容器按需重建） Takes effect from the next turn — the
        entry session re-signs and the resident container rebuilds if needed.
      </Notice>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" loading={submitting} disabled={disabled}>
          保存 Save
        </Button>
      </div>
    </form>
  );
}

function ChecklistField({
  title,
  subtitle,
  inherit,
  onInheritChange,
  options,
  selected,
  onToggle,
  disabled,
  error,
  testId,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly inherit: boolean;
  readonly onInheritChange: (value: boolean) => void;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly selected: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly disabled: boolean;
  readonly error?: string;
  readonly testId: string;
}) {
  return (
    <div className="field" data-testid={testId}>
      <span className="field-label">{title}</span>
      <p className="field-hint">{subtitle}</p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={inherit}
          onChange={(event) => onInheritChange(event.target.checked)}
          disabled={disabled}
        />
        <span>继承（不覆盖）Inherit workspace default</span>
      </label>
      {!inherit ? (
        options.length === 0 ? (
          <p className="text-3 text-small">Nothing available.</p>
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
                  checked={selected.includes(option.id)}
                  onChange={() => onToggle(option.id)}
                  disabled={disabled}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        )
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
