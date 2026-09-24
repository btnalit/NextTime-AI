import type { ConflictWire, FactWire } from '@nexttime/shared';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { freshnessOf } from '../../lib/graph-freshness.js';
import { type FactDirection, factDirection, neighbourId } from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../ui/Button.js';
import { RefChip } from '../ui/RefChip.js';
import { FreshnessChip } from './FreshnessChip.js';
import { useGraphObjects, useResolvedObjects } from './GraphObjectsContext.js';

export interface FactRowProps {
  readonly fact: FactWire;
  /** The focused Object — decides which end is "the neighbour". */
  readonly objectId: string;
  readonly asOf: number;
  /** Open Conflicts this Fact is a side of (`lib/graph-view.ts` `conflictsByFactId`). */
  readonly conflicts?: readonly ConflictWire[];
  /** "展开 Expand": focus the neighbour (its own neighbours load; the trail grows). */
  readonly onExpand: (neighbourObjectId: string) => void;
  /** "溯源 Provenance": open the drawer with `explain{nodeId: fact.id}`. */
  readonly onProvenance: (fact: FactWire) => void;
}

const DIRECTION_GLYPH: Readonly<Record<FactDirection, string>> = {
  out: '→',
  in: '←',
  self: '↺',
};

const DIRECTION_LABEL: Readonly<Record<FactDirection, string>> = {
  out: '出 outgoing',
  in: '入 incoming',
  self: '自 self',
};

/**
 * components/graph/FactRow: one Fact (Link) touching the focused Object — direction glyph,
 * the neighbour as a `RefChip` (name from the page's Object cache, bare while unresolved),
 * `epistemicStatus`, `confidence`, validity, freshness (`lib/graph-freshness.ts`, judged as of
 * the page's frozen instant) and the open-Conflict mark, with the two row actions as real
 * buttons (§5.9 principle 6: every row action has a keyboard path — nothing here is a click-only
 * `<li>`). The Fact's own id is copyable through its chip so "溯源" can be cross-checked on the
 * audit page.
 */
export function FactRow({ fact, objectId, asOf, conflicts, onExpand, onProvenance }: FactRowProps) {
  const t = useT();
  const { nameOf, hrefFor } = useGraphObjects();
  const direction = factDirection(fact, objectId);
  const otherId = neighbourId(fact, objectId);
  // Only a rendered row asks for its neighbour's name — collapsed groups cost nothing.
  useResolvedObjects(otherId === objectId ? [] : [otherId]);
  const inConflict = conflicts !== undefined && conflicts.length > 0;
  const freshness = freshnessOf(
    {
      lastObservedAt: fact.lastObservedAt,
      supersededAt: fact.supersededAt,
      invalidatedAt: fact.invalidatedAt,
      invalidationReason: fact.invalidationReason,
      epistemicStatus: fact.epistemicStatus,
      inConflict,
    },
    asOf,
  );
  const clock = fact.lastObservedAt
    ? `观测 Observed ${formatRelative(fact.lastObservedAt, asOf)}`
    : `记录 Recorded ${formatRelative(fact.recordedAt, asOf)}`;
  const validity =
    fact.validUntil === null
      ? `自 from ${formatDateTime(fact.validFrom)}`
      : `${formatDateTime(fact.validFrom)} – ${formatDateTime(fact.validUntil)}`;

  return (
    <li
      className="data-row graph-fact-row"
      data-testid="graph-fact-row"
      data-fact-id={fact.id}
      data-direction={direction}
      data-freshness={freshness.kind}
    >
      <div className="data-row-leading graph-fact-direction" title={DIRECTION_LABEL[direction]}>
        <span aria-hidden>{DIRECTION_GLYPH[direction]}</span>
        <span className="visually-hidden">{DIRECTION_LABEL[direction]}</span>
      </div>
      <div className="data-row-main">
        <div className="data-row-title row-wrap">
          <RefChip
            kind="object"
            id={otherId}
            name={otherId === objectId ? '（自身 self）' : nameOf(otherId)}
            href={otherId === objectId ? undefined : hrefFor(otherId)}
            size="s"
            testId="graph-fact-neighbour"
          />
          <FreshnessChip freshness={freshness} size="s" testId="graph-fact-freshness" />
          {inConflict ? (
            <span className="chip chip-danger chip-s" data-testid="graph-fact-conflict">
              冲突 Conflict ×{conflicts?.length}
            </span>
          ) : null}
        </div>
        <div className="data-row-meta">
          <span className="tag mono" title={t('认知状态', 'Epistemic status')}>
            {fact.epistemicStatus}
          </span>
          {fact.confidence !== null ? (
            <span className="meta-sep" title={t('置信度', 'Confidence')}>
              置信 {fact.confidence.toFixed(2)}
            </span>
          ) : null}
          <span className="meta-sep" title={t('有效期', 'Validity')}>
            {validity}
          </span>
          <span className="meta-sep" title={formatDateTime(fact.lastObservedAt ?? fact.recordedAt)}>
            {clock}
          </span>
          <span className="meta-sep">
            <RefChip kind="object" id={fact.id} name="Fact" size="s" />
          </span>
        </div>
      </div>
      <div className="data-row-trailing">
        <Button
          variant="ghost"
          size="s"
          icon="search"
          onClick={() => onProvenance(fact)}
          data-testid="graph-fact-provenance"
        >
          {t('溯源', 'Provenance')}
        </Button>
        {otherId === objectId ? null : (
          <Button
            variant="ghost"
            size="s"
            icon="chevron-right"
            onClick={() => onExpand(otherId)}
            data-testid="graph-fact-expand"
          >
            {t('展开', 'Expand')}
          </Button>
        )}
      </div>
    </li>
  );
}
