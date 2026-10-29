import type {
  OutcomeTallyWire,
  SkillFailureGroupWire,
  SkillStatsSegmentWire,
  SkillStatsWire,
  SkillUsageWire,
  SkillVersionStatsWire,
} from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatRelative, shortDigest } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { taskFailureCategoryLabel, taskRefusalLabel } from '../../lib/labels.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { AttainmentValue, versionList } from './usage-common.js';

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
    <span
      className="chip chip-warn chip-s"
      title={t(
        `同一运行环境下最近 ${reviewStreak} 个结果都未达成`,
        `The latest ${reviewStreak} outcomes in one run environment were all not achieved`,
      )}
      data-testid={testId}
    >
      {t('建议复核', 'Review suggested')}
    </span>
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
        items={numbersOf(version.usage, version.outcomes, t)}
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
  const digest = segment.environmentDigest;
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        {digest !== null ? (
          <span
            className="mono"
            title={t(
              `${digest}\n指纹相同的运行，定义版本、模型、镜像、平台版本和系统提示都相同。`,
              `${digest}\nRuns with the same fingerprint ran the same definition version, model, image, platform version and system prompt.`,
            )}
          >
            {t(`环境 ${shortDigest(digest)}`, `Environment ${shortDigest(digest)}`)}
          </span>
        ) : (
          <span
            title={t(
              '运行时没有上报，或用了默认模型、平台没读到模型配置',
              'The runtime reported nothing, or the run used the default model and the platform could not read its model configuration',
            )}
          >
            {t('环境未知', 'Environment unknown')}
          </span>
        )}
        {segment.reviewSuggested ? (
          <ReviewSuggested reviewStreak={reviewStreak} t={t} testId={`${testId}-review`} />
        ) : null}
      </div>
      <KeyValue items={numbersOf(segment.usage, segment.outcomes, t)} />
    </div>
  );
}

/** The same rows for a version and for one of its segments. */
function numbersOf(
  usage: SkillUsageWire,
  outcomes: OutcomeTallyWire,
  t: Translate,
): KeyValueItem[] {
  const { completed, failed, cancelled, inProgress } = usage.tasks;
  const { primary, proxy } = outcomes;
  const items: KeyValueItem[] = [
    {
      key: 'runs',
      label: t('运行', 'Runs'),
      value: t(
        `${usage.runs} 次 · 最近 ${formatRelative(usage.lastUsedAt)}`,
        `${usage.runs} · last ${formatRelative(usage.lastUsedAt)}`,
      ),
    },
    {
      key: 'tasks',
      label: 'Task',
      value: t(
        `完成 ${completed} · 失败 ${failed} · 取消 ${cancelled} · 进行中 ${inProgress}`,
        `${completed} completed · ${failed} failed · ${cancelled} cancelled · ${inProgress} in progress`,
      ),
    },
    {
      key: 'attainment',
      label: t('达成率', 'Attainment'),
      value: <AttainmentValue primary={primary} t={t} testId="skill-usage-attainment" />,
    },
  ];
  if (proxy.total > 0) {
    items.push({
      key: 'proxy',
      label: t('代理指标', 'Proxy signals'),
      value: (
        <span className="row-wrap" data-testid="skill-usage-proxy">
          <span>
            {t(
              `达成 ${proxy.achieved} · 未达成 ${proxy.notAchieved}`,
              `${proxy.achieved} achieved · ${proxy.notAchieved} not achieved`,
            )}
          </span>
          <span className="text-3 text-small">
            {t(
              'Agent 自报与独立评审，不计入达成率',
              'Agent reports and independent reviews, not counted toward attainment',
            )}
          </span>
        </span>
      ),
    });
  }
  return items;
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
