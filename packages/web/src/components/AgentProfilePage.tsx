import { useState } from 'react';
import { invalidateCapability, useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { AgentPolicy, AgentProfile } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError, isNotFoundError } from '../lib/errors.js';
import type { GatekeeperListRow, ModelRow, PrincipalRow, SkillRow } from '../lib/governance.js';
import type { WorkerDefinitionSummary } from '../lib/tasks.js';
import { AgentProfileForm } from './AgentProfileForm.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { useToast } from './ui/Toast.js';

export interface AgentProfilePageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/AgentProfilePage: 我的智能体 My Agent (`/me/agent`, S3.13) — per-user model, Skills,
 * connected systems, Worker definitions, prompt addendum, and low-risk auto-approve, all a
 * subset-only projection of the caller's own Grants and the workspace's AgentPolicy (never wider —
 * §S3.13 "Profile 是 Grant 的子集投影，永不扩权"). None of `get_agent_profile`/`set_agent_profile`/
 * `get_agent_policy` exist in `@nexttime/shared`'s registry yet on `main` as of this PR — the
 * kernel half is landing in a parallel PR against the same contract (`lib/agent-profile.ts`'s own
 * doc comment); every read here treats a `not_found` on the *self* view as "该能力尚未上线", same
 * convention every other S3.11/S3.13 page uses.
 *
 * An owner may switch the target principal via a dropdown seeded from `list_principals` (S3.11,
 * already on `main`) — `get_agent_profile{principalId}`'s own `not_found` is genuinely ambiguous
 * for that case (capability not deployed vs. no such principal), so it renders a plain error there
 * instead of the same "not live yet" messaging the parameterless self-view is confident about.
 */
export function AgentProfilePage({ http }: AgentProfilePageProps) {
  const toast = useToast();
  const { role } = useWorkspaceIdentity(http);
  const [selectedPrincipalId, setSelectedPrincipalId] = useState<string | undefined>(undefined);

  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const skills = useCapabilityList<SkillRow>(http, 'list_skills');
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const workerDefinitions = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    {},
  );
  const principals = useCapabilityList<PrincipalRow>(http, 'list_principals');
  const policy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  const profile = useCapability<AgentProfile>(
    http,
    'get_agent_profile',
    selectedPrincipalId ? { principalId: selectedPrincipalId } : undefined,
  );

  const canPickPrincipal = principals.state.status === 'ready';
  const humanPrincipals =
    principals.state.status === 'ready'
      ? principals.state.data.items.filter((p) => p.kind === 'human')
      : [];

  function handleSaved(saved: AgentProfile): void {
    invalidateCapability(http, 'get_agent_profile');
    profile.mutate(() => saved);
    toast.push({ tone: 'ok', title: '已保存 Saved' });
  }

  const editForbidden =
    selectedPrincipalId === undefined &&
    policy.state.status === 'ready' &&
    !policy.state.data.memberCanEditProfile &&
    role.role !== 'owner';

  return (
    <div className="page">
      <PageHeader
        title="我的智能体 My Agent"
        description="Per-user Agent configuration — model, Skills, connected systems, prompt addendum."
        actions={
          canPickPrincipal && humanPrincipals.length > 1 ? (
            <Field id="ap-principal" label="查看/编辑 View / edit">
              <Select
                id="ap-principal"
                value={selectedPrincipalId ?? ''}
                onChange={(event) => setSelectedPrincipalId(event.target.value || undefined)}
              >
                <option value="">我自己 Myself</option>
                {humanPrincipals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          ) : undefined
        }
      />

      {profile.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading Agent profile" testId="agent-profile-loading" />
      ) : profile.state.status === 'error' ? (
        selectedPrincipalId === undefined && isNotFoundError(profile.state.error) ? (
          <EmptyState
            icon="cpu"
            title="该能力尚未上线 Not live yet"
            body="get_agent_profile is part of S3.13, still landing on the kernel side."
            testId="agent-profile-unavailable"
          />
        ) : isForbiddenError(profile.state.error) ? (
          <EmptyState
            icon="shield"
            title="无权查看该智能体配置"
            body="get_agent_profile: member 只能看自己，owner 可看任何人。"
            testId="agent-profile-forbidden"
          />
        ) : (
          <ErrorBanner
            error={profile.state.error}
            title="Could not load this Agent profile"
            onRetry={() => void profile.reload()}
            testId="agent-profile-error"
          />
        )
      ) : (
        <>
          {policy.state.status === 'error' && !isNotFoundError(policy.state.error) ? (
            <Notice tone="warn" testId="agent-policy-load-warning">
              Could not load workspace AgentPolicy — options below are shown unnarrowed.
            </Notice>
          ) : null}

          <EffectivePanel profile={profile.state.data} />

          <AgentProfileForm
            key={profile.state.data.principalId}
            http={http}
            principalId={profile.state.data.principalId}
            profile={profile.state.data}
            policy={policy.state.status === 'ready' ? policy.state.data : undefined}
            models={models.state.status === 'ready' ? models.state.data.items : []}
            skills={skills.state.status === 'ready' ? skills.state.data.items : []}
            gatekeepers={gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : []}
            workerDefinitions={
              workerDefinitions.state.status === 'ready' ? workerDefinitions.state.data.items : []
            }
            editForbidden={editForbidden}
            onSaved={handleSaved}
          />
        </>
      )}
    </div>
  );
}

function EffectivePanel({ profile }: { readonly profile: AgentProfile }) {
  const effective = profile.effective;
  return (
    <section
      className="section"
      aria-labelledby="agent-effective-title"
      data-testid="agent-profile-effective"
    >
      <div className="section-header">
        <h2 id="agent-effective-title">当前生效 Currently effective</h2>
      </div>
      <dl className="definition-list">
        <dt>模型 Model</dt>
        <dd className="mono">{effective.model}</dd>
        <dt>Skills</dt>
        <dd>{effective.enabledSkills.length > 0 ? effective.enabledSkills.join(', ') : '—'}</dd>
        <dt>系统接入 Systems</dt>
        <dd>
          {effective.enabledGatekeepers.length > 0 ? effective.enabledGatekeepers.join(', ') : '—'}
        </dd>
        <dt>Worker 定义</dt>
        <dd>
          {effective.enabledWorkerDefinitions.length > 0
            ? effective.enabledWorkerDefinitions.join(', ')
            : '—'}
        </dd>
        <dt>提示词附加</dt>
        <dd>{effective.promptAddendum.length > 0 ? effective.promptAddendum : '—'}</dd>
        <dt>自动批准低风险</dt>
        <dd>{effective.autoApproveLow ? '是 Yes' : '否 No'}</dd>
      </dl>
    </section>
  );
}
