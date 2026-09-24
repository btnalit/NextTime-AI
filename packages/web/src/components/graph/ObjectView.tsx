import type { ConflictWire, FactWire, ObjectWire } from '@nexttime/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime } from '../../lib/format.js';
import { groupFacts, isoToLocalInput, localInputToIso } from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { useGraphObjects, useResolvedObjects } from './GraphObjectsContext.js';
import { NeighbourList } from './NeighbourList.js';
import { NeighbourhoodView } from './NeighbourhoodView.js';
import { ObjectCard } from './ObjectCard.js';

export interface ObjectViewProps {
  readonly http: CapabilityCaller;
  readonly objectId: string;
  /** The frozen `state_at{at}` instant (ISO) — the page's session instant, or `?at=`. */
  readonly at: string;
  /** `true` when `at` came from the reader's "截至 As of" input rather than the session clock. */
  readonly timeTravel: boolean;
  readonly identityKeys: ReadonlyMap<string, readonly string[]>;
  readonly conflicts: ReadonlyMap<string, readonly ConflictWire[]>;
  /** The focus trail (Object ids, oldest first, the current one last) — breadcrumb chips. */
  readonly trail: readonly string[];
  readonly onFocus: (objectId: string) => void;
  readonly onBack: () => void;
  readonly onProvenance: (fact: FactWire) => void;
  readonly onRefresh: () => void;
  readonly onAsOfChange: (atIso: string | undefined) => void;
}

interface StateAtResult {
  readonly object: ObjectWire | null;
  readonly facts: readonly FactWire[];
}

/**
 * components/graph/ObjectView (plan §5.7 "Object view"): the focused Object — header card,
 * the neighbourhood picture (optional, toggleable) and the required grouped Fact list — from one
 * `state_at{objectId, at}` call. Why `state_at` and not `get_object` + `traverse`: `traverse`'s
 * wire result is ids only (`{nodes, edges:{linkId, linkType, source, target, depth}}`, no
 * `epistemicStatus` / `confidence` / validity / `lastObservedAt`, and no `direction` param on the
 * wire) — the Fact row the plan asks for cannot be rendered from it; `state_at` returns the Object
 * (same query as `get_object`) plus every Fact touching it as full `FactWire` rows, which at
 * `at = now` is exactly `traverse` depth 1's active set. The same call with a different `at` is
 * the "截至 As of" time travel (§5.7 item 5), so that comes for free. `at` is frozen by the page
 * (`useCapability` keys its cache on the serialized params — a per-render `new Date()` would
 * reload forever), so going back along the trail renders from cache at once and only revalidates
 * in the background.
 */
export function ObjectView({
  http,
  objectId,
  at,
  timeTravel,
  identityKeys,
  conflicts,
  trail,
  onFocus,
  onBack,
  onProvenance,
  onRefresh,
  onAsOfChange,
}: ObjectViewProps) {
  const t = useT();
  const state = useCapability<StateAtResult>(http, 'state_at', { objectId, at });
  const { prime, nameOf } = useGraphObjects();
  const asOf = useMemo(() => Date.parse(at), [at]);
  const [showPicture, setShowPicture] = useState(true);
  const [draftAt, setDraftAt] = useState(() => (timeTravel ? isoToLocalInput(at) : ''));
  useEffect(() => setDraftAt(timeTravel ? isoToLocalInput(at) : ''), [at, timeTravel]);

  const data = state.state.status === 'ready' ? state.state.data : undefined;
  useEffect(() => {
    if (data?.object) prime([data.object]);
  }, [data, prime]);
  // Earlier crumbs need names; the current Object is primed from `state_at` above, so it is
  // excluded here rather than fetched a second time on a deep link.
  const previousCrumbs = useMemo(() => trail.slice(0, -1), [trail]);
  useResolvedObjects(previousCrumbs);

  const groups = useMemo(() => (data ? groupFacts(data.facts, objectId) : []), [data, objectId]);

  function applyAsOf(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onAsOfChange(localInputToIso(draftAt));
  }

  const objectName = data?.object ? nameOf(data.object.id) : undefined;

  return (
    <div
      className="stack graph-object-view"
      data-testid="graph-object-view"
      data-object-id={objectId}
    >
      <nav className="graph-trail" aria-label="Focus trail" data-testid="graph-trail">
        <Button
          variant="ghost"
          size="s"
          icon="arrow-left"
          onClick={onBack}
          data-testid="graph-back"
        >
          {trail.length > 1 ? t('返回', 'Back') : t('返回搜索', 'Back to search')}
        </Button>
        <ol className="graph-trail-list">
          {trail.map((id, index) => {
            const last = index === trail.length - 1;
            const name = nameOf(id);
            return (
              <li key={id} className="graph-trail-item">
                {last ? (
                  <RefChip
                    kind="object"
                    id={id}
                    name={name}
                    size="s"
                    testId="graph-trail-current"
                  />
                ) : (
                  <button
                    type="button"
                    className="graph-trail-link"
                    onClick={() => onFocus(id)}
                    data-testid="graph-trail-link"
                  >
                    {name ?? <span className="mono">{id.slice(0, 8)}</span>}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {timeTravel ? (
        <Notice tone="warn" testId="graph-as-of-notice">
          {t('截至', 'As of')}
          <time className="mono">{formatDateTime(at)}</time>{' '}
          {t(
            '— 显示当时有效的事实；之后被替代或失效的仍按当时状态着色。',
            'Showing the Facts valid at that instant; later supersessions / invalidations do not change their colour here.',
          )}
        </Notice>
      ) : null}

      {state.state.status === 'loading' ? (
        <SkeletonRows count={6} label="Loading object" testId="graph-object-loading" />
      ) : state.state.status === 'error' ? (
        <ErrorBanner
          error={state.state.error}
          title={t('无法读取对象', 'Could not load this Object')}
          onRetry={() => void state.reload()}
          testId="graph-object-error"
        />
      ) : state.state.data.object === null ? (
        <EmptyState
          icon="search"
          title={t('对象不存在或不可见', 'Object not found or not visible')}
          body={
            <span className="row-wrap">
              <RefChip kind="object" id={objectId} size="s" />
              <span>
                {t(
                  '可能已被清除，或属于你看不到的私有来源。',
                  'It may have been purged, or belong to a private Source you cannot see.',
                )}
              </span>
            </span>
          }
          action={
            <Button variant="secondary" size="s" onClick={onBack}>
              {t('返回', 'Back')}
            </Button>
          }
          testId="graph-object-missing"
        />
      ) : (
        <>
          <ObjectCard
            object={state.state.data.object}
            identityKeys={identityKeys.get(state.state.data.object.objectType)}
            asOf={asOf}
            testId="graph-object-card"
            actions={
              <>
                <form className="graph-as-of" onSubmit={applyAsOf} data-testid="graph-as-of-form">
                  <Field id="graph-as-of" label={t('截至', 'As of')}>
                    <Input
                      id="graph-as-of"
                      type="datetime-local"
                      value={draftAt}
                      onChange={(event) => setDraftAt(event.target.value)}
                      data-testid="graph-as-of-input"
                    />
                  </Field>
                  <Button type="submit" size="s" variant="secondary" disabled={draftAt === ''}>
                    {t('应用', 'Apply')}
                  </Button>
                  {timeTravel ? (
                    <Button
                      size="s"
                      variant="ghost"
                      onClick={() => onAsOfChange(undefined)}
                      data-testid="graph-as-of-now"
                    >
                      {t('现在', 'Now')}
                    </Button>
                  ) : null}
                </form>
                <Button
                  size="s"
                  variant="ghost"
                  icon="refresh"
                  onClick={onRefresh}
                  loading={state.state.refreshing}
                  data-testid="graph-refresh"
                >
                  {t('刷新', 'Refresh')}
                </Button>
              </>
            }
          />

          {state.state.refreshError !== null ? (
            <ErrorBanner
              error={state.state.refreshError}
              title={t('刷新失败', 'Refresh failed')}
              onRetry={() => void state.reload()}
            />
          ) : null}

          <section className="section" aria-labelledby="graph-facts-title">
            <div className="section-header">
              <h2 id="graph-facts-title">
                {t('邻居与事实', 'Neighbours & Facts')}{' '}
                <span className="text-3 text-small" data-testid="graph-fact-count">
                  ({state.state.data.facts.length})
                </span>
              </h2>
              {state.state.data.facts.length > 0 ? (
                <Button
                  size="s"
                  variant="ghost"
                  onClick={() => setShowPicture((value) => !value)}
                  aria-pressed={showPicture}
                  data-testid="graph-toggle-picture"
                >
                  {showPicture ? t('隐藏图示', 'Hide picture') : t('显示图示', 'Show picture')}
                </Button>
              ) : null}
            </div>
            {state.state.data.facts.length === 0 ? (
              <EmptyState
                icon="link"
                title={t('没有关联事实', 'No Facts touch this Object')}
                body={
                  timeTravel
                    ? t('在该时刻没有有效的事实。', 'Nothing was valid at that instant.')
                    : t(
                        '采集器或 Worker 写入的关系会出现在这里。',
                        'Relations a collector or Worker writes appear here.',
                      )
                }
                testId="graph-facts-empty"
              />
            ) : (
              <>
                {showPicture ? (
                  <NeighbourhoodView
                    objectId={objectId}
                    objectName={objectName}
                    facts={state.state.data.facts}
                    asOf={asOf}
                    conflicts={conflicts}
                    onFocus={onFocus}
                  />
                ) : null}
                <NeighbourList
                  groups={groups}
                  objectId={objectId}
                  asOf={asOf}
                  conflicts={conflicts}
                  onExpand={onFocus}
                  onProvenance={onProvenance}
                />
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
