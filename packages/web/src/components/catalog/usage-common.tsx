import type { OutcomeTierTallyWire } from '@nexttime/shared';
import type { Translate } from '../../lib/i18n.js';

/**
 * components/catalog/usage-common (S11 W1a E2-1, E2-2): what the Skill and Procedure 「使用情况」
 * sections show the same way.
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
