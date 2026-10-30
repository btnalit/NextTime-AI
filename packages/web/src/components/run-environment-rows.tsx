import type { RunEnvironmentWire } from '@nexttime/shared';
import { shortDigest, shortId } from '../lib/format.js';
import type { Translate } from '../lib/i18n.js';
import type { KeyValueItem } from './kit/key-value.js';

/**
 * components/run-environment-rows (S11 W1a): what one run ran with, as `KeyValue` rows — the
 * WorkerDefinition version, the model, the platform build, the runtime image, the system prompt's
 * digest and the environment fingerprint they make. 任务详情's 运行环境 and a draft evaluation's
 * environments (S10 E3-2b) show it the same way. `definitionName` names the definition when it is
 * `definitionId`; any other shows its short id.
 */
export function runEnvironmentRows(
  environment: RunEnvironmentWire,
  definitionId: string,
  definitionName: string | undefined,
  t: Translate,
): KeyValueItem[] {
  const { definition, runtime } = environment;
  const name =
    definition.id === definitionId && definitionName ? definitionName : shortId(definition.id);
  return [
    {
      key: 'definition',
      label: t('Worker 定义', 'Worker definition'),
      value: (
        <span title={definition.id}>
          {name} v{definition.version}
        </span>
      ),
    },
    {
      key: 'model',
      label: t('模型', 'Model'),
      value:
        environment.model !== null ? (
          <span className="mono">{environment.model}</span>
        ) : (
          <span
            className="text-3"
            title={t(
              'Worker 定义和请求人都没有指定模型，用的是平台模型配置里的默认模型。',
              'Neither the Worker definition nor the requester named a model: the default in the platform’s model configuration.',
            )}
          >
            {t(
              '运行时默认（Worker 定义和请求人都没指定）',
              'Runtime default (neither the Worker definition nor the requester named one)',
            )}
          </span>
        ),
    },
    {
      key: 'platform',
      label: t('平台版本', 'Platform version'),
      value: <span className="mono">{environment.kernelVersion}</span>,
    },
    {
      key: 'image',
      label: t('运行时镜像', 'Runtime image'),
      value: runtime ? (
        <span className="row-wrap" data-testid="run-environment-image">
          <span
            className="mono"
            title={`${runtime.imageRef}\n${runtime.imageId}${runtime.builtFrom ? `\n${runtime.builtFrom}` : ''}`}
          >
            {shortDigest(runtime.imageId)}
          </span>
          {runtime.piVersion ? (
            <span className="text-3 text-small">pi {runtime.piVersion}</span>
          ) : null}
        </span>
      ) : (
        <span className="text-3" data-testid="run-environment-image">
          {t(
            '未上报：这次运行没有启动成功，或启动它的 worker-supervisor 版本较早',
            'Not reported: this run never started, or the worker-supervisor that started it predates the report',
          )}
        </span>
      ),
    },
    {
      key: 'prompt',
      label: t('系统提示摘要', 'System prompt digest'),
      value:
        environment.systemPromptDigest !== null ? (
          <span className="mono" title={environment.systemPromptDigest}>
            {shortDigest(environment.systemPromptDigest)}
          </span>
        ) : (
          <span className="text-3">{t('无', 'None')}</span>
        ),
    },
    {
      key: 'environment',
      label: t('环境指纹', 'Environment fingerprint'),
      value:
        environment.environmentDigest !== null ? (
          <span
            className="mono"
            title={t(
              `${environment.environmentDigest}\n指纹相同的运行，定义版本、模型、镜像、平台版本和系统提示都相同。`,
              `${environment.environmentDigest}\nRuns with the same fingerprint ran the same definition version, model, image, platform version and system prompt.`,
            )}
            data-testid="run-environment-digest"
          >
            {shortDigest(environment.environmentDigest)}
          </span>
        ) : (
          <span className="text-3" data-testid="run-environment-digest">
            {t(
              '无法确定：运行时没有上报，或用了默认模型、平台没读到模型配置',
              'Unknown: the runtime reported nothing, or the run used the default model and the platform could not read its model configuration',
            )}
          </span>
        ),
    },
  ];
}
