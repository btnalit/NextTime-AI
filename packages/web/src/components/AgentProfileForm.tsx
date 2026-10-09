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
import { Button } from './kit/button.js';
import { EmptyState } from './kit/empty-state.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Field, describedBy } from './kit/field.js';
import { Notice } from './kit/notice.js';
import { DashboardCard } from './kit/section.js';
import { Select } from './kit/select.js';
import { Textarea } from './kit/textarea.js';

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
  /** R-21 / D-16: ticked = "follow the workspace" (the profile's `null`), unticked = "narrow me"
   *  (`false`). The profile can only narrow — an explicit `true` would mean the same as `null`
   *  under the enforced AgentPolicy — so the form never writes `true`. */
  readonly autoApproveLow: boolean;
}

function initialState(profile: AgentProfile): FormState {
  return {
    model: profile.model ?? INHERIT_MODEL,
    excludedSkills: profile.excludedSkills,
    excludedGatekeepers: profile.excludedGatekeepers,
    excludedWorkerDefs: profile.excludedWorkerDefinitions,
    promptAddendum: profile.promptAddendum ?? '',
    autoApproveLow: profile.autoApproveLow !== false,
  };
}

function toggleItem(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/**
 * components/AgentProfileForm: the editable half of 我的智能体 My Agent (`/me/agent`, S3.13) —
 * model select, Skills/systems/Worker-definition checklists (ticked = in use; unticking excludes —
 * see `FormState`), prompt addendum with a live char count, and the autoApproveLow toggle. Always
 * sends the full state of the first five fields on `set_agent_profile` (never a partial diff) so a
 * field the reader clears is unambiguously cleared. `autoApproveLow` is the exception (R-21): it is
 * sent only when the reader changed the checkbox, and never while the checkbox is disabled — an
 * unrelated save must not turn "inherit" into an explicit value, and a stored value the policy no
 * longer allows must not lock the profile against every later save.
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
  // Leftover 98: every system on offer, as the kernel lists it (`availableGatekeepers`) — the ones
  // granted to this member (read and write) and every other one their agent may read without a
  // Grant (design doc §11 "门上的观察") — narrowed by the policy's gate cap like the other lists.
  // Unticking either kind excludes it; the name comes from the workspace's own gate list.
  const gateNames = new Map(gatekeepers.map((g) => [g.id, g.name]));
  const allowedGatekeepers = narrowByPolicyAllowList(
    profile.availableGatekeepers,
    policy?.allowedGatekeepers,
    (g) => g.gatekeeperId,
  ).flatMap((g) => {
    const name = gateNames.get(g.gatekeeperId);
    return name === undefined ? [] : [{ ...g, name }];
  });

  const maxChars = policy?.maxPromptAddendumChars;
  const overLimit = maxChars !== undefined && state.promptAddendum.length > maxChars;
  // R-21 / D-16: the workspace AgentPolicy's `false` is enforced — the checkbox is then disabled,
  // shows the effective (off) value, and is never sent.
  const autoApproveLowForcedOff = policy?.allowMemberAutoApproveLow === false;
  const autoApproveLowDisabled = editForbidden || autoApproveLowForcedOff;
  const autoApproveLowChecked = autoApproveLowDisabled
    ? profile.effective.autoApproveLow
    : state.autoApproveLow;

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || editForbidden) return;
    setFieldErrors({});
    setSubmitError(null);

    // Only a change the reader made, on an enabled checkbox: ticked → `null` (follow the
    // workspace), unticked → `false` (narrow me).
    const autoApproveLowChanged =
      !autoApproveLowDisabled && state.autoApproveLow !== (profile.autoApproveLow !== false);
    const params: SetAgentProfileParams = {
      principalId,
      model: state.model === INHERIT_MODEL ? null : state.model,
      excludedSkills: state.excludedSkills,
      excludedGatekeepers: state.excludedGatekeepers,
      excludedWorkerDefinitions: state.excludedWorkerDefs,
      promptAddendum: state.promptAddendum.trim().length > 0 ? state.promptAddendum : null,
      ...(autoApproveLowChanged ? { autoApproveLow: state.autoApproveLow ? null : false } : {}),
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

      {/* S8 W4 (audit M2 "长单列表单无分节") + console redesign P3-3 (V4): 模型 / 能力 / 提示词 /
       *  自动批准 四节，各自一张 `DashboardCard`（与 `EffectivePanel` 同一页右侧摘要卡呼应），左栏
       *  在 ≥1280px 与右侧摘要并排、更窄视口下退回单列（见 `AgentProfilePage.tsx`）。 */}
      <DashboardCard title={t('模型', 'Model')}>
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
            aria-label={t('模型', 'Model')}
            className="ap-model-select"
            value={state.model}
            onChange={(event) => update('model', event.target.value)}
            disabled={disabled}
            invalid={!!fieldErrors.model}
            aria-describedby={describedBy('ap-model', !fieldErrors.model, !!fieldErrors.model)}
          >
            <option value={INHERIT_MODEL}>
              {t('继承工作区默认', 'Inherit workspace default')}
            </option>
            {/* Audit P0-1 sweep: a stored model the workspace no longer offers stays visible as
             *  itself instead of the select silently showing the first option. */}
            {state.model !== INHERIT_MODEL && !allowedModels.some((m) => m.id === state.model) ? (
              <option value={state.model}>
                {t(`${state.model}（已不在可选范围内）`, `${state.model} (no longer allowed)`)}
              </option>
            ) : null}
            {allowedModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </Select>
        </Field>
      </DashboardCard>

      <DashboardCard title={t('能力', 'Capabilities')}>
        <p className="field-hint">
          {t(
            '勾选的都会给你的智能体用；以后新授权的系统、新发布的 Skill 和 Worker 会自动加入。取消勾选即不让它用。',
            'Everything ticked is available to your agent; systems granted and Skills / Workers published later are added automatically. Untick to keep one out.',
          )}
        </p>

        {/* Bugfix (PR #324 review): the three sub-groups ran into each other with no separation —
         *  adjacent `.checklist-group`s get a 16px gap via a sibling rule (`styles/pages.css`),
         *  kept as direct `DashboardCard` children (no extra wrapper) rather than nested one level
         *  deeper, which would push these `t(zh, en)` calls past the line width the i18n-pairs
         *  guard's `t(` lookback tolerates. */}
        <ChecklistField
          title="Skills"
          subtitle={t('已发布的 Skill', 'Published Skills')}
          options={allowedSkills.map((s) => ({ id: s.id, label: s.name }))}
          excluded={state.excludedSkills}
          onToggle={(id) => update('excludedSkills', toggleItem(state.excludedSkills, id))}
          disabled={disabled}
          error={fieldErrors.excludedSkills}
          testId="agent-profile-skills"
          emptyTitle={t('还没有已发布的 Skill', 'No published Skills yet')}
          empty={
            <a href={hrefs.catalog('skills')} className="link-inline">
              {t('去能力目录', 'Open the catalog')}
            </a>
          }
        />

        <ChecklistField
          title={t('系统接入', 'Connected systems')}
          subtitle={t(
            '本工作区可读的系统，以及授权给你的系统',
            'Systems readable in this workspace, and those granted to you',
          )}
          options={allowedGatekeepers.map((g) => ({
            id: g.gatekeeperId,
            label: g.name,
            note: g.granted
              ? t('读写（已授权）', 'Read & write (granted)')
              : t('只读（未授权）', 'Read only (not granted)'),
          }))}
          excluded={state.excludedGatekeepers}
          onToggle={(id) =>
            update('excludedGatekeepers', toggleItem(state.excludedGatekeepers, id))
          }
          disabled={disabled}
          error={fieldErrors.excludedGatekeepers}
          testId="agent-profile-gatekeepers"
          emptyTitle={t('还没有可用的系统', 'No system available yet')}
          empty={
            <>
              {t(
                '只读操作不需要授权；工作区所有者授权后，你的智能体才能经 Worker 执行写操作。',
                'Read operations need no grant; a workspace owner has to grant a system before your agent can act on it through a Worker.',
              )}{' '}
              <a href={hrefs.access()} className="link-inline">
                {t('查看授权', 'View grants')}
              </a>
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
          emptyTitle={t('还没有已发布的 Worker', 'No published Workers yet')}
          empty={
            <a href={hrefs.catalog('workers')} className="link-inline">
              {t('去能力目录', 'Open the catalog')}
            </a>
          }
        />
      </DashboardCard>

      <DashboardCard title={t('提示词', 'Prompt')}>
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
            aria-label={t('提示词附加', 'Prompt addendum')}
            value={state.promptAddendum}
            onChange={(event) => update('promptAddendum', event.target.value)}
            minRows={4}
            disabled={disabled}
            invalid={!!fieldErrors.promptAddendum || overLimit}
            aria-describedby={describedBy(
              'ap-prompt',
              !fieldErrors.promptAddendum,
              !!fieldErrors.promptAddendum,
            )}
          />
        </Field>
      </DashboardCard>

      <DashboardCard title={t('自动批准', 'Auto-approve')}>
        <label className="checkbox" data-testid="agent-profile-auto-approve-low">
          <input
            type="checkbox"
            checked={autoApproveLowChecked}
            onChange={(event) => update('autoApproveLow', event.target.checked)}
            disabled={disabled || autoApproveLowDisabled}
          />
          <span>
            {t('低风险动作自动批准', 'Auto-approve low blast-radius actions')}
            {autoApproveLowForcedOff && !editForbidden ? (
              <span className="text-3 text-small">
                {' '}
                {t(
                  '— 工作区策略已关闭低风险自动批准，对所有人强制生效',
                  '— the workspace policy has turned low-risk auto-approval off for everyone',
                )}
              </span>
            ) : null}
          </span>
        </label>
        {!autoApproveLowDisabled ? (
          <p className="field-hint" data-testid="agent-profile-auto-approve-low-hint">
            {t(
              '勾选：跟随工作区策略（当前允许）。取消勾选：你发起的低风险动作也都要人工审批。',
              'Ticked: follow the workspace policy (currently allowed). Unticked: your low-blast-radius actions need human approval too.',
            )}
          </p>
        ) : null}

        {fieldErrors.autoApproveLow ? (
          <p className="field-error" role="alert">
            {fieldErrors.autoApproveLow}
          </p>
        ) : null}
      </DashboardCard>

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
        <Button type="submit" variant="primary" disabled={disabled}>
          {t('保存', 'Save')}
        </Button>
      </div>
    </form>
  );
}

/** A checklist of what is on offer: ticked = in use, unticked = excluded (`excluded` holds the
 *  unticked ids). With nothing on offer, `emptyTitle` names what is missing and `empty` says where
 *  to fix it (the group title above is not repeated inside the empty state). */
function ChecklistField({
  title,
  subtitle,
  options,
  excluded,
  onToggle,
  disabled,
  error,
  testId,
  emptyTitle,
  empty,
}: {
  readonly title: string;
  readonly subtitle: string;
  /** `note`: a short qualifier shown after the label (the systems list's 读写 / 只读). */
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly note?: string;
  }[];
  readonly excluded: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly disabled: boolean;
  readonly error?: string;
  readonly testId: string;
  readonly emptyTitle: string;
  readonly empty: ReactNode;
}) {
  return (
    <div className="checklist-group" data-testid={testId}>
      <span className="checklist-group-title">{title}</span>
      <p className="checklist-group-hint">{subtitle}</p>
      {options.length === 0 ? (
        <EmptyState variant="inline" title={emptyTitle} body={empty} testId={`${testId}-empty`} />
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
              {option.note !== undefined ? <span className="tag">{option.note}</span> : null}
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
