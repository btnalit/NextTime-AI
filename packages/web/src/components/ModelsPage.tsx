import type { PolicyWire, QuotaListEntryWire } from '@nexttime/shared';
import { useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { AgentPolicy } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../lib/format.js';
import type { GatekeeperListRow, ModelRow, SkillRow } from '../lib/governance.js';
import { type Translate, useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { AgentPolicyForm } from './AgentPolicyForm.js';
import { ModelsTable } from './ModelsTable.js';
import { DataTable, type DataTableColumn } from './kit/data-table.js';
import { PageHeader } from './kit/page-header.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

/** The five I18 quota keys (`application/task/quotas.ts` `QUOTA_KEY_VALUES`) with a human label
 *  and unit; an unknown key (a future axis) falls back to the raw key so nothing is hidden. */
const QUOTA_LABELS: Readonly<
  Record<string, { readonly zh: string; readonly en: string; readonly unit: string }>
> = {
  'task.max_depth': { zh: '派生链深度上限', en: 'Max invoke_worker depth', unit: '' },
  'task.max_concurrent_worker_runs_per_user': {
    zh: '每用户并发 WorkerRun 数',
    en: 'Concurrent WorkerRuns per user',
    unit: '',
  },
  'task.default_token_budget': {
    zh: '每 Task token 预算',
    en: 'Per-Task token budget',
    unit: 'tokens',
  },
  'task.default_duration_limit_sec': {
    zh: '每 Task 时长上限',
    en: 'Per-Task duration limit',
    unit: 's',
  },
  'task.daily_cost_budget_usd': { zh: '每工作区日成本', en: 'Daily cost budget', unit: 'USD' },
};

function quotaValue(row: QuotaListEntryWire, t: Translate): string {
  if (row.value === null) return t('不限', 'unlimited');
  const unit = QUOTA_LABELS[row.key]?.unit ?? '';
  return unit ? `${row.value} ${unit}` : String(row.value);
}

/** S8 W1-A4 (audit S3, "配额 808" — the Quotas table overflows horizontally at 768); S8 W1-A10
 *  turned this from a module-level array into a `t`-taking factory (i18n remainder) — every cell
 *  is still pure display, no row-level callback or component-state closure to capture beyond `t`.
 *  `key` is the row's own primary key ("配额 Quota", not a human name), so it is `primary`; the
 *  effective value reads as the row's "status" here. */
function quotaColumns(t: Translate): readonly DataTableColumn<QuotaListEntryWire>[] {
  return [
    {
      id: 'key',
      header: t('配额', 'Quota'),
      priority: 'primary',
      cell: (row) => (
        <>
          <div>
            {row.key in QUOTA_LABELS
              ? t(QUOTA_LABELS[row.key]?.zh ?? row.key, QUOTA_LABELS[row.key]?.en ?? row.key)
              : row.key}
          </div>
          <div className="mono text-3 text-small">{row.key}</div>
        </>
      ),
    },
    {
      id: 'value',
      header: t('生效值', 'Effective value'),
      priority: 'high',
      cellClassName: 'mono',
      cell: (row) => <span data-testid="quota-value">{quotaValue(row, t)}</span>,
    },
    {
      id: 'source',
      header: t('来源', 'Source'),
      cell: (row) => (
        <span className="tag" data-testid="quota-source">
          {row.isDefault ? t('默认', 'default') : t('工作区覆盖', 'override')}
        </span>
      ),
    },
    {
      id: 'updatedBy',
      header: t('设置人', 'Set by'),
      cellClassName: 'mono text-3',
      cell: (row) => (row.updatedBy ? shortId(row.updatedBy) : '—'),
    },
    {
      id: 'updatedAt',
      header: t('更新', 'Updated'),
      cell: (row) =>
        row.updatedAt ? (
          <time title={formatDateTime(row.updatedAt)}>{formatRelative(row.updatedAt)}</time>
        ) : (
          '—'
        ),
    },
  ];
}

/** S8 W1-A4 (audit S3, same page as `quotaColumns`); S8 W1-A10 turned this into a `t`-taking
 *  factory too. `actionKindTag` is the row's own identity (§1 wire vocabulary — "actionKind" is
 *  only the `{tag,label}` display object, this is the bare tag), so it is `primary`; `blastRadius`
 *  reads as the row's "status". */
function policyColumns(t: Translate): readonly DataTableColumn<PolicyWire>[] {
  return [
    {
      id: 'actionKind',
      header: t('动作种类', 'Action kind'),
      priority: 'primary',
      cellClassName: 'mono',
      cell: (policy) => <span data-testid="policy-action-kind">{policy.actionKindTag}</span>,
    },
    {
      id: 'blastRadius',
      header: t('影响', 'Blast radius'),
      priority: 'high',
      cell: (policy) =>
        policy.blastRadius ? (
          <StatusChip machine="blastRadius" status={policy.blastRadius} size="s" />
        ) : (
          <span className="text-3">{t('任意', 'any')}</span>
        ),
    },
    {
      id: 'autoApprove',
      header: t('自动批准', 'Auto-approve'),
      cell: (policy) => (
        <span
          className={`chip chip-s ${policy.autoApprove ? 'chip-ok' : 'chip-warn'}`}
          data-testid="policy-auto-approve"
        >
          {policy.autoApprove ? t('自动批准', 'auto') : t('需审批', 'requires approval')}
        </span>
      ),
    },
    {
      id: 'requesterCanApprove',
      header: t('申请人可自批', 'Requester may approve'),
      cell: (policy) =>
        policy.requesterCanApprove === null
          ? '—'
          : policy.requesterCanApprove
            ? t('是', 'yes')
            : t('否', 'no'),
    },
    {
      id: 'setBy',
      header: t('设置人', 'Set by'),
      cellClassName: 'mono text-3',
      cell: (policy) => shortId(policy.setBy),
    },
    {
      id: 'updatedAt',
      header: t('更新', 'Updated'),
      cell: (policy) => (
        <time title={formatDateTime(policy.updatedAt)}>{formatRelative(policy.updatedAt)}</time>
      ),
    },
  ];
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
  const t = useT();
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
        title={t('模型与配额', 'Models & Quotas')}
        description={t(
          '模型清单、工作区策略、配额与策略规则。',
          'Models, the workspace policy, quotas, and policy rules.',
        )}
      />

      <section className="section" aria-labelledby="models-title">
        <div className="section-header">
          <h2 id="models-title">{t('模型', 'Models')}</h2>
        </div>
        {models.state.status === 'loading' ? (
          <SkeletonRows count={3} label="Loading models" testId="models-loading" />
        ) : models.state.status === 'error' ? (
          <ErrorBanner
            error={models.state.error}
            title={t('无法加载模型清单', 'Could not load models')}
            onRetry={() => void models.reload()}
            testId="models-error"
          />
        ) : (
          <ModelsTable models={models.state.data.items} />
        )}
      </section>

      <section className="section" aria-labelledby="agent-policy-title">
        <div className="section-header">
          <h2 id="agent-policy-title">{t('工作区策略', 'Workspace policy')}</h2>
        </div>
        {agentPolicy.state.status === 'loading' ? (
          <SkeletonRows count={3} label="Loading workspace policy" testId="agent-policy-loading" />
        ) : agentPolicy.state.status === 'error' ? (
          isForbiddenError(agentPolicy.state.error) ? (
            <EmptyState icon="shield" title="需要成员权限" testId="agent-policy-forbidden" />
          ) : (
            <ErrorBanner
              error={agentPolicy.state.error}
              title={t('无法加载工作区策略', 'Could not load the workspace policy')}
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
              toast.push({ tone: 'ok', title: t('策略已保存', 'Policy saved') });
            }}
          />
        ) : (
          <div className="stack-s" data-testid="agent-policy-readonly">
            <Notice testId="agent-policy-owner-only">
              {t('需要所有者权限来修改', 'Editing this policy requires the workspace owner role.')}
            </Notice>
            <dl className="definition-list">
              <dt>{t('默认模型', 'Default model')}</dt>
              <dd className="mono">{agentPolicy.state.data.defaultModel}</dd>
              <dt>{t('成员可编辑自己的配置', 'Member can edit own profile')}</dt>
              <dd>
                {agentPolicy.state.data.memberCanEditProfile ? t('是', 'Yes') : t('否', 'No')}
              </dd>
              <dt>{t('提示词附加字数上限', 'Prompt addendum character limit')}</dt>
              <dd>{agentPolicy.state.data.maxPromptAddendumChars}</dd>
              <dt>
                {t('允许成员自动批准低风险', 'Allow members to auto-approve low-impact actions')}
              </dt>
              <dd>
                {agentPolicy.state.data.allowMemberAutoApproveLow ? t('是', 'Yes') : t('否', 'No')}
              </dd>
            </dl>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="quotas-title">
        <div className="section-header">
          <h2 id="quotas-title">{t('配额', 'Quotas')}</h2>
        </div>
        {quotas.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading quotas" testId="quotas-loading" />
        ) : quotas.state.status === 'error' ? (
          isForbiddenError(quotas.state.error) ? (
            <EmptyState
              icon="shield"
              title={t('需要所有者或操作员权限', 'Requires the owner or operator role')}
              body={t(
                '配额列表只对工作区所有者和操作员可见。',
                'The quota list is visible only to the workspace owner and operators.',
              )}
              testId="quotas-forbidden"
            />
          ) : (
            <ErrorBanner
              error={quotas.state.error}
              title={t('无法加载配额', 'Could not load quotas')}
              onRetry={() => void quotas.reload()}
              testId="quotas-error"
            />
          )
        ) : quotas.state.data.items.length === 0 ? (
          <EmptyState
            icon="cpu"
            title={t('还没有配额设置', 'No quotas set')}
            testId="quotas-empty"
          />
        ) : (
          <DataTable
            columns={quotaColumns(t)}
            data={quotas.state.data.items}
            getRowId={(row) => row.key}
            ariaLabel="Quotas"
            testId="quotas-table"
            rowTestId={(row) => `quota-row-${row.key}`}
          />
        )}
      </section>

      <section className="section" aria-labelledby="policies-title">
        <div className="section-header">
          <h2 id="policies-title">{t('策略', 'Policies')}</h2>
        </div>
        {policies.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading policies" testId="policies-loading" />
        ) : policies.state.status === 'error' ? (
          isForbiddenError(policies.state.error) ? (
            <EmptyState
              icon="shield"
              title={t('需要所有者权限', 'Requires the owner role')}
              body={t(
                '策略列表只对工作区所有者可见。',
                'The policy list is visible only to the workspace owner.',
              )}
              testId="policies-forbidden"
            />
          ) : (
            <ErrorBanner
              error={policies.state.error}
              title={t('无法加载策略', 'Could not load policies')}
              onRetry={() => void policies.reload()}
              testId="policies-error"
            />
          )
        ) : policies.state.data.items.length === 0 ? (
          <EmptyState
            icon="cpu"
            title={t('还没有策略规则', 'No policy rules set')}
            testId="policies-empty"
          />
        ) : (
          <DataTable
            columns={policyColumns(t)}
            data={policies.state.data.items}
            getRowId={(policy) => policy.id}
            ariaLabel="Policies"
            testId="policies-table"
            rowTestId={(policy) => `policy-row-${policy.id}`}
            rowDataAttrs={(policy) => ({ 'data-policy-id': policy.id })}
          />
        )}
      </section>
    </div>
  );
}
