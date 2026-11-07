import type {
  WorkerDefinitionCombinationWire,
  WorkerDefinitionFailureGroupWire,
  WorkerDefinitionSegmentWire,
  WorkerDefinitionStatsWire,
  WorkerDefinitionVersionStatsWire,
} from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatRelative } from '../../lib/format.js';
import { workerSpecFieldLabel } from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { taskFailureCategoryLabel, taskRefusalLabel } from '../../lib/labels.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue } from '../kit/key-value.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { EnvironmentLabel, ReviewSuggestedChip, runNumbers, versionList } from './usage-common.js';

/**
 * components/catalog/WorkerDefinitionUsage (S11 GO16a, legacy 569): 「使用情况」 on a Worker's
 * detail — how each published or deprecated version of the family has done, from
 * `get_worker_definition_stats` (counted when read; every rule is in `@nexttime/shared`
 * `wire/worker-definition-stats.ts`). Numbers only, builders and up, as the Skill's
 * (`SkillUsage.tsx`): nothing here links to a Turn, Task or goal, and a step's adjustments are
 * named by which fields they set, never by what they say. Nothing for anyone else, or on a 403.
 *
 *   - one block per version some Task used: runs, Task results, the attainment rate with its
 *     sample size, proxy outcomes apart, last used, 「建议复核」;
 *   - under it, the same numbers per run environment, and per combination — the Worker as defined,
 *     or with one goal step's adjustments, named by the fields they set and a number (`specRef`:
 *     the same number is the same adjustments, whichever goal they came from; a number that is no
 *     fingerprint is the page's own, for adjustments that ran only in goals the reader cannot
 *     see) — with a note that the two cut the same Tasks, so they are not added;
 *   - failed Tasks grouped by version × combination × failure category × what refused them.
 */
export function WorkerDefinitionUsageSection({
  http,
  definitionId,
}: {
  readonly http: CapabilityCaller;
  readonly definitionId: string;
}) {
  const t = useT();
  const can = useRoleCan(http);
  // Builders and up: a member's detail has no such section, and asks for nothing.
  const allowed = can('get_worker_definition_stats') === true;
  const stats = useCapability<WorkerDefinitionStatsWire | null>(
    http,
    'get_worker_definition_stats',
    { definitionId },
    { enabled: allowed },
  );
  const state = stats.state;
  if (!allowed || (state.status === 'error' && isForbiddenError(state.error))) return null;

  return (
    <div className="stack-s" data-testid="worker-usage">
      <span className="section-title">{t('使用情况', 'Usage')}</span>
      {state.status === 'loading' ? (
        <SkeletonRows count={2} label="Loading usage" testId="worker-usage-loading" />
      ) : state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取使用情况', 'Could not read usage')}
          onRetry={() => void stats.reload()}
          testId="worker-usage-error"
        />
      ) : state.data === null ? (
        <span className="text-3">—</span>
      ) : (
        <UsageBody stats={state.data} t={t} />
      )}
    </div>
  );
}

const taskCount = (version: WorkerDefinitionVersionStatsWire) => {
  const { completed, failed, cancelled, inProgress } = version.usage.tasks;
  return completed + failed + cancelled + inProgress;
};

function UsageBody({
  stats,
  t,
}: {
  readonly stats: WorkerDefinitionStatsWire;
  readonly t: Translate;
}) {
  const used = stats.versions.filter((version) => taskCount(version) > 0);
  const unused = stats.versions.filter((version) => taskCount(version) === 0);
  if (used.length === 0) {
    return (
      <span className="text-3" data-testid="worker-usage-empty">
        {t(
          '这个 Worker 的任何版本都还没有接过 Task（评测和规划的 Task 不算）。',
          'No version of this Worker has taken a Task yet (evaluation and planning Tasks are not counted).',
        )}
      </span>
    );
  }
  return (
    <div className="stack">
      <span className="text-3 text-small" data-testid="worker-usage-attribution">
        {t(
          '统计整个工作区的 Task，评测和规划的不算。达成率是联合归因：记的是 Task 所在的对话轮、目标步骤或目标被判达成，不是这个 Worker 让它达成；只算请求人确认和平台验收检查。',
          'Counted over the workspace’s Tasks, evaluation and planning ones aside. Attainment is joint: it records that the conversation turn, goal step or goal a Task ran in was judged achieved, not that this Worker achieved it; only the requester’s word and the platform’s checks count.',
        )}
      </span>
      {used.map((version) => (
        <VersionBlock
          key={version.version}
          version={version}
          reviewStreak={stats.reviewStreak}
          t={t}
        />
      ))}
      {unused.length > 0 ? (
        <span className="text-3 text-small" data-testid="worker-usage-unused">
          {t(
            `${versionList(unused, t)} 还没有接过 Task。`,
            `${versionList(unused, t)}: no Task yet.`,
          )}
        </span>
      ) : null}
      <FailureGroups groups={stats.failureGroups} t={t} />
    </div>
  );
}

function VersionBlock({
  version,
  reviewStreak,
  t,
}: {
  readonly version: WorkerDefinitionVersionStatsWire;
  readonly reviewStreak: number;
  readonly t: Translate;
}) {
  const testId = `worker-usage-version-${version.version}`;
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        <StatusChip machine="publishable" status={version.status} size="s" />
        <strong>v{version.version}</strong>
        {version.reviewSuggested ? (
          <ReviewSuggestedChip
            title={t(
              `某个运行环境或组合下最近 ${reviewStreak} 个结果都未达成，展开下面两组看是哪一个`,
              `The latest ${reviewStreak} outcomes of one run environment or combination were all not achieved; open the two lists below to see which`,
            )}
            t={t}
            testId={`${testId}-review`}
          />
        ) : null}
      </div>
      <KeyValue
        items={runNumbers(version.usage, version.outcomes, t, 'worker-usage')}
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
      {version.combinations.length > 0 ? (
        <details className="disclosure" data-testid={`${testId}-combinations`}>
          <summary>
            {t(
              `按组合（${version.combinations.length} 种）`,
              `By combination (${version.combinations.length})`,
            )}
          </summary>
          <div className="disclosure-body stack">
            <span className="text-3 text-small" data-testid={`${testId}-combinations-note`}>
              {t(
                '组合是这个 Worker 原样跑，或带着某个目标步骤的调整跑。按运行环境和按组合是同一批 Task 的两种分法，数字不要相加。',
                'A combination is this Worker as defined, or with one goal step’s adjustments. By run environment and by combination split the same Tasks two ways: do not add them up.',
              )}
            </span>
            {version.combinations.map((combination) => (
              <CombinationBlock
                key={combination.specRef ?? 'as-defined'}
                combination={combination}
                reviewStreak={reviewStreak}
                t={t}
                testId={`${testId}-combination-${combination.specRef ?? 'as-defined'}`}
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
  readonly segment: WorkerDefinitionSegmentWire;
  readonly reviewStreak: number;
  readonly t: Translate;
  readonly testId: string;
}) {
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        <EnvironmentLabel digest={segment.environmentDigest} t={t} />
        {segment.reviewSuggested ? (
          <ReviewSuggestedChip
            title={t(
              `这个运行环境下最近 ${reviewStreak} 个结果都未达成`,
              `The latest ${reviewStreak} outcomes in this run environment were all not achieved`,
            )}
            t={t}
            testId={`${testId}-review`}
          />
        ) : null}
      </div>
      <KeyValue items={runNumbers(segment.usage, segment.outcomes, t, 'worker-usage')} />
    </div>
  );
}

type CombinationNaming = Pick<WorkerDefinitionCombinationWire, 'specRef' | 'specDigest' | 'fields'>;

/** What a combination is, in words: as defined, or the fields its step adjustments set, then
 *  their number (UX on #1064: the fields first; the number only tells adjustments apart). */
function combinationLabel(combination: CombinationNaming, t: Translate): string {
  if (combination.specRef === null)
    return t('原样（没有步骤调整）', 'As defined (no step adjustments)');
  const ref = combination.specRef;
  if (combination.fields === null) {
    return t(
      `步骤调整（调整了什么读不到） · 编号 ${ref}`,
      `Step adjustments (what they set cannot be read) · ref ${ref}`,
    );
  }
  const fields = combination.fields.map((field) => workerSpecFieldLabel(field, t));
  return t(`调整了${fields.join('、')} · 编号 ${ref}`, `Sets ${fields.join(', ')} · ref ${ref}`);
}

function combinationTitle(combination: CombinationNaming, t: Translate): string {
  if (combination.specRef === null) {
    return t(
      '不是目标步骤的 Task，或所在步骤没有对 Worker 做调整',
      'Tasks that are no goal step’s, or whose step adjusts nothing of the Worker',
    );
  }
  const lines = [
    t(
      '编号只用来区分不同的调整：编号相同就是同一份调整，不论来自哪个目标。',
      'The ref only tells adjustments apart: the same ref is the same adjustments, whichever goal they came from.',
    ),
  ];
  if (combination.specDigest === null) {
    lines.push(
      t(
        '这份调整只用在你看不到的目标里，所以编号只在这一页有效。',
        'These adjustments ran only in goals you cannot see, so the ref holds on this page only.',
      ),
    );
  }
  if (combination.fields === null) {
    lines.push(
      t(
        '这份调整所在的计划条目已读不出同一份内容，平台不猜它调整了什么。',
        'The plan entry these adjustments came from no longer reads as them, so the platform does not guess what they set.',
      ),
    );
  }
  return lines.join('\n');
}

function CombinationBlock({
  combination,
  reviewStreak,
  t,
  testId,
}: {
  readonly combination: WorkerDefinitionCombinationWire;
  readonly reviewStreak: number;
  readonly t: Translate;
  readonly testId: string;
}) {
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        <span
          className={combination.specRef === null ? undefined : 'wrap-anywhere'}
          title={combinationTitle(combination, t)}
          data-testid={`${testId}-label`}
        >
          {combinationLabel(combination, t)}
        </span>
        {combination.reviewSuggested ? (
          <ReviewSuggestedChip
            title={t(
              `这个组合最近 ${reviewStreak} 个结果都未达成`,
              `The latest ${reviewStreak} outcomes of this combination were all not achieved`,
            )}
            t={t}
            testId={`${testId}-review`}
          />
        ) : null}
      </div>
      <KeyValue items={runNumbers(combination.usage, combination.outcomes, t, 'worker-usage')} />
    </div>
  );
}

function FailureGroups({
  groups,
  t,
}: {
  readonly groups: readonly WorkerDefinitionFailureGroupWire[];
  readonly t: Translate;
}) {
  return (
    <div className="stack-s" data-testid="worker-usage-failures">
      <span className="text-small">
        <strong>{t('失败分组', 'Failure groups')}</strong>
      </span>
      {groups.length === 0 ? (
        <span className="text-3 text-small">{t('没有失败的 Task。', 'No failed Tasks.')}</span>
      ) : (
        <ul className="stack-s">
          {groups.map((group) => {
            // By its number only: what it sets is on the version's combination list above.
            const combination =
              group.specRef === null
                ? t('原样', 'As defined')
                : t(`步骤调整（编号 ${group.specRef}）`, `Step adjustments (ref ${group.specRef})`);
            return (
              <li
                key={`${group.definitionVersion}:${group.specRef ?? ''}:${group.category}:${group.refusal}`}
                className="stack-s"
                data-testid="worker-usage-failure-group"
              >
                <span className="wrap-anywhere">
                  {t(
                    `v${group.definitionVersion} · ${combination} · ${group.tasks} 个 Task · 最近 ${formatRelative(group.lastFailedAt)}`,
                    `v${group.definitionVersion} · ${combination} · ${group.tasks} Task(s) · last ${formatRelative(group.lastFailedAt)}`,
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
