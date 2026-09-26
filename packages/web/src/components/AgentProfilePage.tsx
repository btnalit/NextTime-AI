import { useState } from 'react';
import { invalidateCapability, useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { AgentPolicy, AgentProfile } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import type { GatekeeperListRow, ModelRow, PrincipalRow, SkillRow } from '../lib/governance.js';
import { type Translate, useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { hrefs } from '../lib/router.js';
import type { WorkerDefinitionSummary } from '../lib/tasks.js';
import { AgentProfileForm } from './AgentProfileForm.js';
import { EmptyState } from './kit/empty-state.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Field } from './kit/field.js';
import { KeyValue } from './kit/key-value.js';
import { Notice } from './kit/notice.js';
import { PageHeader } from './kit/page-header.js';
import { RefChip } from './kit/ref-chip.js';
import { DashboardCard } from './kit/section.js';
import { Select } from './kit/select.js';
import { SkeletonRows } from './kit/skeleton.js';
// `useToast` stays on `components/ui/Toast` — `App.tsx` mounts that provider (not
// `kit/toast`'s own, separate context), so switching this one import would silently make
// `toast.push(...)` below a no-op. Not this lane's scope (App shell wiring).
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
 *
 * Console redesign P3-3 (V4): two columns at ≥1280px — form sections (`AgentProfileForm`, each its
 * own `DashboardCard`) left, a sticky "当前生效" summary (`EffectivePanel`, also a `DashboardCard`,
 * over `kit/key-value`) right; one column below 1280px (`.agent-profile-layout`,
 * `styles/pages.css`).
 */
export function AgentProfilePage({ http }: AgentProfilePageProps) {
  const t = useT();
  const toast = useToast();
  const { role } = useWorkspaceIdentity(http);
  const [selectedPrincipalId, setSelectedPrincipalId] = useState<string | undefined>(undefined);

  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const skills = useCapabilityList<SkillRow>(http, 'list_skills', {}, { autoLoadAll: true });
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  // S8 W4 (audit M1 "把入口定义当 Worker 展示"): `kind: 'worker'` excludes the workspace's own
  // `kind: 'entry'` definition — `enabledWorkerDefinitions` narrows which Workers a principal may
  // `invoke_worker`, never the entry definition itself, and an entry row typically has no
  // `definition.name` (it is not authored through the catalog's name field), so an unfiltered read
  // showed it in this checklist as a bare, unlabelled id.
  const workerDefinitions = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    { kind: 'worker' },
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
  // loads for the form — the same rows, no extra read (a `kit/ref-chip` self-resolve would add a
  // `resolve_refs` round trip for data already in hand).
  const skillNames = nameMap(
    skills.state.status === 'ready' ? skills.state.data.items : undefined,
    (s) => s.name,
  );
  const gatekeeperNames = nameMap(
    gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : undefined,
    (g) => g.name,
  );
  const workerDefinitionNames = nameMap(
    workerDefinitions.state.status === 'ready' ? workerDefinitions.state.data.items : undefined,
    (w) => {
      const name = w.definition.name;
      return typeof name === 'string' ? name : undefined;
    },
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
                aria-label={t('查看/编辑', 'View / edit')}
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

          {/* Console redesign P3-3 (V4): two columns at ≥1280px — form sections left, a sticky
           *  "当前生效" summary right; one column below 1280 (`.agent-profile-layout`,
           *  `styles/pages.css`). */}
          <div className="agent-profile-layout">
            <div className="agent-profile-main stack">
              <AgentProfileForm
                key={profile.state.data.principalId}
                http={http}
                principalId={profile.state.data.principalId}
                profile={profile.state.data}
                policy={policy.state.status === 'ready' ? policy.state.data : undefined}
                models={models.state.status === 'ready' ? models.state.data.items : []}
                skills={skills.state.status === 'ready' ? skills.state.data.items : []}
                gatekeepers={
                  gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : []
                }
                workerDefinitions={
                  workerDefinitions.state.status === 'ready'
                    ? workerDefinitions.state.data.items
                    : []
                }
                editForbidden={editForbidden}
                onSaved={handleSaved}
              />
            </div>
            <aside className="agent-profile-summary">
              <EffectivePanel
                profile={profile.state.data}
                skillNames={skillNames}
                gatekeeperNames={gatekeeperNames}
                workerDefinitionNames={workerDefinitionNames}
              />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

/** Builds an id → name `Map` from a list this page already loaded (`list_skills` /
 *  `list_gatekeepers` / `list_worker_definitions`) — a plain lookup, not a `resolve_refs` self-
 *  resolve (`kit/ref-chip`'s own `http` prop), since the names are already in hand. Not memoized:
 *  these lists are workspace-scoped and small, and the caller (`pick`) is a fresh closure every
 *  render anyway. */
function nameMap<T extends { readonly id: string }>(
  items: readonly T[] | undefined,
  pick: (row: T) => string | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const row of items ?? []) {
    const name = pick(row);
    if (name !== undefined && !map.has(row.id)) map.set(row.id, name);
  }
  return map;
}

/** Console redesign P3-3 (V4): an empty ref list reads "跟随授权" (this field tracks grants /
 *  publications automatically — §S3.13, `AgentProfileForm`'s own doc comment — there is simply
 *  nothing granted or published yet), never a bare "—". */
function EffectiveRefs({
  ids,
  kind,
  names,
  href,
}: {
  readonly ids: readonly string[];
  readonly kind: 'object' | 'gatekeeper' | 'workerDefinition';
  readonly names: ReadonlyMap<string, string>;
  readonly href: (id: string) => string;
}) {
  const t = useT();
  if (ids.length === 0) {
    return (
      <span className="text-3 text-small">
        {t('跟随授权，当前没有', 'Follows your grants — none right now')}
      </span>
    );
  }
  return (
    <span className="row-wrap">
      {ids.map((id) => (
        <RefChip
          key={id}
          kind={kind}
          id={id}
          name={names.get(id) ?? null}
          href={href(id)}
          size="s"
        />
      ))}
    </span>
  );
}

/** Console redesign P3-3 bugfix (main-session review of PR #324): the 模型 row rendered empty
 *  whenever `effective.model` came back falsy (an unset workspace default) — it must always show
 *  *something*, and say whether it is inherited. `profile.model === null` means this principal has
 *  no override (`AgentProfile`'s own doc comment: "缺省 = 继承 AgentPolicy 默认"). */
function effectiveModelText(profile: AgentProfile, t: Translate): string {
  const { model: override, effective } = profile;
  if (override !== null) return effective.model || override;
  return effective.model
    ? t(`继承工作区默认 · ${effective.model}`, `Inherits workspace default · ${effective.model}`)
    : t(
        '继承工作区默认（工作区未设置默认模型）',
        'Inherits workspace default (no workspace default model set)',
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
    <DashboardCard
      title={t('当前生效', 'Currently effective')}
      data-testid="agent-profile-effective"
    >
      <KeyValue
        items={[
          {
            key: 'model',
            label: t('模型', 'Model'),
            value: <span className="mono">{effectiveModelText(profile, t)}</span>,
          },
          {
            key: 'skills',
            label: 'Skills',
            value: (
              <EffectiveRefs
                ids={effective.enabledSkills}
                kind="object"
                names={skillNames}
                href={() => hrefs.catalog('skills')}
              />
            ),
          },
          {
            key: 'systems',
            label: t('系统接入', 'Systems'),
            value: (
              <EffectiveRefs
                ids={effective.enabledGatekeepers}
                kind="gatekeeper"
                names={gatekeeperNames}
                href={(id) => hrefs.gatekeeper(id)}
              />
            ),
          },
          {
            key: 'workers',
            label: t('Worker 定义', 'Worker definitions'),
            value: (
              <EffectiveRefs
                ids={effective.enabledWorkerDefinitions}
                kind="workerDefinition"
                names={workerDefinitionNames}
                href={() => hrefs.catalog('workers')}
              />
            ),
          },
          {
            key: 'prompt',
            label: t('提示词附加', 'Prompt addendum'),
            value:
              effective.promptAddendum.length > 0 ? (
                <span className="pre-wrap">{effective.promptAddendum}</span>
              ) : (
                <span className="text-3 text-small">{t('未设置', 'Not set')}</span>
              ),
          },
          {
            key: 'auto-approve',
            label: t('自动批准低风险', 'Auto-approve low risk'),
            value: effective.autoApproveLow ? t('是', 'Yes') : t('否', 'No'),
          },
        ]}
      />
    </DashboardCard>
  );
}
