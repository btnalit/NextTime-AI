import { useState } from 'react';
import { invalidateCapability, useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { AgentPolicy, AgentProfile } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import type { GatekeeperListRow, ModelRow, PrincipalRow, SkillRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { hrefs } from '../lib/router.js';
import type { WorkerDefinitionSummary } from '../lib/tasks.js';
import { AgentProfileForm } from './AgentProfileForm.js';
import { nameOf } from './approvals/useDirectoryNames.js';
import { PageHeader } from './kit/page-header.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { RefChip, useRefNames } from './ui/RefChip.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { useToast } from './ui/Toast.js';

export interface AgentProfilePageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/AgentProfilePage: 我的智能体 My Agent (`/me/agent`, S3.13) — per-user model, Skills,
 * connected systems, Worker definitions, prompt addendum, and low-risk auto-approve, all a
 * subset-only projection of the caller's own Grants and the workspace's AgentPolicy (never wider —
 * §S3.13 "Profile 是 Grant 的子集投影，永不扩权"). `get_agent_profile` / `set_agent_profile` /
 * `get_agent_policy` shipped with the S3.13 kernel half; B6 (console-completion-plan §2) removed
 * the "该能力尚未上线" branches this page carried through the parallel rollout, so a `not_found`
 * renders as an ordinary error banner (for the owner's principal picker it genuinely means "no
 * such principal").
 *
 * An owner may switch the target principal via a dropdown seeded from `list_principals`.
 *
 * S8 W1-C (#243) made `list_skills` / `list_worker_definitions` / `list_principals` keyset-
 * paginated. Every one of them backs a checklist or a picker on this page (never a browsable list
 * of its own) — `{ autoLoadAll: true }` walks every page up front so a workspace with more than
 * the default 100 rows still offers all of them, instead of a checklist silently missing some.
 */
export function AgentProfilePage({ http }: AgentProfilePageProps) {
  const t = useT();
  const toast = useToast();
  const { role } = useWorkspaceIdentity(http);
  const [selectedPrincipalId, setSelectedPrincipalId] = useState<string | undefined>(undefined);

  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const skills = useCapabilityList<SkillRow>(http, 'list_skills', {}, { autoLoadAll: true });
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const workerDefinitions = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    {},
    { autoLoadAll: true },
  );
  const principals = useCapabilityList<PrincipalRow>(
    http,
    'list_principals',
    {},
    { autoLoadAll: true },
  );
  const policy = useCapability<AgentPolicy>(http, 'get_agent_policy');
  const profile = useCapability<AgentProfile>(
    http,
    'get_agent_profile',
    selectedPrincipalId ? { principalId: selectedPrincipalId } : undefined,
  );

  // B3 (§5.8 "id → 名称"): the effective panel's ids resolve against the lists this page already
  // loads for the form — the same rows, no extra read.
  const skillNames = useRefNames(skills.state.status === 'ready' ? skills.state.data : undefined);
  const gatekeeperNames = useRefNames(
    gatekeepers.state.status === 'ready' ? gatekeepers.state.data : undefined,
  );
  const workerDefinitionNames = useRefNames(
    workerDefinitions.state.status === 'ready' ? workerDefinitions.state.data : undefined,
  );

  const canPickPrincipal = principals.state.status === 'ready';
  const humanPrincipals =
    principals.state.status === 'ready'
      ? principals.state.data.items.filter((p) => p.kind === 'human')
      : [];

  function handleSaved(saved: AgentProfile): void {
    invalidateCapability(http, 'get_agent_profile');
    profile.mutate(() => saved);
    toast.push({ tone: 'ok', title: t('已保存', 'Saved') });
  }

  const editForbidden =
    selectedPrincipalId === undefined &&
    policy.state.status === 'ready' &&
    !policy.state.data.memberCanEditProfile &&
    role.role !== 'owner';

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('agent')}
        title={t('我的智能体', 'My Agent')}
        description={t(
          '每个用户各自的 Agent 配置——模型、Skill、已接入系统、提示词附加。',
          'Per-user Agent configuration — model, Skills, connected systems, prompt addendum.',
        )}
        actions={
          canPickPrincipal && humanPrincipals.length > 1 ? (
            <Field id="ap-principal" label={t('查看/编辑', 'View / edit')}>
              <Select
                id="ap-principal"
                value={selectedPrincipalId ?? ''}
                onChange={(event) => setSelectedPrincipalId(event.target.value || undefined)}
              >
                <option value="">{t('我自己', 'Myself')}</option>
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
        <SkeletonRows
          count={4}
          label={t('正在加载 Agent profile…', 'Loading Agent profile')}
          testId="agent-profile-loading"
        />
      ) : profile.state.status === 'error' ? (
        isForbiddenError(profile.state.error) ? (
          <EmptyState
            icon="shield"
            title="无权查看该智能体配置"
            body="get_agent_profile: member 只能看自己，owner 可看任何人。"
            testId="agent-profile-forbidden"
          />
        ) : (
          <ErrorBanner
            error={profile.state.error}
            title={t('无法加载该 Agent profile', 'Could not load this Agent profile')}
            onRetry={() => void profile.reload()}
            testId="agent-profile-error"
          />
        )
      ) : (
        <>
          {policy.state.status === 'error' ? (
            <Notice tone="warn" testId="agent-policy-load-warning">
              {t(
                '无法加载工作区 AgentPolicy —— 下面的选项按未收窄显示。',
                'Could not load workspace AgentPolicy — options below are shown unnarrowed.',
              )}
            </Notice>
          ) : null}

          <EffectivePanel
            profile={profile.state.data}
            skillNames={skillNames}
            gatekeeperNames={gatekeeperNames}
            workerDefinitionNames={workerDefinitionNames}
          />

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

function EffectivePanel({
  profile,
  skillNames,
  gatekeeperNames,
  workerDefinitionNames,
}: {
  readonly profile: AgentProfile;
  readonly skillNames: ReadonlyMap<string, string>;
  readonly gatekeeperNames: ReadonlyMap<string, string>;
  readonly workerDefinitionNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const effective = profile.effective;
  return (
    <section
      className="section"
      aria-labelledby="agent-effective-title"
      data-testid="agent-profile-effective"
    >
      <div className="section-header">
        <h2 id="agent-effective-title">{t('当前生效', 'Currently effective')}</h2>
      </div>
      <dl className="definition-list">
        <dt>{t('模型', 'Model')}</dt>
        <dd className="mono">{effective.model}</dd>
        <dt>Skills</dt>
        <dd className="row-wrap">
          {effective.enabledSkills.length > 0
            ? effective.enabledSkills.map((id) => (
                <RefChip
                  key={id}
                  kind="object"
                  id={id}
                  name={nameOf(skillNames, id)}
                  href={hrefs.catalog('skills')}
                  size="s"
                />
              ))
            : '—'}
        </dd>
        <dt>{t('系统接入', 'Systems')}</dt>
        <dd className="row-wrap">
          {effective.enabledGatekeepers.length > 0
            ? effective.enabledGatekeepers.map((id) => (
                <RefChip
                  key={id}
                  kind="gatekeeper"
                  id={id}
                  name={nameOf(gatekeeperNames, id)}
                  href={hrefs.gatekeeper(id)}
                  size="s"
                />
              ))
            : '—'}
        </dd>
        <dt>{t('Worker 定义', 'Worker definitions')}</dt>
        <dd className="row-wrap">
          {effective.enabledWorkerDefinitions.length > 0
            ? effective.enabledWorkerDefinitions.map((id) => (
                <RefChip
                  key={id}
                  kind="workerDefinition"
                  id={id}
                  name={nameOf(workerDefinitionNames, id)}
                  href={hrefs.catalog('workers')}
                  size="s"
                />
              ))
            : '—'}
        </dd>
        <dt>{t('提示词附加', 'Prompt addendum')}</dt>
        <dd className="pre-wrap">
          {effective.promptAddendum.length > 0 ? effective.promptAddendum : '—'}
        </dd>
        <dt>{t('自动批准低风险', 'Auto-approve low risk')}</dt>
        <dd>{effective.autoApproveLow ? t('是', 'Yes') : t('否', 'No')}</dd>
      </dl>
    </section>
  );
}
