import type { ExecutionReadinessMissingWire } from '@nexttime/shared';
import type { Translate } from '../../lib/i18n.js';
import { type CatalogTab, hrefs } from '../../lib/router.js';

/**
 * components/readiness/readiness-copy: the one place `ExecutionReadinessMissingWire.code` (and,
 * for `no_grant`, its `gateId`) turns into console copy — shared by `ExecutionReadinessCard` (J1's
 * "开始使用" card) and `ExecutionPrerequisiteBar` (J1's shared hint bar on 系统接入 / 目录 /
 * 访问), so the two surfaces never drift on wording or on which page a code sends the reader to.
 * `missing.code` itself is never rendered — every caller goes through `missingCauseText` /
 * `missingLinkHref` / `missingLinkLabel` below (ui-audit S14 "内部术语外泄").
 *
 * `gateNames` resolves a `no_grant` item's optional `gateId` to a human name — callers build it
 * from the *same* `execution_readiness` response's own `gates[]` (each already carries `name`),
 * never a separate `resolve_refs` round trip: the one read already has everything this component
 * needs.
 */
export type GateNameLookup = ReadonlyMap<string, string>;

const CATALOG_WORKERS_TAB: CatalogTab = 'workers';

/** One line explaining *why* this item is missing — never the raw `code`, never a bare id. */
export function missingCauseText(
  item: ExecutionReadinessMissingWire,
  gateNames: GateNameLookup,
  t: Translate,
): string {
  switch (item.code) {
    case 'no_enabled_gate':
      return t(
        '入口 agent 还没有任何可以作用的系统，先在系统接入启用一个门。',
        'Your entry agent has no system to act on yet — enable a gate under Systems first.',
      );
    case 'no_grant': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      if (name) {
        return t(
          `门「${name}」还没有授权给你的入口 agent。`,
          `Your entry agent has not been granted the “${name}” gate yet.`,
        );
      }
      return t(
        '你的入口 agent 还没有获得任何门的授权。',
        'Your entry agent has not been granted any gate yet.',
      );
    }
    case 'no_published_worker':
      return t(
        '入口 agent 委派任务时找不到可用的 Worker，先发布一个 Worker 定义（可从 ops-runner 模板开始）。',
        'Your entry agent finds no Worker to delegate to — publish a Worker definition first (the ops-runner template is a quick start).',
      );
  }
}

/** Where "去修复" sends the reader for this missing item. */
export function missingLinkHref(item: ExecutionReadinessMissingWire): string {
  switch (item.code) {
    case 'no_enabled_gate':
      return hrefs.systems();
    case 'no_grant':
      return hrefs.access();
    case 'no_published_worker':
      return hrefs.catalog(CATALOG_WORKERS_TAB);
  }
}

/** The link's own label — names the destination page, never the internal code. */
export function missingLinkLabel(item: ExecutionReadinessMissingWire, t: Translate): string {
  switch (item.code) {
    case 'no_enabled_gate':
      return t('去系统接入', 'Go to Systems');
    case 'no_grant':
      return t('去访问', 'Go to Access');
    case 'no_published_worker':
      return t('去能力目录', 'Go to Catalog');
  }
}

/** A stable React key for one `missing[]` entry — `code` alone collides when the same code
 *  appears without a `gateId` and with one (the handler already dedupes by `code:gateId`,
 *  `execution-readiness-handler.ts`'s own `missingByKey`, so this only needs to mirror that). */
export function missingKey(item: ExecutionReadinessMissingWire): string {
  return `${item.code}:${item.gateId ?? ''}`;
}
