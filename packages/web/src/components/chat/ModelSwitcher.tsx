import { useId, useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import {
  type AgentPolicy,
  type AgentProfile,
  narrowByPolicyAllowList,
} from '../../lib/agent-profile.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import type { ModelRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { Select } from '../ui/Field.js';
import { useToast } from '../ui/Toast.js';

export interface ModelSwitcherProps {
  /** The HTTP client — `get_agent_profile` / `set_agent_profile` / `get_agent_policy` /
   *  `list_models` are HTTP-eligible groups. */
  readonly http: CapabilityCaller;
  /** A Turn is in progress on this chat: switching is disabled (console-completion-plan §5.1
   *  "切换只能在没有进行中 Turn 时允许", §10: leftover 44 binds a Turn to its container, so a
   *  change mid-Turn cannot land on it — the rule stays). */
  readonly turnRunning: boolean;
}

/** `<option value>` for "inherit the workspace default" — `set_agent_profile{model: null}`. */
const WORKSPACE_DEFAULT = '';

/** "provider/model" when the catalog knows the id, else the raw id. */
function modelLabel(id: string, models: readonly ModelRow[]): string {
  const row = models.find((m) => m.id === id);
  return row ? `${row.provider}/${row.model}` : id;
}

/**
 * components/chat/ModelSwitcher (S6-A W2, console-completion-plan §5.1 "模式与模型显示" / "在授予
 * 范围内切换模型", §4 "Provider"): the header line "模式：入口 agent · 模型：<provider/model> ·
 * 来源：工作区默认 / 我的覆盖". Mode is a session kind, displayed and never switched (§4). The
 * model is a `<select>` over the workspace AgentPolicy's `allowedModels` (the platform catalog
 * `list_models`, narrowed the way `AgentProfileForm` narrows it — an empty allow-list means
 * unrestricted, `narrowByPolicyAllowList`); choosing one is `set_agent_profile{model}` (or
 * `null` for 工作区默认, S3.13), which takes effect on the next Turn — the toast says so. A
 * current override no longer in the allow-list is listed, flagged, and still switchable away
 * from. Disabled while a Turn runs, and once `set_agent_profile` has been refused (a member
 * whose policy has `memberCanEditProfile: false` — `usePermissions`).
 */
export function ModelSwitcher({ http, turnRunning }: ModelSwitcherProps) {
  const t = useT();
  const toast = useToast();
  const permissions = usePermissions();
  const selectId = useId();
  const profile = useCapability<AgentProfile>(http, 'get_agent_profile');
  const policy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  const catalog = useCapabilityList<ModelRow>(http, 'list_models');
  const [saving, setSaving] = useState(false);

  if (profile.state.status === 'loading') {
    return (
      <div className="chat-header-meta text-small text-3" data-testid="chat-model-line">
        {t('模式 Mode：入口 agent', 'Entry agent')}
      </div>
    );
  }
  if (profile.state.status === 'error') {
    return (
      <div className="chat-header-meta text-small text-3" data-testid="chat-model-line">
        模式 Mode：入口 agent Entry agent · 模型 Model：—
      </div>
    );
  }

  const current = profile.state.data;
  const policyData = policy.state.status === 'ready' ? policy.state.data : undefined;
  const models = catalog.state.status === 'ready' ? catalog.state.data.items : [];
  // The catalog narrowed by policy; when the catalog read is unavailable, the policy's own
  // allow-list still names what may be chosen.
  const allowed =
    models.length > 0
      ? narrowByPolicyAllowList(models, policyData?.allowedModels, (m) => m.id)
      : (policyData?.allowedModels ?? []).map((id) => ({ id, provider: '', model: id }));
  const override = current.model;
  const overrideOutsideAllowList = override !== null && !allowed.some((m) => m.id === override);
  const editDenied = permissions.isDenied('set_agent_profile');
  const disabled = turnRunning || saving || editDenied;
  const disabledReason = turnRunning
    ? t(
        'Turn 进行中不能切换模型 — 等本轮结束。',
        'Cannot switch while a turn is running — wait for it to finish.',
      )
    : editDenied
      ? t(
          '工作区策略不允许成员修改自己的模型。',
          'Workspace policy does not let members change their model.',
        )
      : undefined;

  async function choose(value: string): Promise<void> {
    const model = value === WORKSPACE_DEFAULT ? null : value;
    if (model === override) return;
    setSaving(true);
    try {
      const saved = await http.call<AgentProfile>('set_agent_profile', { model });
      invalidateCapability(http, 'get_agent_profile');
      profile.mutate(() => saved);
      toast.push({
        tone: 'ok',
        title: t('下一轮生效', 'Takes effect next turn'),
        description: `模型 Model：${modelLabel(saved.effective.model, models)}`,
        key: 'chat-model-switch',
      });
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('set_agent_profile');
      toast.push({
        tone: 'danger',
        title: t('切换模型失败', 'Could not switch the model'),
        description: describeError(err).message,
        key: 'chat-model-switch',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="chat-header-meta row-wrap text-small text-3"
      data-testid="chat-model-line"
      data-source={override === null ? 'workspace_default' : 'override'}
    >
      <span>{t('模式 Mode：入口 agent', 'Entry agent')}</span>
      <span aria-hidden>·</span>
      <label htmlFor={selectId} className="row">
        <span>模型 Model：</span>
        <Select
          id={selectId}
          value={override ?? WORKSPACE_DEFAULT}
          onChange={(event) => void choose(event.target.value)}
          disabled={disabled}
          title={disabledReason}
          aria-describedby={disabledReason ? `${selectId}-why` : undefined}
          data-testid="chat-model-select"
        >
          <option value={WORKSPACE_DEFAULT}>
            {t('工作区默认', 'Workspace default')}
            {policyData?.defaultModel ? ` · ${modelLabel(policyData.defaultModel, models)}` : ''}
          </option>
          {allowed.map((m) => (
            <option key={m.id} value={m.id}>
              {modelLabel(m.id, models)}
            </option>
          ))}
          {overrideOutsideAllowList && override !== null ? (
            <option value={override} data-testid="chat-model-outside">
              {modelLabel(override, models)} {t('· 不在允许范围', 'not in the allow-list')}
            </option>
          ) : null}
        </Select>
      </label>
      <span aria-hidden>·</span>
      <span data-testid="chat-model-source">
        来源 Source：
        {override === null ? t('工作区默认', 'Workspace default') : t('我的覆盖', 'My override')}
      </span>
      {overrideOutsideAllowList ? (
        <span className="chip chip-s chip-warn" data-testid="chat-model-flag">
          {t('不在允许范围', 'Not in the allow-list')}
        </span>
      ) : null}
      {disabledReason ? (
        <span id={`${selectId}-why`} className="visually-hidden">
          {disabledReason}
        </span>
      ) : null}
    </div>
  );
}
