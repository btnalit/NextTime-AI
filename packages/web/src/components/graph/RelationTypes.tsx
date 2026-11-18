import type { Resource } from '../../hooks/useResource.js';
import { useT } from '../../lib/i18n.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { SkeletonRows } from '../kit/skeleton.js';

/** One relationship type and how many active Facts it has (`graph_overview`). */
export interface LinkTypeCount {
  readonly linkType: string;
  readonly count: number;
}

/** `graph_overview`'s result. */
export interface GraphOverview {
  readonly factCountsByLinkType: readonly LinkTypeCount[];
}

export interface RelationTypesProps {
  /** `graph_overview`, loaded by the page (the object pane reads the same counts). */
  readonly overview: Resource<GraphOverview>;
  /** The relationship type browsed in the object pane (`?relation=`), if any. */
  readonly selected?: string;
  readonly onSelect: (linkType: string) => void;
}

/**
 * components/graph/RelationTypes (legacy 147): 「按关系浏览」 in the search pane — every
 * relationship type the reader can see with its active-Fact count (`graph_overview`, the same
 * counts the entry agent gets), each a button that lists that type's Facts in the object pane
 * (`RelationFactsView`, `list_facts`). Ordered by the kernel (by link type).
 */
export function RelationTypes({ overview, selected, onSelect }: RelationTypesProps) {
  const t = useT();
  return (
    <section
      className="stack-s"
      aria-labelledby="graph-relations-title"
      data-testid="graph-relations"
    >
      <div className="section-header">
        <h2 className="section-title" id="graph-relations-title">
          {t('按关系浏览', 'Browse by relationship')}
        </h2>
      </div>
      {overview.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading relationships" testId="graph-relations-loading" />
      ) : overview.state.status === 'error' ? (
        <ErrorBanner
          error={overview.state.error}
          title={t('无法读取关系类型', 'Could not load the relationship types')}
          onRetry={() => void overview.reload()}
          testId="graph-relations-error"
        />
      ) : overview.state.data.factCountsByLinkType.length === 0 ? (
        <p className="text-3 text-small" data-testid="graph-relations-empty">
          {t(
            '还没有对象之间的关系；采集器或 Worker 写入事实后会出现在这里。',
            'No relationships between Objects yet — a collector run or a Worker result records them.',
          )}
        </p>
      ) : (
        <ul className="graph-relation-list" aria-label={t('关系类型', 'Relationship types')}>
          {overview.state.data.factCountsByLinkType.map((row) => (
            <li key={row.linkType}>
              <button
                type="button"
                className="graph-relation-button"
                aria-pressed={row.linkType === selected}
                onClick={() => onSelect(row.linkType)}
                data-testid="graph-relation"
                data-link-type={row.linkType}
              >
                <span className="mono truncate">{row.linkType}</span>
                <span className="tag" aria-label={t(`${row.count} 条事实`, `${row.count} Facts`)}>
                  {row.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
