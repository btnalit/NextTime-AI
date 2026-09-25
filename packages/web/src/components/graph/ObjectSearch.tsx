import type { ObjectWire, OntologyObjectTypeWire } from '@nexttime/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { groupObjectsByType } from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../ui/Button.js';
import { DataList } from '../ui/DataList.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input } from '../ui/Field.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { useGraphObjects } from './GraphObjectsContext.js';
import { ObjectRow } from './ObjectCard.js';
import { TypeFilter } from './TypeFilter.js';

export interface ObjectSearchProps {
  readonly http: CapabilityCaller;
  /** The submitted query (from the hash) — the form's drafts follow it. */
  readonly q: string;
  readonly type: string;
  readonly onSubmit: (q: string, type: string) => void;
  readonly onOpen: (objectId: string) => void;
  readonly selectedId?: string;
  readonly types: readonly OntologyObjectTypeWire[] | undefined;
  readonly identityKeys: ReadonlyMap<string, readonly string[]>;
  readonly asOf: number;
}

/** Page size for `search` (kernel default 50, max 200 — a shorter page keeps the left pane
 *  scannable; "加载更多" follows `nextCursor`). */
export const SEARCH_PAGE_SIZE = 25;

/**
 * components/graph/ObjectSearch (plan §5.7 "Search & browse"): type filter (`list_types`) + text
 * query → `search{query, objectType?, limit, cursor}` (keyset "加载更多 Load more", leftover 2),
 * results as `ObjectRow`s. An empty query is a valid browse — the kernel's substring match is
 * `%%`, i.e. the workspace's most recently updated Objects — so the landing view is never blank.
 * Three states in the console's own pattern (`SkeletonRows` / `ErrorBanner` + Retry / `EmptyState`).
 */
export function ObjectSearch({
  http,
  q,
  type,
  onSubmit,
  onOpen,
  selectedId,
  types,
  identityKeys,
  asOf,
}: ObjectSearchProps) {
  const t = useT();
  const [draftQ, setDraftQ] = useState(q);
  const [draftType, setDraftType] = useState(type);
  useEffect(() => setDraftQ(q), [q]);
  useEffect(() => setDraftType(type), [type]);

  const params = useMemo(
    () => ({
      query: q,
      ...(type !== '' ? { objectType: type } : {}),
      limit: SEARCH_PAGE_SIZE,
    }),
    [q, type],
  );
  const results = useCapabilityList<ObjectWire>(http, 'search', params);
  const { prime } = useGraphObjects();
  const items = results.state.status === 'ready' ? results.state.data.items : undefined;
  useEffect(() => {
    if (items) prime(items);
  }, [items, prime]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit(draftQ.trim(), draftType);
  }

  const browsing = q === '' && type === '';
  // S8 W4 (audit G2): only the unfiltered browse page groups by type — a type-filtered or
  // text-searched result is already one group (`lib/graph-view.ts`'s own doc comment).
  const groups = useMemo(
    () => (browsing && items ? groupObjectsByType(items) : undefined),
    [browsing, items],
  );

  return (
    <div className="stack graph-search" data-testid="graph-search">
      <form
        className="inline-form row-wrap"
        onSubmit={handleSubmit}
        data-testid="graph-search-form"
      >
        <TypeFilter id="graph-type" value={draftType} onChange={setDraftType} types={types} />
        {/* S8 W4 (audit G3 "查询/类型表单上下错位"): the hint used to live inside this `Field`
         *  (`ui/Field`'s own `hint` slot renders below the control), so the Query field's block was
         *  taller than the Type field's — `.inline-form`'s `align-items: flex-end` then bottom-
         *  aligned the two blocks, leaving the Type select visibly higher than the Query input. The
         *  hint now renders once, below the whole row, so both `Field`s are the same height
         *  (label + control only) and line up. */}
        <Field id="graph-q" label={t('关键字', 'Query')}>
          <Input
            id="graph-q"
            value={draftQ}
            onChange={(event) => setDraftQ(event.target.value)}
            placeholder="web / 192.0.2.1 / sha256:…"
            data-testid="graph-q"
          />
        </Field>
        <Button type="submit" variant="primary" icon="search" data-testid="graph-search-submit">
          {t('搜索', 'Search')}
        </Button>
      </form>
      <p className="field-hint" id="graph-q-hint">
        {t('按属性与身份子串匹配', 'Substring over properties / identity')}
      </p>

      <div className="section-header">
        <h2 className="section-title">
          {browsing ? t('最近更新', 'Recently updated') : t('结果', 'Results')}
        </h2>
        {results.state.status === 'ready' ? (
          <span className="text-3 text-small" data-testid="graph-result-count">
            {results.state.data.items.length}
            {results.state.data.nextCursor !== undefined ? '+' : ''}
          </span>
        ) : null}
      </div>

      {results.state.status === 'loading' ? (
        <SkeletonRows count={5} label="Loading objects" testId="graph-results-loading" />
      ) : results.state.status === 'error' ? (
        <ErrorBanner
          error={results.state.error}
          title={t('无法搜索对象', 'Could not search Objects')}
          onRetry={() => void results.reload()}
          testId="graph-results-error"
        />
      ) : results.state.data.items.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('没有匹配的对象', 'No matching Objects')}
          body={
            browsing
              ? t(
                  '该工作区还没有对象；采集器或 Worker 写入后会出现在这里。',
                  'The workspace has no Objects yet — a collector run or a Worker result creates them.',
                )
              : t('换一个关键字或类型。', 'Try another query or type.')
          }
          testId="graph-results-empty"
        />
      ) : (
        <>
          {results.state.refreshError !== null ? (
            <ErrorBanner
              error={results.state.refreshError}
              title={t('刷新失败', 'Refresh failed')}
              onRetry={() => void results.reload()}
            />
          ) : null}
          {groups && groups.length > 1 ? (
            // S8 W4 (audit G2): the unfiltered browse page, grouped by type — see
            // `lib/graph-view.ts`'s `groupObjectsByType` for why. One outer `graph-results`
            // testid (not one per group) so `e2e/graph.spec.ts`'s
            // `getByTestId('graph-results').toBeVisible()` still matches exactly one element.
            <div className="stack" aria-label="Objects" data-testid="graph-results">
              {groups.map((group) => (
                <div key={group.objectType} className="stack-s">
                  <div className="graph-type-group-header">
                    <span className="tag graph-type-tag">{group.objectType}</span>
                    <span className="text-3 text-small">{group.objects.length}</span>
                  </div>
                  <DataList ariaLabel={group.objectType}>
                    {group.objects.map((object) => (
                      <ObjectRow
                        key={object.id}
                        object={object}
                        identityKeys={identityKeys.get(object.objectType)}
                        asOf={asOf}
                        onOpen={onOpen}
                        selected={object.id === selectedId}
                        testId="graph-result-row"
                      />
                    ))}
                  </DataList>
                </div>
              ))}
            </div>
          ) : (
            <DataList ariaLabel="Objects" testId="graph-results">
              {results.state.data.items.map((object) => (
                <ObjectRow
                  key={object.id}
                  object={object}
                  identityKeys={identityKeys.get(object.objectType)}
                  asOf={asOf}
                  onOpen={onOpen}
                  selected={object.id === selectedId}
                  testId="graph-result-row"
                />
              ))}
            </DataList>
          )}
          {results.loadMoreError !== null ? (
            <ErrorBanner
              error={results.loadMoreError}
              title={t('无法加载更多', 'Could not load more')}
            />
          ) : null}
          {results.state.data.nextCursor !== undefined ? (
            <div className="row">
              <Button
                variant="secondary"
                size="s"
                loading={results.loadingMore}
                onClick={() => void results.loadMore()}
                data-testid="graph-load-more"
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
