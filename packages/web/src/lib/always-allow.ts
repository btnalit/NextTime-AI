import type { Translate } from './i18n.js';

/** A pending request's published definition as `list_pending` / `get_action` report it (legacy
 *  218): `version` is the one the gate publishes now (`null`: none — a draft only, deprecated, or
 *  removed by the gate), `requestIsCurrent` whether this request was made under that version. */
export interface PublishedDefinition {
  readonly version: number | null;
  readonly requestIsCurrent: boolean;
}

/** Why "总是允许" is not offered on a pending request whose definition is known: `unpublished`
 *  (nothing published to allow), `stale` (a newer version is published), `unknown` (not read). */
export type AlwaysAllowBlock = 'unpublished' | 'stale' | 'unknown';

/**
 * Legacy 218 (UX acceptance of #592): "总是允许" writes a rule for the definition this request was
 * made under, and the kernel writes one only while that definition is the one published. So it is
 * offered only when a read says so; anything else gets no option — never one refused after it is
 * clicked — and `block` names why, for the sentence beside it.
 */
export function alwaysAllowOffer(published: PublishedDefinition | undefined): {
  readonly offer: boolean;
  readonly block: AlwaysAllowBlock | null;
  /** The version the rule would cover — set only when it is offered. */
  readonly coveredVersion: number | null;
} {
  if (published === undefined) return { offer: false, block: 'unknown', coveredVersion: null };
  if (published.version === null)
    return { offer: false, block: 'unpublished', coveredVersion: null };
  if (!published.requestIsCurrent) return { offer: false, block: 'stale', coveredVersion: null };
  return { offer: true, block: null, coveredVersion: published.version };
}

/** The gate publishes no definition of this action: it is still a draft, or it was deprecated or
 *  removed. One sentence covers all three — a rule needs a published definition either way. */
export function alwaysAllowUnpublishedText(
  t: Translate,
  actionKind: string,
  gateName?: string,
): string {
  const where =
    gateName !== undefined
      ? t(`门「${gateName}」上`, `Gate “${gateName}” has`)
      : t('门上', 'The gate has');
  return t(
    `${where}没有已发布的「${actionKind}」（它还是草稿，或已经弃用、被门删掉），所以不能选「总是允许」：规则只能给已发布、你看过的定义。发布之后，在新的请求上再选。`,
    `${where} no published “${actionKind}” (it is still a draft, or it was deprecated or removed by the gate), so “Always allow” is not offered: a rule can only cover a published definition you have seen. Once it is published, choose it on a new request.`,
  );
}

/** This request was made under an earlier definition than the one published now. */
export function alwaysAllowStaleRequestText(t: Translate, publishedVersion: number): string {
  return t(
    `这条请求是按旧定义发起的，门上现在发布的是 v${publishedVersion}，所以这里不能选「总是允许」：它只能给你看过的定义。在 v${publishedVersion} 的请求上再选，工作区所有者也可以在「模型与配额」的策略表里确认。`,
    `This request was made under an earlier definition, and the gate now publishes v${publishedVersion}, so “Always allow” is not offered here: it covers only a definition you have seen. Choose it on a request made under v${publishedVersion}; the workspace owner can also confirm it in the policy table under Models & Quotas.`,
  );
}
