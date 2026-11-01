import { clipCodePoints, visibleText } from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/queue-scope (S11 GO12): how the console says what a gate's queue orders a request against —
 * the one instance it acts on, or the whole system (Gatekeeper). Two requests of one system wait
 * for each other only when either acts on the whole system or both act on the same instance
 * (`@nexttime/shared` `actionTargetsConflict`); an Operation declares which instance its calls act
 * on (`OperationSchema.target`), and a request records it when it is made
 * (`ActionRequestWireSchema.target`).
 */

/** `ActionRequestWireSchema.target`: the instance a request acts on. */
export interface ActionTargetFields {
  readonly objectType: string;
  readonly identity: readonly (string | number)[];
}

/** `OperationSummaryWireSchema.target` / `OperationGovernanceFieldsWireSchema.target`: which
 *  instance an Operation's calls act on — its type and the params that name it, in order. */
export interface OperationTargetFields {
  readonly objectType: string;
  readonly params: readonly string[];
}

/** One identity value as shown: unseen characters escaped, clipped (it is the caller's input). */
function identityValueText(value: string | number): string {
  return visibleText(clipCodePoints(String(value), 40));
}

/** 「Container「c1」」 / `Container “c1”` — a request's instance; several values, one quote each. */
export function actionTargetText(target: ActionTargetFields, t: Translate): string {
  const values = target.identity.map(identityValueText);
  return t(
    `${target.objectType}${values.map((value) => `「${value}」`).join('')}`,
    `${target.objectType} ${values.map((value) => `“${value}”`).join(' ')}`,
  );
}

/** What a request acts on, for a detail row: its instance, or the whole system. */
export function actionTargetOrSystemText(target: ActionTargetFields | null, t: Translate): string {
  return target === null ? t('整个系统', 'The whole system') : actionTargetText(target, t);
}

/** What a request that has not finished holds back, for an approver — said once it is known what
 *  it acts on: later requests on the same instance, or every later request of the system. */
export function actionTargetHoldsText(target: ActionTargetFields | null, t: Translate): string {
  return target === null
    ? t(
        '这个系统上后来的请求都要等它有了结果再执行。',
        'Every later request on this system waits until this one has a result.',
      )
    : t(
        `同一个 ${target.objectType} 上后来的请求要等它有了结果再执行；别的 ${target.objectType} 上的请求不等它。`,
        `Later requests on the same ${target.objectType} wait until this one has a result; requests on another ${target.objectType} do not wait for it.`,
      );
}

/** 「按 Container（id）」 / 「整个系统」 — an Operation's queue scope in a few words, for a
 *  before → after line. */
export function operationQueueScopeShortText(
  target: OperationTargetFields | null | undefined,
  t: Translate,
): string {
  if (target === null || target === undefined) return t('整个系统', 'Whole system');
  return t(
    `按 ${target.objectType}（${target.params.join('、')}）`,
    `Per ${target.objectType} (${target.params.join(', ')})`,
  );
}

/** An Operation's queue scope as a sentence, for its detail. */
export function operationQueueScopeText(
  target: OperationTargetFields | null | undefined,
  t: Translate,
): string {
  if (target === null || target === undefined) {
    return t(
      '整个系统：这个系统上的请求按提出顺序逐个执行。',
      'Whole system: requests on this system run one at a time, in the order they were made.',
    );
  }
  const params = target.params.join(t('、', ', '));
  return t(
    `按目标：${target.objectType}（参数 ${params}）。同一个 ${target.objectType} 上的请求按提出顺序执行，别的 ${target.objectType} 上的请求不等它。`,
    `Per target: ${target.objectType} (${target.params.length > 1 ? 'params' : 'param'} ${params}). Requests on the same ${target.objectType} run in the order they were made; requests on another ${target.objectType} do not wait for them.`,
  );
}
