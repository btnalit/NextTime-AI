import { useCapabilityList } from '../hooks/useCapability.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError, isNotFoundError } from '../lib/errors.js';
import type { ModelRow } from '../lib/governance.js';
import { ModelsTable } from './ModelsTable.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';

export interface AgentProfilePageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/AgentProfilePage: 我的智能体 My Agent (`/me/agent`) — the S3.14 task's explicit
 * placeholder for S3.13 (AgentProfile: per-user model/Skill/Gatekeeper selection, prompt
 * addendum). None of AgentProfile's own capabilities (`get_agent_profile`/`set_agent_profile`/
 * `get_agent_policy`) exist yet — S3.13 has not landed — so this page shows only what S3.11
 * already provides read access to: the workspace's model allow-list (`list_models`), read-only,
 * as a preview of the "model" field the future editor will offer a dropdown over. Every member can
 * open this route (S3.11 background note: "member 只见工作区 + 「我的智能体」").
 */
export function AgentProfilePage({ http }: AgentProfilePageProps) {
  const models = useCapabilityList<ModelRow>(http, 'list_models');

  return (
    <div className="page">
      <PageHeader
        title="我的智能体 My Agent"
        description="Per-user Agent configuration — model, Skills, connected systems, prompt addendum."
      />

      <Notice testId="agent-profile-placeholder">
        This page is a placeholder for S3.13 (AgentProfile). Once it ships, you will be able to pick
        your own model (from the allow-list below), enabled Skills, and which systems your agent can
        see — always a subset of what you already have Grants for, never wider.
      </Notice>

      <section className="section" aria-labelledby="agent-models-title">
        <div className="section-header">
          <h2 id="agent-models-title">可选模型 Allowed models</h2>
        </div>
        {models.state.status === 'loading' ? (
          <SkeletonRows count={3} label="Loading models" testId="agent-models-loading" />
        ) : models.state.status === 'error' ? (
          isNotFoundError(models.state.error) ? (
            <EmptyState
              icon="cpu"
              title="该能力尚未上线 Not live yet"
              body="list_models is part of S3.11, still landing on the kernel side."
              testId="agent-models-unavailable"
            />
          ) : isForbiddenError(models.state.error) ? (
            <EmptyState icon="shield" title="需要成员权限" testId="agent-models-forbidden" />
          ) : (
            <ErrorBanner
              error={models.state.error}
              title="Could not load models"
              onRetry={() => void models.reload()}
              testId="agent-models-error"
            />
          )
        ) : (
          <ModelsTable models={models.state.data.items} />
        )}
      </section>
    </div>
  );
}
