import type {
  SkillFailureGroupWire,
  SkillStatsSegmentWire,
  SkillStatsWire,
  SkillVersionStatsWire,
} from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { taskFailureCategoryLabel, taskRefusalLabel } from '../../lib/labels.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue } from '../kit/key-value.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { EnvironmentLabel, ReviewSuggestedChip, runNumbers, versionList } from './usage-common.js';

/**
 * components/catalog/SkillUsage (S11 W1a E2-1): 「使用情况」 on a Skill's detail — how each version
 * of the family has done, from `get_skill_stats` (counted when read; every rule is in
 * `@nexttime/shared` `wire/skill-stats.ts`). Numbers only (coordinator decision 2026-10-29, fork
 * 7 = a): the counts span every conversation and goal in the workspace, so nothing here links to a
 * Turn, Task or goal. Shown to builders and up (`can('get_skill_stats')`, the read held on it);
 * nothing for anyone else, or on a 403.
 *
 *   - one block per version that has been loaded: runs, Task results, the attainment rate with its
 *     sample size, proxy outcomes apart, last used, 「建议复核」;
 *   - under it, the same numbers per run environment (unknown is its own segment), the review
 *     suggestion on the segment it comes from;
 *   - failed Tasks grouped by Skill version × WorkerDefinition version × failure category × what
 *     refused them.
 */
export function SkillUsageSection({
  http,
  skillId,
}: {
  readonly http: CapabilityCaller;
  readonly skillId: string;
}) {
  const t = useT();
  const can = useRoleCan(http);
  // Builders and up (fork 7 = a): a member's detail has no such section, and asks for nothing.
  const allowed = can('get_skill_stats') === true;
  const stats = useCapability<SkillStatsWire | null>(
    http,
    'get_skill_stats',
    { skillId },
    { enabled: allowed },
  );
  const state = stats.state;
  if (!allowed || (state.status === 'error' && isForbiddenError(state.error))) return null;

  return (
    <div className="stack-s" data-testid="skill-usage">
      <span className="section-title">{t('使用情况', 'Usage')}</span>
      {state.status === 'loading' ? (
        <SkeletonRows count={2} label="Loading usage" testId="skill-usage-loading" />
      ) : state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取使用情况', 'Could not read usage')}
          onRetry={() => void stats.reload()}
          testId="skill-usage-error"
        />
      ) : state.data === null ? (
        <span className="text-3">—</span>
      ) : (
        <UsageBody stats={state.data} t={t} />
      )}
    </div>
  );
}

function UsageBody({ stats, t }: { readonly stats: SkillStatsWire; readonly t: Translate }) {
  const loaded = stats.versions.filter((version) => version.usage.runs > 0);
  // A draft is never loaded (only a published version is mounted), so it is not listed as unused
  // (UX acceptance of #781, P3-1).
  const neverLoaded = stats.versions.filter(
    (version) => version.usage.runs === 0 && version.status !== 'draft',
  );
  if (loaded.length === 0) {
    return (
      <span className="text-3" data-testid="skill-usage-empty">
        {t(
          '还没有运行加载过这个 Skill 的任何版本。',
          'No run has loaded any version of this Skill yet.',
        )}
      </span>
    );
  }
  return (
    <div className="stack">
      <span className="text-3 text-small" data-testid="skill-usage-attribution">
        {t(
          '统计整个工作区。达成率是联合归因：记的是 Task 所在的对话轮、目标步骤或目标被判达成，不是这个 Skill 让它达成；只算请求人确认和平台验收检查。',
          'Counted across the workspace. Attainment is joint: it records that the conversation turn, goal step or goal a Task ran in was judged achieved, not that this Skill achieved it; only the requester’s word and the platform’s checks count.',
        )}
      </span>
      {loaded.map((version) => (
        <VersionBlock
          key={version.version}
          version={version}
          reviewStreak={stats.reviewStreak}
          t={t}
        />
      ))}
      {neverLoaded.length > 0 ? (
        <span className="text-3 text-small" data-testid="skill-usage-never-loaded">
          {t(
            `${versionList(neverLoaded, t)} 还没有被运行加载过。`,
            `${versionList(neverLoaded, t)}: not loaded by any run yet.`,
          )}
        </span>
      ) : null}
      <FailureGroups groups={stats.failureGroups} t={t} />
    </div>
  );
}

function ReviewSuggested({
  reviewStreak,
  t,
  testId,
}: {
  readonly reviewStreak: number;
  readonly t: Translate;
  readonly testId: string;
}) {
  return (
    <ReviewSuggestedChip
      title={t(
        `同一运行环境下最近 ${reviewStreak} 个结果都未达成`,
        `The latest ${reviewStreak} outcomes in one run environment were all not achieved`,
      )}
      t={t}
      testId={testId}
    />
  );
}

function VersionBlock({
  version,
  reviewStreak,
  t,
}: {
  readonly version: SkillVersionStatsWire;
  readonly reviewStreak: number;
  readonly t: Translate;
}) {
  const testId = `skill-usage-version-${version.version}`;
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        <StatusChip machine="publishable" status={version.status} size="s" />
        <strong>v{version.version}</strong>
        {version.reviewSuggested ? (
          <ReviewSuggested reviewStreak={reviewStreak} t={t} testId={`${testId}-review`} />
        ) : null}
      </div>
      <KeyValue
        items={runNumbers(version.usage, version.outcomes, t, 'skill-usage')}
        testId={`${testId}-numbers`}
      />
      {version.segments.length > 0 ? (
        <details className="disclosure" data-testid={`${testId}-segments`}>
          <summary>
            {t(
              `按运行环境（${version.segments.length} 段）`,
              `By run environment (${version.segments.length})`,
            )}
          </summary>
          <div className="disclosure-body stack">
            {version.segments.map((segment) => (
              <SegmentBlock
                key={segment.environmentDigest ?? 'unknown'}
                segment={segment}
                reviewStreak={reviewStreak}
                t={t}
                testId={`${testId}-segment-${segment.environmentDigest ?? 'unknown'}`}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SegmentBlock({
  segment,
  reviewStreak,
  t,
  testId,
}: {
  readonly segment: SkillStatsSegmentWire;
  readonly reviewStreak: number;
  readonly t: Translate;
  readonly testId: string;
}) {
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        <EnvironmentLabel digest={segment.environmentDigest} t={t} />
        {segment.reviewSuggested ? (
          <ReviewSuggested reviewStreak={reviewStreak} t={t} testId={`${testId}-review`} />
        ) : null}
      </div>
      <KeyValue items={runNumbers(segment.usage, segment.outcomes, t, 'skill-usage')} />
    </div>
  );
}

function FailureGroups({
  groups,
  t,
}: {
  readonly groups: readonly SkillFailureGroupWire[];
  readonly t: Translate;
}) {
  return (
    <div className="stack-s" data-testid="skill-usage-failures">
      <span className="text-small">
        <strong>{t('失败分组', 'Failure groups')}</strong>
      </span>
      {groups.length === 0 ? (
        <span className="text-3 text-small">{t('没有失败的 Task。', 'No failed Tasks.')}</span>
      ) : (
        <ul className="stack-s">
          {groups.map((group) => {
            const worker = group.workerDefinition;
            const workerName = worker.name ?? t('未命名的定义', 'Unnamed definition');
            return (
              <li
                key={`${group.skillVersion}:${worker.id}:${worker.version}:${group.category}:${group.refusal}`}
                className="stack-s"
                data-testid="skill-usage-failure-group"
              >
                <span>
                  {t(
                    `v${group.skillVersion} · Worker ${workerName} v${worker.version} · ${group.tasks} 个 Task · 最近 ${formatRelative(group.lastFailedAt)}`,
                    `v${group.skillVersion} · Worker ${workerName} v${worker.version} · ${group.tasks} Task(s) · last ${formatRelative(group.lastFailedAt)}`,
                  )}
                </span>
                <span className="text-3 text-small">
                  {taskFailureCategoryLabel(group.category, t)} ·{' '}
                  {taskRefusalLabel(group.refusal, t)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
