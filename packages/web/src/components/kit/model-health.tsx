import type { ProviderHealthWire } from '@nexttime/shared';
import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n.js';
import { type ProviderStatus, describeProviderHealth } from '../../lib/provider-status.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from './notice.js';

/** A model row as the pickers hold it: `list_models` / `list_platform_models` items. */
export interface HealthAwareModel {
  readonly id: string;
  readonly provider: string;
  readonly health?: ProviderHealthWire;
}

/** How the console names `model`'s provider health — `undefined` when the kernel sent none
 *  (llm-proxy wrote no health): unknown, shown as before. */
export function modelHealth(model: HealthAwareModel | undefined): ProviderStatus | undefined {
  return model?.health ? describeProviderHealth(model.health.status) : undefined;
}

/** A `blocked` model fails every call: not offered, except the value already chosen (kept
 *  visible, marked, so the select does not silently show something else). */
export function modelOptionDisabled(model: HealthAwareModel, selected: boolean): boolean {
  return !selected && modelHealth(model)?.usability === 'blocked';
}

/**
 * components/kit/model-health: one `<option>` of a model picker, with its provider's health
 * (console audit P0-2; `@nexttime/shared` `providerHealth`): a working model reads as before, an
 * untested or tools-failing one carries the status after its label, and one whose every call
 * fails is disabled unless it is the current value.
 */
export function ModelOption({
  model,
  label,
  selected = false,
}: {
  readonly model: HealthAwareModel;
  /** The visible name; defaults to the model id. */
  readonly label?: string;
  readonly selected?: boolean;
}) {
  const t = useT();
  const health = modelHealth(model);
  const suffix = health && health.usability !== 'ok' ? ` · ${t(health.zh, health.en)}` : '';
  return (
    <option
      value={model.id}
      disabled={modelOptionDisabled(model, selected)}
      data-health={model.health?.status}
      title={health ? t(health.detailZh, health.detailEn) : undefined}
    >
      {label ?? model.id}
      {suffix}
    </option>
  );
}

/**
 * The note under a model picker: what is wrong with the chosen model's provider and where it is
 * fixed, or — when the choice is fine — how many models the picker could not offer and why.
 * `canFix`: the viewer can open 平台 · 模型与供应商 (a platform page); otherwise the note says
 * who can. Renders nothing when there is nothing to say.
 */
export function ModelHealthNote({
  models,
  selectedId,
  canFix,
  testId = 'model-health-note',
}: {
  readonly models: readonly HealthAwareModel[];
  /** The picker's current model id; `null` / `undefined` = an inherited default (nothing chosen
   *  here). */
  readonly selectedId?: string | null;
  readonly canFix: boolean;
  readonly testId?: string;
}) {
  const t = useT();
  const fix: ReactNode = canFix ? (
    <a href={hrefs.platformModels()} data-testid={`${testId}-fix`}>
      {t('去模型与供应商修复', 'Fix it in Models & providers')}
    </a>
  ) : (
    t('请平台管理员在「模型与供应商」里处理。', 'Ask a platform administrator to fix it.')
  );
  const selected = selectedId ? models.find((model) => model.id === selectedId) : undefined;
  const health = modelHealth(selected);
  if (selected && health && health.usability !== 'ok') {
    return (
      <Notice tone="warn" testId={testId}>
        <span data-health={health.kind}>
          {t(
            `所选模型的供应商「${selected.provider}」：${health.zh}。${health.detailZh}。`,
            `The chosen model's provider "${selected.provider}": ${health.en}. ${health.detailEn}.`,
          )}
        </span>{' '}
        {health.usability === 'blocked' || health.usability === 'warn' ? fix : null}
      </Notice>
    );
  }
  const blocked = models.filter((model) => modelHealth(model)?.usability === 'blocked');
  if (blocked.length === 0) return null;
  const providers = [...new Set(blocked.map((model) => model.provider))];
  return (
    <Notice testId={testId}>
      <span data-blocked={blocked.length}>
        {t(
          `${blocked.length} 个模型不能选：供应商 ${providers.join('、')} 当前调用会失败。`,
          `${blocked.length} model(s) cannot be chosen: calls to ${providers.join(', ')} fail right now.`,
        )}
      </span>{' '}
      {fix}
    </Notice>
  );
}

/** The status after a model's name in a checklist (允许的模型) or a table: nothing for an unknown
 *  health, nor for a working model unless `showOk` (a table's 状态 column), else the short label.
 *  A checklist never disables a model — allowing one whose provider is being fixed is a policy
 *  choice — the pickers do. */
export function ModelHealthTag({
  model,
  showOk = false,
  testId,
}: {
  readonly model: HealthAwareModel | undefined;
  readonly showOk?: boolean;
  readonly testId?: string;
}) {
  const t = useT();
  const health = modelHealth(model);
  if (!health || (health.usability === 'ok' && !showOk)) return null;
  return (
    <span
      className={`chip chip-s chip-${health.tone}`}
      data-health={health.kind}
      data-testid={testId}
      title={t(health.detailZh, health.detailEn)}
    >
      {t(health.zh, health.en)}
    </span>
  );
}
