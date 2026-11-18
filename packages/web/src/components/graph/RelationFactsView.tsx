import type { FactWire } from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { freshnessOf } from '../../lib/graph-freshness.js';
import { useT } from '../../lib/i18n.js';
import { epistemicStatusLabel } from '../../lib/labels.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { RefChip } from '../kit/ref-chip.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { FreshnessChip } from './FreshnessChip.js';
import { useGraphObjects } from './GraphObjectsContext.js';

/** One endpoint's type and display name, as `list_facts` returns them in `nodeDetails`. */
interface NodeDetail {
  readonly id: string;
  readonly typeName: string;
  readonly name?: string;
}

interface FactsPage {
  readonly items: readonly FactWire[];
  readonly nodeDetails: readonly NodeDetail[];
  readonly nextCursor?: string;
}

/** Facts per `list_facts` page (kernel default 50, max 200). */
export const RELATION_PAGE_SIZE = 50;

export interface RelationFactsViewProps {
  readonly http: CapabilityCaller;
  readonly linkType: string;
  /** The type's active-Fact count from `graph_overview`, when the search pane has it. */
  readonly total?: number;
  readonly asOf: number;
  readonly onClose: () => void;
  readonly onProvenance: (fact: FactWire) => void;
}

/**
 * components/graph/RelationFactsView (legacy 147): the object pane while a relationship type is
 * browsed (`?relation=`) — every active Fact of that type across the workspace (`list_facts`,
 * newest first), each as source → link type → target with the endpoints named from the page's
 * own `nodeDetails` (never a bare id) and typed, the Fact's freshness and 「溯源」. An endpoint
 * links to that Object (the hash keeps `relation`, so leaving the Object comes back here).
 * 「加载更多」 follows `nextCursor`; every page brings its own endpoint names.
 */
export function RelationFactsView({
  http,
  linkType,
  total,
  asOf,
  onClose,
  onProvenance,
}: RelationFactsViewProps) {
  const t = useT();
  const { hrefFor } = useGraphObjects();
  const params = useMemo(() => ({ linkType, limit: RELATION_PAGE_SIZE }), [linkType]);
  const first = useCapability<FactsPage>(http, 'list_facts', params);
  const [more, setMore] = useState<readonly FactsPage[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<unknown | null>(null);
  // A new type, or a reload of the first page, starts the list over.
  const firstData = first.state.status === 'ready' ? first.state.data : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new type or first page
  useEffect(() => {
    setMore([]);
    setLoadMoreError(null);
  }, [linkType, firstData]);

  const pages = useMemo(() => (firstData ? [firstData, ...more] : []), [firstData, more]);
  const facts = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const nodes = useMemo(() => {
    const byId = new Map<string, NodeDetail>();
    for (const page of pages) for (const node of page.nodeDetails) byId.set(node.id, node);
    return byId;
  }, [pages]);
  const nextCursor = pages.length > 0 ? pages[pages.length - 1]?.nextCursor : undefined;

  const loadMore = useCallback(async () => {
    if (nextCursor === undefined || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await http.call<FactsPage>('list_facts', { ...params, cursor: nextCursor });
      // A page that echoes its cursor, or comes back empty, ends the list (same guard as
      // `useCapabilityList`).
      const next =
        page.nextCursor === nextCursor || page.items.length === 0 ? undefined : page.nextCursor;
      setMore((prev) => [
        ...prev,
        {
          items: page.items,
          nodeDetails: page.nodeDetails,
          ...(next !== undefined ? { nextCursor: next } : {}),
        },
      ]);
    } catch (error) {
      setLoadMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  }, [http, params, nextCursor, loadingMore]);

  // UX #1455 M2: an endpoint is always an Object, so it reads as its name then its type — one
  // link, the whole of it a tap target — with no 「对象」 label or copy button to crowd the name on
  // a narrow screen. An endpoint the page did not name degrades to the kit chip (short id +
  // 「未知 / 已删除」), never a bare id.
  const endpoint = (id: string, testId: string) => {
    const node = nodes.get(id);
    if (node?.name === undefined || node.name === '') {
      return <RefChip kind="object" id={id} typeName={node?.typeName} size="s" testId={testId} />;
    }
    return (
      <a
        className="graph-relation-end"
        href={hrefFor(id)}
        title={`${node.name} (${node.typeName}) · ${id}`}
        data-ref-id={id}
        data-testid={testId}
      >
        <span className="graph-relation-end-name">{node.name}</span>
        <span className="graph-relation-end-type">{node.typeName}</span>
      </a>
    );
  };

  return (
    <div
      className="stack graph-relation-view"
      data-testid="graph-relation-view"
      data-link-type={linkType}
    >
      <nav className="graph-trail" aria-label="Focus trail">
        <Button variant="ghost" size="s" onClick={onClose} data-testid="graph-relation-close">
          ← {t('返回搜索', 'Back to search')}
        </Button>
      </nav>
      <header className="section-header">
        <h2 className="section-title">
          {t('关系', 'Relationship')}{' '}
          <span className="mono graph-relation-title-type">{linkType}</span>
        </h2>
        {total !== undefined ? (
          <span className="text-3 text-small" data-testid="graph-relation-total">
            {t(`共 ${total} 条`, `${total} in all`)}
          </span>
        ) : null}
      </header>
      {first.state.status === 'loading' ? (
        <SkeletonRows count={5} label="Loading facts" testId="graph-relation-loading" />
      ) : first.state.status === 'error' ? (
        <ErrorBanner
          error={first.state.error}
          title={t('无法列出这类关系', 'Could not list this relationship')}
          onRetry={() => void first.reload()}
          testId="graph-relation-error"
        />
      ) : facts.length === 0 ? (
        <EmptyState
          title={t('没有这类关系', 'No Facts of this relationship')}
          body={t(
            '这类关系现在没有生效的事实；可能已失效或被替换。',
            'No Fact of this type is active now — they may have been invalidated or superseded.',
          )}
          testId="graph-relation-empty"
        />
      ) : (
        <>
          <ul className="data-list" aria-label={linkType} data-testid="graph-relation-facts">
            {facts.map((fact) => (
              <li
                key={fact.id}
                className="data-row graph-relation-row"
                data-testid="graph-relation-fact"
              >
                <div className="data-row-main">
                  <div className="data-row-title graph-relation-line">
                    {endpoint(fact.sourceObjectId, 'graph-relation-source')}
                    <span className="text-3 mono" aria-hidden="true">
                      → {linkType} →
                    </span>
                    {endpoint(fact.targetObjectId, 'graph-relation-target')}
                  </div>
                  <div className="data-row-meta">
                    <FreshnessChip
                      freshness={freshnessOf(
                        {
                          lastObservedAt: fact.lastObservedAt,
                          supersededAt: fact.supersededAt,
                          invalidatedAt: fact.invalidatedAt,
                          invalidationReason: fact.invalidationReason,
                          epistemicStatus: fact.epistemicStatus,
                        },
                        asOf,
                      )}
                      size="s"
                    />
                    <span className="tag" title={t('认知状态', 'Epistemic status')}>
                      {epistemicStatusLabel(fact.epistemicStatus, t)}
                    </span>
                    {/* UX #1455 M2: on the meta line, not a column that squeezes the endpoints. */}
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => onProvenance(fact)}
                      data-testid="graph-relation-provenance"
                    >
                      {t('溯源', 'Provenance')}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {loadMoreError !== null ? (
            <ErrorBanner error={loadMoreError} title={t('无法加载更多', 'Could not load more')} />
          ) : null}
          {nextCursor !== undefined ? (
            <div className="row">
              <Button
                variant="secondary"
                size="s"
                disabled={loadingMore}
                aria-busy={loadingMore}
                onClick={() => void loadMore()}
                data-testid="graph-relation-load-more"
              >
                {t('加载更多', 'Load more')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
