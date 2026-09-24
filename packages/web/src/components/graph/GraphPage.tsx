import type { ConflictWire, FactWire, OntologyTypeWire } from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  conflictsByFactId,
  identityKeysByType,
  isValidInstant,
  objectTypeOptions,
} from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { PageHeader } from '../kit/page-header.js';
import { EmptyState } from '../ui/EmptyState.js';
import { FreshnessLegend } from './FreshnessLegend.js';
import { GraphObjectsProvider } from './GraphObjectsContext.js';
import { ObjectSearch } from './ObjectSearch.js';
import { ObjectView } from './ObjectView.js';
import { ProvenanceDrawer } from './ProvenanceDrawer.js';
import { useGraphQuery } from './useGraphQuery.js';

export interface GraphPageProps {
  readonly http: CapabilityCaller;
}

/** Open Conflicts fetched for the conflict marks — `list_conflicts` has no per-Object filter, so
 *  the page loads one page of open ones and matches by Fact id (a workspace with more open
 *  Conflicts than this shows marks for the first page only; reported as a kernel gap). */
const CONFLICT_PAGE = 200;

/**
 * components/graph/GraphPage: 图谱 Graph (`#/work/graph`, S6-D — docs/console-completion-plan.md
 * §5.7 / §12 item 1): the native object browser replacing the third-party Explorer bundle (which
 * stays as a transition behind the sidebar's secondary link). Search & browse on the left
 * (`ObjectSearch`: `list_types` + `search`), the focused Object on the right (`ObjectView`:
 * `state_at`, neighbours grouped by link type, "展开" walks to a neighbour with a breadcrumb trail,
 * "溯源" opens `ProvenanceDrawer`: `explain`), freshness colouring by `last_observed_at` everywhere
 * (`lib/graph-freshness.ts`, legend at the bottom of the search pane). Navigational state lives in
 * the hash query (`lib/graph-route.ts`): `?objectId=` is the deep link every object `RefChip` in
 * the console can point at; `?q=&type=` is the submitted search; `?at=` is time travel.
 *
 * The "now" every `state_at` call and every freshness age uses is frozen once per page mount
 * (`sessionAt`) and advanced only by "刷新 Refresh" — so walking the trail back is a cache hit and
 * two rows are never coloured against two different clocks.
 */
export function GraphPage({ http }: GraphPageProps) {
  const t = useT();
  const { query, setQuery } = useGraphQuery();
  const [sessionAt, setSessionAt] = useState(() => new Date().toISOString());
  const timeTravel = query.at !== undefined && isValidInstant(query.at);
  const at = timeTravel && query.at !== undefined ? query.at : sessionAt;
  const asOf = Date.parse(at);

  const types = useCapabilityList<OntologyTypeWire>(http, 'list_types', { kind: 'object' });
  const typeRows = types.state.status === 'ready' ? types.state.data.items : undefined;
  const typeOptions = useMemo(
    () => (typeRows ? objectTypeOptions(typeRows) : undefined),
    [typeRows],
  );
  const identityKeys = useMemo(() => identityKeysByType(typeRows ?? []), [typeRows]);

  const conflicts = useCapabilityList<ConflictWire>(http, 'list_conflicts', {
    status: 'open',
    limit: CONFLICT_PAGE,
  });
  const conflictRows = conflicts.state.status === 'ready' ? conflicts.state.data.items : undefined;
  const conflictsByFact = useMemo(() => conflictsByFactId(conflictRows ?? []), [conflictRows]);

  // The focus trail: grows on "展开" / a result click, truncates when a crumb (or Back) is
  // chosen, and is cleared when the reader leaves the object pane. Derived from the hash's
  // `objectId` so a browser Back also walks it.
  const [trail, setTrail] = useState<readonly string[]>([]);
  const objectId = query.objectId;
  useEffect(() => {
    setTrail((prev) => {
      if (objectId === undefined) return prev.length === 0 ? prev : [];
      const index = prev.indexOf(objectId);
      if (index !== -1 && index === prev.length - 1) return prev;
      return index === -1 ? [...prev, objectId] : prev.slice(0, index + 1);
    });
  }, [objectId]);

  const [provenanceFact, setProvenanceFact] = useState<FactWire | null>(null);
  const closeProvenance = useCallback(() => setProvenanceFact(null), []);

  const focus = useCallback(
    (id: string) => setQuery({ ...query, objectId: id }),
    [query, setQuery],
  );
  const back = useCallback(() => {
    const previous = trail.length > 1 ? trail[trail.length - 2] : undefined;
    setQuery({ ...query, objectId: previous });
  }, [query, setQuery, trail]);

  return (
    <div className="page graph-page">
      <PageHeader
        breadcrumb={breadcrumbFor('graph')}
        title={t('图谱', 'Graph')}
        description={t(
          '浏览对象、展开邻居、追溯事实来源；颜色表示新鲜度。',
          'Browse Objects, expand neighbours, trace a Fact’s provenance; colour is freshness.',
        )}
      />
      <GraphObjectsProvider http={http} identityKeys={identityKeys} baseQuery={query}>
        <div className="graph-layout" data-object-open={objectId !== undefined}>
          <aside className="graph-search-pane" aria-label="Search">
            <ObjectSearch
              http={http}
              q={query.q ?? ''}
              type={query.type ?? ''}
              onSubmit={(q, type) =>
                setQuery({ ...query, q: q || undefined, type: type || undefined })
              }
              onOpen={focus}
              selectedId={objectId}
              types={typeOptions}
              identityKeys={identityKeys}
              asOf={asOf}
            />
            <FreshnessLegend />
          </aside>
          <section className="graph-object-pane" aria-label="Object">
            {objectId === undefined ? (
              <EmptyState
                icon="link"
                title={t('选择一个对象', 'Pick an Object')}
                body={t(
                  '左侧搜索或浏览，点击一行查看它的邻居与事实。',
                  'Search or browse on the left; open a row to see its neighbours and Facts.',
                )}
                testId="graph-no-object"
              />
            ) : (
              <ObjectView
                http={http}
                objectId={objectId}
                at={at}
                timeTravel={timeTravel}
                identityKeys={identityKeys}
                conflicts={conflictsByFact}
                trail={trail}
                onFocus={focus}
                onBack={back}
                onProvenance={setProvenanceFact}
                onRefresh={() => setSessionAt(new Date().toISOString())}
                onAsOfChange={(iso) => setQuery({ ...query, at: iso })}
              />
            )}
          </section>
        </div>
        <ProvenanceDrawer
          http={http}
          fact={provenanceFact}
          asOf={asOf}
          conflicts={provenanceFact ? conflictsByFact.get(provenanceFact.id) : undefined}
          onClose={closeProvenance}
        />
      </GraphObjectsProvider>
    </div>
  );
}
