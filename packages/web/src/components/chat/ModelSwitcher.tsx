import { useEffect, useId, useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import {
  type AgentPolicy,
  type AgentProfile,
  narrowByPolicyAllowList,
  policyLetsEditOwnProfile,
} from '../../lib/agent-profile.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { errorToastText, isForbiddenError } from '../../lib/errors.js';
import type { ModelRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { type ProviderStatus, describeProviderHealth } from '../../lib/provider-status.js';
import { ModelHealthTag, ModelOption, modelHealth } from '../kit/model-health.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { useToast } from '../ui/Toast.js';

export interface ModelSwitcherProps {
  /** The HTTP client — `get_agent_profile` / `set_agent_profile` / `get_agent_policy` /
   *  `list_models` are HTTP-eligible groups. */
  readonly http: CapabilityCaller;
  /** A Turn is in progress on this chat: switching is disabled (console-completion-plan §5.1
   *  "切换只能在没有进行中 Turn 时允许", §10: leftover 44 binds a Turn to its container, so a
   *  change mid-Turn cannot land on it — the rule stays). */
  readonly turnRunning: boolean;
  /** The model the next Turn runs and its provider's health, whenever either changes — `null`
   *  while unknown (loading, or the catalog does not list it). `ChatPage` shows
   *  `ChatModelHealthNotice` above the composer with it (console audit #530 必修 3). */
  readonly onRunningModel?: (running: RunningModelHealth | null) => void;
}

/** The model the next Turn runs, its provider's health and where the choice comes from. */
export interface RunningModelHealth {
  readonly modelId: string;
  readonly provider: string;
  readonly health: ProviderStatus;
  readonly source: 'override' | 'workspace_default';
  /** Whether any model this member may pick has a provider that passed its test — when none
   *  does, "pick a working model" is no advice (#530 audit P2). */
  readonly anyWorking: boolean;
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
 *
 * Console redesign P3-2 (V3 "对话", V8 "原生 select"): renders as the artboard's compact model
 * pill — a "模型" label beside a `kit/select` — instead of the old "模式：入口 agent · 模型：… · 来源
 * Source：…" full-width line; "模式：入口 agent" moved to `ChatHeader`'s own status line (this
 * component is now purely about the model), and "来源" no longer glues its English translation
 * into the same literal (`t('来源：', 'Source: ')`, not the old bare "来源 Source：" — V8's own
 * finding). `data-testid="chat-model-line"` stays on this pill (existing tests key off it).
 */
export function ModelSwitcher({ http, turnRunning, onRunningModel }: ModelSwitcherProps) {
  const t = useT();
  const toast = useToast();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const { role } = useWorkspaceIdentity(http);
  const selectId = useId();
  const profile = useCapability<AgentProfile>(http, 'get_agent_profile');
  const policy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  const catalog = useCapabilityList<ModelRow>(http, 'list_models');
  const [saving, setSaving] = useState(false);

  // The model the next Turn runs (`effective.model`: the override, else the workspace default).
  const profileData = profile.state.status === 'ready' ? profile.state.data : undefined;
  const runningRow =
    profileData && catalog.state.status === 'ready'
      ? catalog.state.data.items.find((m) => m.id === profileData.effective.model)
      : undefined;
  const runningId = runningRow?.id ?? null;
  const runningProvider = runningRow?.provider ?? '';
  const runningKind = modelHealth(runningRow)?.kind ?? null;
  const runningSource = profileData?.model == null ? 'workspace_default' : 'override';
  const policyAllowed =
    policy.state.status === 'ready' ? policy.state.data.allowedModels : undefined;
  const anyWorking =
    catalog.state.status === 'ready' &&
    narrowByPolicyAllowList(catalog.state.data.items, policyAllowed, (m) => m.id).some(
      (m) => modelHealth(m)?.usability === 'ok',
    );
  useEffect(() => {
    if (!onRunningModel) return;
    onRunningModel(
      runningId !== null && runningKind !== null
        ? {
            modelId: runningId,
            provider: runningProvider,
            health: describeProviderHealth(runningKind),
            source: runningSource,
            anyWorking,
          }
        : null,
    );
  }, [onRunningModel, runningId, runningProvider, runningKind, runningSource, anyWorking]);

  if (profile.state.status === 'loading') {
    return (
      <div className="chat-model-pill text-small text-3" data-testid="chat-model-line">
        {t('模型：加载中…', 'Model: Loading…')}
      </div>
    );
  }
  if (profile.state.status === 'error') {
    return (
      <div className="chat-model-pill text-small text-3" data-testid="chat-model-line">
        {t('模型：—', 'Model: —')}
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
  // #541 review M3: decided before the call, never by sending a switch the kernel must refuse —
  // the role first (an auditor reads only), then the workspace policy (a member may be barred
  // from changing their own agent), then what this session already learned from a 403.
  const roleRefused = role.kind === 'known' && can('set_agent_profile') === false;
  const policyRefused =
    policyLetsEditOwnProfile(policyData, role.kind === 'known' ? role.role : null) === false ||
    permissions.isDenied('set_agent_profile');
  const disabled = turnRunning || saving || roleRefused || policyRefused;
  const disabledReason = turnRunning
    ? t(
        'Turn 进行中不能切换模型 — 等本轮结束。',
        'Cannot switch while a turn is running — wait for it to finish.',
      )
    : roleRefused
      ? t(
          '你的角色只能查看，不能切换模型。',
          'Your role can only look — it cannot switch the model.',
        )
      : policyRefused
        ? t(
            '工作区策略不允许成员修改自己的模型；要换模型，请找工作区所有者。',
            'Workspace policy does not let members change their model; ask the workspace owner.',
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
        description: t(
          `模型：${modelLabel(saved.effective.model, models)}`,
          `Model: ${modelLabel(saved.effective.model, models)}`,
        ),
        key: 'chat-model-switch',
      });
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('set_agent_profile');
      toast.push({
        tone: 'danger',
        title: t('切换模型失败', 'Could not switch the model'),
        description: errorToastText(err, t),
        key: 'chat-model-switch',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="chat-model-pill"
      data-testid="chat-model-line"
      data-source={override === null ? 'workspace_default' : 'override'}
    >
      <span className="chat-model-pill-label text-3 text-small" aria-hidden>
        {t('模型', 'Model')}
      </span>
      <Select
        aria-label={t(
          '切换模型（工作区允许的范围）',
          'Switch model (within the workspace allow-list)',
        )}
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
          <ModelOption
            key={m.id}
            model={m}
            label={modelLabel(m.id, models)}
            selected={m.id === override}
          />
        ))}
        {overrideOutsideAllowList && override !== null ? (
          <option value={override} data-testid="chat-model-outside">
            {modelLabel(override, models)} {t('· 不在允许范围', 'not in the allow-list')}
          </option>
        ) : null}
      </Select>
      {overrideOutsideAllowList ? (
        <span className="chip chip-s chip-warn" data-testid="chat-model-flag">
          {t('不在允许范围', 'Not in the allow-list')}
        </span>
      ) : null}
      {/* Audit P0-2: the provider of the model this chat runs when it is not known to work. Only
       *  for the workspace default — an override's option already carries the status (#530 P2:
       *  never twice); the reason and next step are ChatModelHealthNotice's, above the composer. */}
      {override === null ? <ModelHealthTag model={runningRow} testId="chat-model-health" /> : null}
      <span className="chat-model-source text-3 text-small" data-testid="chat-model-source">
        {t('来源：', 'Source: ')}
        {override === null ? t('工作区默认', 'Workspace default') : t('我的覆盖', 'My override')}
      </span>
      {disabledReason ? (
        <span id={`${selectId}-why`} className="visually-hidden">
          {disabledReason}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The line above the composer when the model the next Turn runs is not known to work (console
 * audit #530 必修 3): the provider's status and why, and the next step for this member — switch
 * away from their own override, or ask whoever owns the workspace default and the provider.
 * Sending stays possible (health is the last test, not a live probe), but never silently.
 */
export function ChatModelHealthNotice({
  running,
}: { readonly running: RunningModelHealth | null }) {
  const t = useT();
  if (!running || running.health.usability === 'ok') return null;
  const { health, provider, modelId } = running;
  const fails = health.usability === 'blocked';
  const status = t(
    `模型 ${modelId} 的供应商「${provider}」：${health.zh}（${health.detailZh}）。`,
    `Model ${modelId}, provider "${provider}": ${health.en} (${health.detailEn}).`,
  );
  const next =
    running.source === 'override'
      ? fails
        ? t(
            '这个模型现在调不通，发送会失败：在上方「模型」里换一个模型，或选「工作区默认」。',
            'This model fails right now and sending will fail: pick another model above, or choose Workspace default.',
          )
        : running.anyWorking
          ? t(
              '发送可能失败；要稳妥，在上方「模型」里换一个状态为可用的模型。',
              'Sending may fail; to be safe, pick a working model above.',
            )
          : t(
              '发送可能失败；现在没有哪个模型确认可用，请平台管理员检查供应商状态。',
              'Sending may fail; no model is confirmed working right now — ask a platform administrator to check the providers.',
            )
      : fails
        ? t(
            '发送会失败：请工作区管理员换默认模型，或请平台管理员修复这个供应商。',
            'Sending will fail: ask a workspace administrator to change the default model, or a platform administrator to fix the provider.',
          )
        : t(
            '发送可能失败：请平台管理员测试这个供应商，或请工作区管理员换默认模型。',
            'Sending may fail: ask a platform administrator to test the provider, or a workspace administrator to change the default model.',
          );
  return (
    <Notice tone="warn" testId="chat-model-health-notice">
      <span data-health={health.kind} data-source={running.source}>
        {status} {next}
      </span>
    </Notice>
  );
}
