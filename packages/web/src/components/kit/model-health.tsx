import type { ProviderHealthWire } from '@nexttime/shared';
import { useT } from '../../lib/i18n.js';
import { type ProviderStatus, describeProviderHealth } from '../../lib/provider-status.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from './notice.js';
import { RouteLink } from './route-link.js';

/** A model row as the pickers hold it: `list_models` / `list_platform_models` items. */
export interface HealthAwareModel {
  readonly id: string;
  readonly provider: string;
  readonly health?: ProviderHealthWire;
}

/** How the console names `model`'s provider health. No `health` from the kernel is `unknown`
 *  (review M1: llm-proxy's health file is missing or unreadable, or does not name the provider) —
 *  never shown as working. `undefined` only when there is no model. */
export function modelHealth(model: HealthAwareModel | undefined): ProviderStatus | undefined {
  if (!model) return undefined;
  return describeProviderHealth(model.health ? model.health.status : 'unknown');
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
      data-health={health?.kind}
      title={health ? t(health.detailZh, health.detailEn) : undefined}
    >
      {label ?? model.id}
      {suffix}
    </option>
  );
}

/** Where a picker's note sends the viewer for `health`: a platform page links the provider's
 *  drawer on 模型与供应商 (its 连通性测试 and 密钥 sections); any other page names who can act. */
function NextStep({
  health,
  provider,
  canFix,
  testId,
}: {
  readonly health: ProviderStatus;
  readonly provider: string | null;
  readonly canFix: boolean;
  readonly testId: string;
}) {
  const t = useT();
  if (canFix) {
    const href = provider ? hrefs.platformModelsProvider(provider) : hrefs.platformModels();
    const label =
      health.kind === 'untested'
        ? t('去测试供应商', 'Test the provider')
        : health.kind === 'unknown'
          ? t('去模型与供应商检查', 'Check Models & providers')
          : t('去模型与供应商修复', 'Fix it in Models & providers');
    return (
      <RouteLink href={href} className="link-inline" testId={`${testId}-fix`}>
        {label}
      </RouteLink>
    );
  }
  return (
    <>
      {health.kind === 'untested'
        ? t('请平台管理员测试这个供应商。', 'Ask a platform administrator to test this provider.')
        : health.kind === 'unknown'
          ? t(
              '请平台管理员检查供应商状态。',
              'Ask a platform administrator to check the provider status.',
            )
          : t('请平台管理员在「模型与供应商」里处理。', 'Ask a platform administrator to fix it.')}
    </>
  );
}

/**
 * The note under a model picker: what is wrong with the chosen model's provider and the next step
 * (test it, fix it, or who to ask), or — when the choice is fine — how many models the picker
 * could not offer or cannot vouch for, and why. `canFix`: the viewer can open 平台 · 模型与供应商
 * (a platform page); otherwise the note says who can. Renders nothing when there is nothing to
 * say.
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
        <NextStep health={health} provider={selected.provider} canFix={canFix} testId={testId} />
      </Notice>
    );
  }
  const blocked = models.filter((model) => modelHealth(model)?.usability === 'blocked');
  const unknown = models.filter((model) => !model.health);
  if (blocked.length === 0 && unknown.length === 0) return null;
  const providersOf = (rows: readonly HealthAwareModel[]) => [
    ...new Set(rows.map((model) => model.provider)),
  ];
  const blockedProviders = providersOf(blocked);
  const unknownProviders = providersOf(unknown);
  const step = describeProviderHealth(blocked.length > 0 ? 'test_failed' : 'unknown');
  return (
    <Notice testId={testId}>
      {blocked.length > 0 ? (
        <span data-blocked={blocked.length}>
          {t(
            `${blocked.length} 个模型不能选：供应商 ${blockedProviders.join('、')} 当前调用会失败。`,
            `${blocked.length} model(s) cannot be chosen: calls to ${blockedProviders.join(', ')} fail right now.`,
          )}{' '}
        </span>
      ) : null}
      {unknown.length > 0 ? (
        <span data-unknown={unknown.length}>
          {t(
            `${unknown.length} 个模型状态未知：读不到供应商 ${unknownProviders.join('、')} 的测试状态。`,
            `${unknown.length} model(s) have an unknown status: the test status of ${unknownProviders.join(', ')} cannot be read.`,
          )}{' '}
        </span>
      ) : null}
      <NextStep
        health={step}
        provider={
          blockedProviders.length + unknownProviders.length === 1
            ? (blockedProviders[0] ?? unknownProviders[0] ?? null)
            : null
        }
        canFix={canFix}
        testId={testId}
      />
    </Notice>
  );
}

/** The status after a model's name in a checklist (允许的模型) or a table: nothing for a working
 *  model unless `showOk` (a table's 状态 column), else the short label (状态未知 included).
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
