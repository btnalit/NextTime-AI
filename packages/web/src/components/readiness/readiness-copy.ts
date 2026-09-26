import type { ExecutionReadinessMissingWire, GateUnreachableReason } from '@nexttime/shared';
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
    case 'no_worker_gate':
      return t(
        '委派出去的 Worker 碰不到任何系统：在 Worker 定义里勾选已授权的门，再发布新版本。',
        'A delegated Worker reaches no system: tick a granted gate in the Worker definition, then publish a new version.',
      );
    case 'excluded_by_profile': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      return name
        ? t(
            `门「${name}」已经授权给你，但在「我的智能体」里被取消了勾选，入口 agent 用不了它。`,
            `The “${name}” gate is granted to you but unticked on My Agent, so your entry agent cannot use it.`,
          )
        : t(
            '有已授权的系统或 Worker 在「我的智能体」里被取消了勾选。',
            'A granted system or Worker is unticked on My Agent.',
          );
    }
    case 'excluded_by_policy': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      return name
        ? t(
            `门「${name}」已经授权给你，但工作区策略的门上限没有包含它。`,
            `The “${name}” gate is granted to you, but the workspace policy’s gate limit leaves it out.`,
          )
        : t(
            '工作区策略的门上限把一个已授权的系统排除在外。',
            'The workspace policy’s gate limit leaves a granted system out.',
          );
    }
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
    case 'no_worker_gate':
      return hrefs.catalog(CATALOG_WORKERS_TAB);
    case 'excluded_by_profile':
      return hrefs.agent();
    case 'excluded_by_policy':
      return hrefs.models();
  }
}

/** The link's own label — names the destination page, never the internal code. */
export function missingLinkLabel(item: ExecutionReadinessMissingWire, t: Translate): string {
  switch (item.code) {
    case 'no_enabled_gate':
      return t('去系统与授权', 'Go to Systems & access');
    case 'no_grant':
      return t('去系统与授权', 'Go to Systems & access');
    case 'no_published_worker':
    case 'no_worker_gate':
      return t('去能力目录', 'Go to Catalog');
    case 'excluded_by_profile':
      return t('去我的智能体', 'Go to My Agent');
    case 'excluded_by_policy':
      return t('去模型与配额', 'Go to Models & Quotas');
  }
}

/** Console redesign M2: why one system is not usable by the entry agent (`gates[].reason`) — the
 *  same reason code `find_operations` hands the agent, so both say the same thing. */
export function gateReasonText(reason: GateUnreachableReason | undefined, t: Translate): string {
  switch (reason) {
    case 'no_published_operation':
      return t('这个系统还没有已发布的操作。', 'This system has no published operation yet.');
    case 'not_granted':
      return t(
        '还没有授权给你——需要工作区所有者授权。',
        'Not granted to you yet — a workspace owner has to grant it.',
      );
    case 'excluded_by_policy':
      return t(
        '已授权给你，但工作区策略的门上限没有包含它。',
        'Granted to you, but the workspace policy’s gate limit leaves it out.',
      );
    case 'excluded_by_profile':
      return t(
        '已授权给你，但你在「我的智能体」里取消了勾选。',
        'Granted to you, but you unticked it on My Agent.',
      );
    case 'no_worker':
      return t(
        '没有能调用它的 Worker——需要发布一个挂了这个系统的 Worker。',
        'No Worker can call it — publish a Worker that includes this system.',
      );
    case undefined:
      return t('暂时用不了。', 'Not usable right now.');
  }
}

export function gateReasonHref(reason: GateUnreachableReason): string {
  switch (reason) {
    case 'no_published_operation':
      return hrefs.systems();
    case 'not_granted':
      return hrefs.access();
    case 'excluded_by_policy':
      return hrefs.models();
    case 'excluded_by_profile':
      return hrefs.agent();
    case 'no_worker':
      return hrefs.catalog(CATALOG_WORKERS_TAB);
  }
}

export function gateReasonLink(reason: GateUnreachableReason, t: Translate): string {
  switch (reason) {
    case 'no_published_operation':
      return t('去系统与授权', 'Go to Systems & access');
    case 'not_granted':
      return t('去系统与授权', 'Go to Systems & access');
    case 'excluded_by_policy':
      return t('去模型与配额', 'Go to Models & Quotas');
    case 'excluded_by_profile':
      return t('去我的智能体', 'Go to My Agent');
    case 'no_worker':
      return t('去能力目录', 'Go to Catalog');
  }
}

/** A stable React key for one `missing[]` entry — `code` alone collides when the same code
 *  appears without a `gateId` and with one (the handler already dedupes by `code:gateId`,
 *  `execution-readiness-handler.ts`'s own `missingByKey`, so this only needs to mirror that). */
export function missingKey(item: ExecutionReadinessMissingWire): string {
  return `${item.code}:${item.gateId ?? ''}`;
}
