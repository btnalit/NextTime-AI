import { useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { AgentPolicy } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError, isNotFoundError } from '../lib/errors.js';
import { formatDateTime, formatRelative, prettyJson, redactSensitive } from '../lib/format.js';
import type {
  GatekeeperListRow,
  ModelRow,
  PolicyRow,
  QuotaRow,
  SkillRow,
} from '../lib/governance.js';
import { AgentPolicyForm } from './AgentPolicyForm.js';
import { ModelsTable } from './ModelsTable.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { useToast } from './ui/Toast.js';

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
 * submit. `list_quotas`/`list_policies` have no fixed row shape anywhere in the registry (`Policy`
 * is an opaque `jsonRecord` on the write side, `set_policy{policy}`) — both render as generic
 * key/value or JSON-dump tables rather than assuming columns this PR cannot verify against a
 * kernel implementation that does not exist on `main` yet.
 */
export function ModelsPage({ http }: ModelsPageProps) {
  const toast = useToast();
  const { role } = useWorkspaceIdentity(http);
  const isOwner = role.role === 'owner';

  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const skills = useCapabilityList<SkillRow>(http, 'list_skills');
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const agentPolicy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  const quotas = useCapabilityList<QuotaRow>(http, 'list_quotas');
  const policies = useCapabilityList<PolicyRow>(http, 'list_policies');

  return (
    <div className="page">
      <PageHeader
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
          isNotFoundError(models.state.error) ? (
            <EmptyState
              icon="cpu"
              title="该能力尚未上线 Not live yet"
              body="list_models is part of S3.11, still landing on the kernel side."
              testId="models-unavailable"
            />
          ) : (
            <ErrorBanner
              error={models.state.error}
              title="Could not load models"
              onRetry={() => void models.reload()}
              testId="models-error"
            />
          )
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
          isNotFoundError(agentPolicy.state.error) ? (
            <EmptyState
              icon="cpu"
              title="该能力尚未上线 Not live yet"
              body="get_agent_policy is part of S3.13, still landing on the kernel side."
              testId="agent-policy-unavailable"
            />
          ) : isForbiddenError(agentPolicy.state.error) ? (
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
          isNotFoundError(quotas.state.error) ? (
            <EmptyState
              icon="cpu"
              title="该能力尚未上线 Not live yet"
              body="list_quotas is part of S3.11, still landing on the kernel side."
              testId="quotas-unavailable"
            />
          ) : isForbiddenError(quotas.state.error) ? (
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
          <table className="data-table" data-testid="quotas-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {quotas.state.data.items.map((row) => (
                <tr key={row.key}>
                  <td className="mono">{row.key}</td>
                  <td className="mono">{prettyJson(redactSensitive(row.value))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section" aria-labelledby="policies-title">
        <div className="section-header">
          <h2 id="policies-title">策略 Policies</h2>
        </div>
        {policies.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading policies" testId="policies-loading" />
        ) : policies.state.status === 'error' ? (
          isNotFoundError(policies.state.error) ? (
            <EmptyState
              icon="cpu"
              title="该能力尚未上线 Not live yet"
              body="list_policies is part of S3.11, still landing on the kernel side."
              testId="policies-unavailable"
            />
          ) : isForbiddenError(policies.state.error) ? (
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
          <div className="stack-s" data-testid="policies-list">
            {policies.state.data.items.map((policy, index) => {
              const createdAt = typeof policy.createdAt === 'string' ? policy.createdAt : undefined;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: Policy has no fixed id field (opaque jsonRecord) — see the module doc comment.
                <details className="disclosure" key={index}>
                  <summary>
                    Policy {index + 1}
                    {createdAt ? (
                      <span className="text-3 text-small">
                        {' · '}
                        <time title={formatDateTime(createdAt)}>{formatRelative(createdAt)}</time>
                      </span>
                    ) : null}
                  </summary>
                  <div className="disclosure-body">
                    <pre className="code-block">{prettyJson(redactSensitive(policy))}</pre>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
