import type {
  OutcomeTallyWire,
  ProcedureClaimsWire,
  ProcedureFailureGroupWire,
  ProcedureStatsSegmentWire,
  ProcedureStatsWire,
  ProcedureUsageWire,
  ProcedureVersionStatsWire,
} from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatRelative, shortDigest } from '../../lib/format.js';
import { stepFailureText } from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { procedureFailurePlaceLabel } from '../../lib/labels.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { AttainmentValue, versionList } from './usage-common.js';

/**
 * components/catalog/ProcedureUsage (S11 W1a E2-2): 「使用情况」 on a Procedure's detail — how each
 * version of the family has done, from `get_procedure_stats` (counted when read; every rule is in
 * `@nexttime/shared` `wire/procedure-stats.ts`). Numbers only, builders and up, as the Skill's
 * (`SkillUsage.tsx`); nothing for anyone else, or on a 403.
 *
 *   - one block per version that made a goal or that an agent said it followed: the goals by
 *     status, the attainment rate with its sample size, the proxy outcomes apart, the claimed Turns
 *     apart (agent-reported, never in the rate), 「建议复核」 with its reason in words;
 *   - under it, the same numbers per set of run environments, each fingerprint listed;
 *   - the goals not achieved, grouped by where they went wrong × the step's failure category.
 */
export function ProcedureUsageSection({
  http,
  procedureId,
}: {
  readonly http: CapabilityCaller;
  readonly procedureId: string;
}) {
  const t = useT();
  const can = useRoleCan(http);
  // Builders and up: a member's detail has no such section, and asks for nothing.
  const allowed = can('get_procedure_stats') === true;
  const stats = useCapability<ProcedureStatsWire | null>(
    http,
    'get_procedure_stats',
    { procedureId },
    { enabled: allowed },
  );
  const state = stats.state;
  if (!allowed || (state.status === 'error' && isForbiddenError(state.error))) return null;

  return (
    <div className="stack-s" data-testid="procedure-usage">
      <span className="section-title">{t('使用情况', 'Usage')}</span>
      {state.status === 'loading' ? (
        <SkeletonRows count={2} label="Loading usage" testId="procedure-usage-loading" />
      ) : state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取使用情况', 'Could not read usage')}
          onRetry={() => void stats.reload()}
          testId="procedure-usage-error"
        />
      ) : state.data === null ? (
        <span className="text-3">—</span>
      ) : (
        <UsageBody stats={state.data} t={t} />
      )}
    </div>
  );
}

const usedAtAll = (version: ProcedureVersionStatsWire) =>
  version.usage.goals > 0 || version.claims.turns > 0;

function UsageBody({ stats, t }: { readonly stats: ProcedureStatsWire; readonly t: Translate }) {
  const used = stats.versions.filter(usedAtAll);
  // A draft makes no goal (only a published version does), so it is not listed as unused.
  const unused = stats.versions.filter(
    (version) => !usedAtAll(version) && version.status !== 'draft',
  );
  if (used.length === 0) {
    return (
      <span className="text-3" data-testid="procedure-usage-empty">
        {t(
          '还没有用这个流程生成过目标，也没有对话轮自报按它做过。',
          'No goal has been made from this Procedure, and no conversation turn said it followed it.',
        )}
      </span>
    );
  }
  return (
    <div className="stack">
      <span className="text-3 text-small" data-testid="procedure-usage-attribution">
        {t(
          '统计整个工作区。达成率只算由这个流程生成的目标，依据是请求人确认和平台验收检查；记的是目标被判达成，不是这个流程让它达成。agent 自报按这个流程做的对话轮单列，不计入达成率。',
          'Counted across the workspace. Attainment counts only the goals made from this Procedure, by the requester’s word and the platform’s checks; it records that a goal was judged achieved, not that this Procedure achieved it. Conversation turns an agent said followed it are shown apart and not counted toward attainment.',
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
        <span className="text-3 text-small" data-testid="procedure-usage-unused">
          {t(
            `${versionList(unused, t)} 还没有被用过。`,
            `${versionList(unused, t)}: not used yet.`,
          )}
        </span>
      ) : null}
      <FailureGroups groups={stats.failureGroups} t={t} />
    </div>
  );
}

/** 「建议复核」 with its reason in words beside it, not only on hover. */
function ReviewSuggested({
  reviewStreak,
  scope,
  t,
  testId,
}: {
  readonly reviewStreak: number;
  /** `version`: some set of environments suggests it; `segment`: this one does. */
  readonly scope: 'version' | 'segment';
  readonly t: Translate;
  readonly testId: string;
}) {
  return (
    <span className="row-wrap" data-testid={testId}>
      <span className="chip chip-warn chip-s">{t('建议复核', 'Review suggested')}</span>
      <span className="text-3 text-small">
        {scope === 'version'
          ? t(
              `某一组运行环境里最近 ${reviewStreak} 个结果都未达成`,
              `The latest ${reviewStreak} outcomes in one set of run environments were all not achieved`,
            )
          : t(
              `这组运行环境里最近 ${reviewStreak} 个结果都未达成`,
              `The latest ${reviewStreak} outcomes in this set of run environments were all not achieved`,
            )}
      </span>
    </span>
  );
}

function VersionBlock({
  version,
  reviewStreak,
  t,
}: {
  readonly version: ProcedureVersionStatsWire;
  readonly reviewStreak: number;
  readonly t: Translate;
}) {
  const testId = `procedure-usage-version-${version.version}`;
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        <StatusChip machine="publishable" status={version.status} size="s" />
        <strong>v{version.version}</strong>
        {version.reviewSuggested ? (
          <ReviewSuggested
            reviewStreak={reviewStreak}
            scope="version"
            t={t}
            testId={`${testId}-review`}
          />
        ) : null}
      </div>
      <KeyValue
        items={[...numbersOf(version.usage, version.outcomes, t), ...claimsOf(version.claims, t)]}
        testId={`${testId}-numbers`}
      />
      {version.segments.length > 0 ? (
        <details className="disclosure" data-testid={`${testId}-segments`}>
          <summary>
            {t(
              `按运行环境（${version.segments.length} 组）`,
              `By run environments (${version.segments.length})`,
            )}
          </summary>
          <div className="disclosure-body stack">
            <span className="text-3 text-small">
              {t(
                '一个目标的运行环境，是它各步骤当前那次尝试用到的全部环境指纹；指纹完全相同的目标才分在一组。指纹相同的运行，定义版本、模型、镜像、平台版本和系统提示都相同。',
                'A goal’s run environments are every fingerprint its steps’ current attempts ran in; only goals with exactly the same ones share a set. Runs with the same fingerprint ran the same definition version, model, image, platform version and system prompt.',
              )}
            </span>
            {version.segments.map((segment) => {
              const key = segmentKey(segment);
              return (
                <SegmentBlock
                  key={key}
                  segment={segment}
                  reviewStreak={reviewStreak}
                  t={t}
                  testId={`${testId}-segment-${key}`}
                />
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function segmentKey(segment: ProcedureStatsSegmentWire): string {
  return segment.environmentDigests === null ? 'unknown' : segment.environmentDigests.join('+');
}

function SegmentBlock({
  segment,
  reviewStreak,
  t,
  testId,
}: {
  readonly segment: ProcedureStatsSegmentWire;
  readonly reviewStreak: number;
  readonly t: Translate;
  readonly testId: string;
}) {
  const digests = segment.environmentDigests;
  return (
    <div className="stack-s" data-testid={testId}>
      {digests === null ? (
        <div className="stack-s">
          <strong className="text-small">{t('环境未知', 'Environment unknown')}</strong>
          <span className="text-3 text-small">
            {t(
              '有运行没有上报环境，或用了默认模型而 models.json 没有读到。',
              'A run reported nothing, or used the default model and models.json could not be read.',
            )}
          </span>
        </div>
      ) : (
        <div className="row-wrap">
          <strong className="text-small">
            {t(`${digests.length} 个运行环境`, `${digests.length} run environment(s)`)}
          </strong>
          {digests.map((digest) => (
            <span key={digest} className="mono tag" title={digest} aria-label={digest}>
              {shortDigest(digest)}
            </span>
          ))}
        </div>
      )}
      {segment.reviewSuggested ? (
        <ReviewSuggested
          reviewStreak={reviewStreak}
          scope="segment"
          t={t}
          testId={`${testId}-review`}
        />
      ) : null}
      <KeyValue items={numbersOf(segment.usage, segment.outcomes, t)} />
    </div>
  );
}

/** The same rows for a version and for one of its segments. */
function numbersOf(
  usage: ProcedureUsageWire,
  outcomes: OutcomeTallyWire,
  t: Translate,
): KeyValueItem[] {
  const { proposed, inProgress, completed, cancelled, failed } = usage.byStatus;
  const { primary, proxy } = outcomes;
  const items: KeyValueItem[] = [
    {
      key: 'goals',
      label: t('目标', 'Goals'),
      value:
        usage.goals > 0
          ? t(
              `${usage.goals} 个 · 最近 ${formatRelative(usage.lastUsedAt)}`,
              `${usage.goals} · last ${formatRelative(usage.lastUsedAt)}`,
            )
          : t('没有', 'None'),
    },
  ];
  if (usage.goals > 0) {
    items.push({
      key: 'status',
      label: t('目标状态', 'Goal status'),
      value:
        t(
          `待确认 ${proposed} · 进行中 ${inProgress} · 已结束 ${completed} · 已取消 ${cancelled}`,
          `${proposed} awaiting confirmation · ${inProgress} in progress · ${completed} completed · ${cancelled} cancelled`,
        ) + (failed > 0 ? t(` · 已失败 ${failed}`, ` · ${failed} failed`) : ''),
    });
  }
  items.push({
    key: 'attainment',
    label: t('达成率', 'Attainment'),
    value: <AttainmentValue primary={primary} t={t} testId="procedure-usage-attainment" />,
  });
  if (proxy.total > 0) {
    items.push({
      key: 'proxy',
      label: t('代理指标', 'Proxy signals'),
      value: (
        <span className="row-wrap" data-testid="procedure-usage-proxy">
          <span>
            {t(
              `达成 ${proxy.achieved} · 未达成 ${proxy.notAchieved}`,
              `${proxy.achieved} achieved · ${proxy.notAchieved} not achieved`,
            )}
          </span>
          <span className="text-3 text-small">
            {t('独立评审，不计入达成率', 'Independent reviews, not counted toward attainment')}
          </span>
        </span>
      ),
    });
  }
  return items;
}

/** The Turns an agent said followed the version: apart, never in the rate. */
function claimsOf(claims: ProcedureClaimsWire, t: Translate): KeyValueItem[] {
  if (claims.turns === 0) return [];
  return [
    {
      key: 'claims',
      label: t('自报按此流程', 'Said followed'),
      value: (
        <span className="row-wrap" data-testid="procedure-usage-claims">
          <span>
            {t(
              `${claims.turns} 轮对话 · 请求人判达成 ${claims.achieved} · 未达成 ${claims.notAchieved} · 最近 ${formatRelative(claims.lastClaimedAt)}`,
              `${claims.turns} turn(s) · requester marked ${claims.achieved} achieved, ${claims.notAchieved} not · last ${formatRelative(claims.lastClaimedAt)}`,
            )}
          </span>
          <span className="text-3 text-small">
            {t(
              'agent 自报按这个流程做，不计入达成率',
              'The agent’s own word that it followed it; not counted toward attainment',
            )}
          </span>
        </span>
      ),
    },
  ];
}

function FailureGroups({
  groups,
  t,
}: {
  readonly groups: readonly ProcedureFailureGroupWire[];
  readonly t: Translate;
}) {
  return (
    <div className="stack-s" data-testid="procedure-usage-failures">
      <span className="text-small">
        <strong>{t('未达成的目标', 'Goals not achieved')}</strong>
      </span>
      {groups.length === 0 ? (
        <span className="text-3 text-small">
          {t('没有未达成的目标。', 'No goal ended without being achieved.')}
        </span>
      ) : (
        <ul className="stack-s">
          {groups.map((group) => (
            <li
              key={`${group.procedureVersion}:${group.place}:${group.stepKey}:${group.category}`}
              className="stack-s"
              data-testid="procedure-usage-failure-group"
            >
              <span>
                {t(
                  `v${group.procedureVersion} · ${procedureFailurePlaceLabel(group.place, group.stepKey, t)} · ${group.goals} 个目标 · 最近 ${formatRelative(group.lastEndedAt)}`,
                  `v${group.procedureVersion} · ${procedureFailurePlaceLabel(group.place, group.stepKey, t)} · ${group.goals} goal(s) · last ${formatRelative(group.lastEndedAt)}`,
                )}
              </span>
              {group.category !== null ? (
                <span className="text-3 text-small">
                  {stepFailureText(group.category, t).short}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
