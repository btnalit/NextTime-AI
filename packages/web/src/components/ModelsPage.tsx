import type { PolicyWire, QuotaListEntryWire } from '@nexttime/shared';
import { useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { AgentPolicy } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../lib/format.js';
import type { GatekeeperListRow, ModelRow, SkillRow } from '../lib/governance.js';
import { breadcrumbFor } from '../lib/nav.js';
import { AgentPolicyForm } from './AgentPolicyForm.js';
import { ModelsTable } from './ModelsTable.js';
import { PageHeader } from './kit/page-header.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

/** The five I18 quota keys (`application/task/quotas.ts` `QUOTA_KEY_VALUES`) with a human label
 *  and unit; an unknown key (a future axis) falls back to the raw key so nothing is hidden. */
const QUOTA_LABELS: Readonly<Record<string, { readonly label: string; readonly unit: string }>> = {
  'task.max_depth': { label: '派生链深度上限 Max invoke_worker depth', unit: '' },
  'task.max_concurrent_worker_runs_per_user': {
    label: '每用户并发 WorkerRun Concurrent WorkerRuns per user',
    unit: '',
  },
  'task.default_token_budget': {
    label: '每 Task token 预算 Per-Task token budget',
    unit: 'tokens',
  },
  'task.default_duration_limit_sec': {
    label: '每 Task 时长上限 Per-Task duration limit',
    unit: 's',
  },
  'task.daily_cost_budget_usd': { label: '每工作区日成本 Daily cost budget', unit: 'USD' },
};

function quotaValue(row: QuotaListEntryWire): string {
  if (row.value === null) return '不限 unlimited';
  const unit = QUOTA_LABELS[row.key]?.unit ?? '';
  return unit ? `${row.value} ${unit}` : String(row.value);
}

export interface ModelsPageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/ModelsPage: 模型与配额 Models & Quotas (`/govern/models`, S3.11's "目录" group —
 * `list_models` is `minRole: 'member'` per the design doc's own minRole table, S3.11 background
 * note — visible to every signed-in principal; `list_quotas`/`list_policies` sit in the
 * "审批与配额查看"/"成员/授权/策略" groups (operator/owner) so their sections degrade to a 403
 * explanation independently of the models table above them).
 *
 * S3.13 deliverable 2: the AgentPolicy editor sits between the (still read-only) Models table and
 * the pre-existing Quotas/Policies tables — it is the workspace-wide ceiling every `/me/agent`
 * AgentProfile is narrowed against, so it reads naturally right after the model allow-list it
 * itself narrows. `get_agent_policy` is `member`-readable (every signed-in principal can *see* the
 * policy), but only an owner gets the editable form (`AgentPolicyForm`, `set_agent_policy` is
 * owner-only) — everyone else sees a read-only summary instead of a form that can only 403 on
 * submit. B6: the S3.11 / S3.13 "该能力尚未上线" branches are gone — every capability this page
 * reads has shipped, so a `not_found` is an ordinary error.
 *
 * C29 (S6-B, console-completion-plan.md §2b / §5.4): `list_quotas` and `list_policies` do have
 * public row structures — `QuotaListEntryWireSchema` / `PolicyWireSchema` in `@nexttime/shared`
 * wire/governance.ts, `.strict()`, enforced on the kernel by `KERNEL_VALIDATE_RESULTS=1` — so
 * the two sections render real columns (quota: key / effective value / default-or-override /
 * who / when; policy: action kind tag / blast radius / auto-approve / requester-can-approve /
 * set by / when) instead of the pre-S6 key/value table and redacted JSON dump. The models table
 * above stays the read-only projection of the platform catalog (`#/platform/models` is where
 * providers are managed; the workspace only picks from it, "只选不配").
 */
export function ModelsPage({ http }: ModelsPageProps) {
  const toast = useToast();
  const { role } = useWorkspaceIdentity(http);
  const isOwner = role.role === 'owner';

  const models = useCapabilityList<ModelRow>(http, 'list_models');
  // A picker inside AgentPolicyForm, not a browsable list — autoLoadAll (S8 W1-C #243 made
  // list_skills keyset-paginated; a missing Skill past page one would be a correctness bug here).
  const skills = useCapabilityList<SkillRow>(http, 'list_skills', {}, { autoLoadAll: true });
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const agentPolicy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  const quotas = useCapabilityList<QuotaListEntryWire>(http, 'list_quotas');
  const policies = useCapabilityList<PolicyWire>(http, 'list_policies');

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('models')}
        title="模型与配额 Models & Quotas"
        description="The llm-proxy model allow-list, workspace AgentPolicy, quotas, and policy rules."
      />

      <section className="section" aria-labelledby="models-title">
        <div className="section-header">
          <h2 id="models-title">模型 Models</h2>
        </div>
        {models.state.status === 'loading' ? (
          <SkeletonRows count={3} label="Loading models" testId="models-loading" />
        ) : models.state.status === 'error' ? (
          <ErrorBanner
            error={models.state.error}
            title="Could not load models"
            onRetry={() => void models.reload()}
            testId="models-error"
          />
        ) : (
          <ModelsTable models={models.state.data.items} />
        )}
      </section>

      <section className="section" aria-labelledby="agent-policy-title">
        <div className="section-header">
          <h2 id="agent-policy-title">AgentPolicy</h2>
        </div>
        {agentPolicy.state.status === 'loading' ? (
          <SkeletonRows count={3} label="Loading AgentPolicy" testId="agent-policy-loading" />
        ) : agentPolicy.state.status === 'error' ? (
          isForbiddenError(agentPolicy.state.error) ? (
            <EmptyState icon="shield" title="需要成员权限" testId="agent-policy-forbidden" />
          ) : (
            <ErrorBanner
              error={agentPolicy.state.error}
              title="Could not load AgentPolicy"
              onRetry={() => void agentPolicy.reload()}
              testId="agent-policy-error"
            />
          )
        ) : isOwner ? (
          <AgentPolicyForm
            http={http}
            policy={agentPolicy.state.data}
            models={models.state.status === 'ready' ? models.state.data.items : []}
            skills={skills.state.status === 'ready' ? skills.state.data.items : []}
            gatekeepers={gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : []}
            onSaved={(saved) => {
              agentPolicy.mutate(() => saved);
              toast.push({ tone: 'ok', title: 'AgentPolicy saved' });
            }}
          />
        ) : (
          <div className="stack-s" data-testid="agent-policy-readonly">
            <Notice testId="agent-policy-owner-only">
              需要 owner 权限来修改 Editing AgentPolicy requires the workspace owner role.
            </Notice>
            <dl className="definition-list">
              <dt>默认模型 Default model</dt>
              <dd className="mono">{agentPolicy.state.data.defaultModel}</dd>
              <dt>Member 可编辑自己配置</dt>
              <dd>{agentPolicy.state.data.memberCanEditProfile ? '是 Yes' : '否 No'}</dd>
              <dt>提示词附加字数上限</dt>
              <dd>{agentPolicy.state.data.maxPromptAddendumChars}</dd>
              <dt>允许 member 自动批准低风险</dt>
              <dd>{agentPolicy.state.data.allowMemberAutoApproveLow ? '是 Yes' : '否 No'}</dd>
            </dl>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="quotas-title">
        <div className="section-header">
          <h2 id="quotas-title">配额 Quotas</h2>
        </div>
        {quotas.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading quotas" testId="quotas-loading" />
        ) : quotas.state.status === 'error' ? (
          isForbiddenError(quotas.state.error) ? (
            <EmptyState
              icon="shield"
              title="需要 owner/operator 权限"
              body="list_quotas is restricted to the workspace owner and operators."
              testId="quotas-forbidden"
            />
          ) : (
            <ErrorBanner
              error={quotas.state.error}
              title="Could not load quotas"
              onRetry={() => void quotas.reload()}
              testId="quotas-error"
            />
          )
        ) : quotas.state.data.items.length === 0 ? (
          <EmptyState icon="cpu" title="No quotas set" testId="quotas-empty" />
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="quotas-table">
              <thead>
                <tr>
                  <th>配额 Quota</th>
                  <th>生效值 Effective value</th>
                  <th>来源 Source</th>
                  <th>设置人 Set by</th>
                  <th>更新 Updated</th>
                </tr>
              </thead>
              <tbody>
                {quotas.state.data.items.map((row) => (
                  <tr key={row.key} data-testid={`quota-row-${row.key}`}>
                    <td>
                      <div>{QUOTA_LABELS[row.key]?.label ?? row.key}</div>
                      <div className="mono text-3 text-small">{row.key}</div>
                    </td>
                    <td className="mono" data-testid="quota-value">
                      {quotaValue(row)}
                    </td>
                    <td>
                      <span className="tag" data-testid="quota-source">
                        {row.isDefault ? '默认 default' : '工作区覆盖 override'}
                      </span>
                    </td>
                    <td className="mono text-3">{row.updatedBy ? shortId(row.updatedBy) : '—'}</td>
                    <td>
                      {row.updatedAt ? (
                        <time title={formatDateTime(row.updatedAt)}>
                          {formatRelative(row.updatedAt)}
                        </time>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="policies-title">
        <div className="section-header">
          <h2 id="policies-title">策略 Policies</h2>
        </div>
        {policies.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading policies" testId="policies-loading" />
        ) : policies.state.status === 'error' ? (
          isForbiddenError(policies.state.error) ? (
            <EmptyState
              icon="shield"
              title="需要 owner 权限"
              body="list_policies is restricted to the workspace owner."
              testId="policies-forbidden"
            />
          ) : (
            <ErrorBanner
              error={policies.state.error}
              title="Could not load policies"
              onRetry={() => void policies.reload()}
              testId="policies-error"
            />
          )
        ) : policies.state.data.items.length === 0 ? (
          <EmptyState icon="cpu" title="No policy rules set" testId="policies-empty" />
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="policies-table">
              <thead>
                <tr>
                  <th>动作种类 Action kind</th>
                  <th>影响 Blast radius</th>
                  <th>自动批准 Auto-approve</th>
                  <th>申请人可自批 Requester may approve</th>
                  <th>设置人 Set by</th>
                  <th>更新 Updated</th>
                </tr>
              </thead>
              <tbody>
                {policies.state.data.items.map((policy) => (
                  <tr
                    key={policy.id}
                    data-testid={`policy-row-${policy.id}`}
                    data-policy-id={policy.id}
                  >
                    <td className="mono" data-testid="policy-action-kind">
                      {policy.actionKindTag}
                    </td>
                    <td>
                      {policy.blastRadius ? (
                        <StatusChip machine="blastRadius" status={policy.blastRadius} size="s" />
                      ) : (
                        <span className="text-3">任意 any</span>
                      )}
                    </td>
                    <td data-testid="policy-auto-approve">
                      <span
                        className={`chip chip-s ${policy.autoApprove ? 'chip-ok' : 'chip-warn'}`}
                      >
                        {policy.autoApprove ? '自动批准 auto' : '需审批 requires approval'}
                      </span>
                    </td>
                    <td>
                      {policy.requesterCanApprove === null
                        ? '—'
                        : policy.requesterCanApprove
                          ? '是 yes'
                          : '否 no'}
                    </td>
                    <td className="mono text-3">{shortId(policy.setBy)}</td>
                    <td>
                      <time title={formatDateTime(policy.updatedAt)}>
                        {formatRelative(policy.updatedAt)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
