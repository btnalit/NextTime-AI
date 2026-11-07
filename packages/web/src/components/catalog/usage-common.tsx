import type {
  OutcomeTallyWire,
  OutcomeTierTallyWire,
  SkillUsageWire,
  WorkerDefinitionUsageWire,
} from '@nexttime/shared';
import { formatRelative, shortDigest } from '../../lib/format.js';
import type { Translate } from '../../lib/i18n.js';
import type { KeyValueItem } from '../kit/key-value.js';

/**
 * components/catalog/usage-common (S11 W1a E2-1, E2-2, GO16a): what the Skill, Procedure and
 * Worker 「使用情况」 sections show the same way.
 */

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** The attainment rate with its sample — 「33%（1 / 3）」 — or that there is no outcome yet. */
export function AttainmentValue({
  primary,
  t,
  testId,
}: {
  readonly primary: OutcomeTierTallyWire;
  readonly t: Translate;
  readonly testId: string;
}) {
  return primary.attainment !== null ? (
    <span data-testid={testId}>
      {t(
        `${percent(primary.attainment)}（${primary.achieved} / ${primary.total}）`,
        `${percent(primary.attainment)} (${primary.achieved} of ${primary.total})`,
      )}
    </span>
  ) : (
    <span className="text-3">{t('还没有结果', 'No outcomes yet')}</span>
  );
}

/** 「v3、v1」 in Chinese, 「v3, v1」 in English (UX acceptance of #781, P3-1). */
export function versionList(versions: readonly { readonly version: number }[], t: Translate) {
  const names = versions.map((version) => `v${version.version}`);
  return t(names.join('、'), names.join(', '));
}

/** 「建议复核」 — `title` says whose latest outcomes were all not achieved. */
export function ReviewSuggestedChip({
  title,
  t,
  testId,
}: {
  readonly title: string;
  readonly t: Translate;
  readonly testId: string;
}) {
  return (
    <span className="chip chip-warn chip-s" title={title} data-testid={testId}>
      {t('建议复核', 'Review suggested')}
    </span>
  );
}

/** A run environment: its short fingerprint, or 「环境未知」, each explained on hover. */
export function EnvironmentLabel({
  digest,
  t,
}: {
  readonly digest: string | null;
  readonly t: Translate;
}) {
  return digest !== null ? (
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
  );
}

/** Runs, Task results, the attainment rate and the proxy signals apart — the same rows for a
 *  version and for each of its slices, in the Skill's and the Worker's sections; `testIdPrefix`
 *  names the section (`skill-usage`, `worker-usage`). */
export function runNumbers(
  usage: SkillUsageWire | WorkerDefinitionUsageWire,
  outcomes: OutcomeTallyWire,
  t: Translate,
  testIdPrefix: string,
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
      value: <AttainmentValue primary={primary} t={t} testId={`${testIdPrefix}-attainment`} />,
    },
  ];
  if (proxy.total > 0) {
    items.push({
      key: 'proxy',
      label: t('代理指标', 'Proxy signals'),
      value: (
        <span className="row-wrap" data-testid={`${testIdPrefix}-proxy`}>
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
