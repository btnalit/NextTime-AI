import type { ConflictWire, FactWire } from '@nexttime/shared';
import { useState } from 'react';
import type { FactDirection, FactGroup } from '../../lib/graph-view.js';
import { Button } from '../ui/Button.js';
import { FactRow } from './FactRow.js';

export interface NeighbourListProps {
  readonly groups: readonly FactGroup[];
  readonly objectId: string;
  readonly asOf: number;
  readonly conflicts: ReadonlyMap<string, readonly ConflictWire[]>;
  readonly onExpand: (neighbourObjectId: string) => void;
  readonly onProvenance: (fact: FactWire) => void;
}

/** Rows shown per group before "显示全部 Show all" — a Host's `runs_on` group can be hundreds of
 *  Containers; keeping the first page short also bounds the neighbour-name lookups. */
export const GROUP_PREVIEW_ROWS = 8;

const DIRECTION_HEADING: Readonly<Record<FactDirection, string>> = {
  out: '→ 出 outgoing',
  in: '← 入 incoming',
  self: '↺ 自 self',
};

/**
 * components/graph/NeighbourList: the focused Object's Facts grouped by link type × direction
 * (`lib/graph-view.ts` `groupFacts`), each group a titled block of `FactRow`s with a preview
 * cut-off. This list is the required view (plan §5.7); `NeighbourhoodView` is the optional
 * picture of the same data.
 */
export function NeighbourList({
  groups,
  objectId,
  asOf,
  conflicts,
  onExpand,
  onProvenance,
}: NeighbourListProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="stack graph-groups" data-testid="graph-neighbour-list">
      {groups.map((group) => {
        const showAll = expanded.has(group.key);
        const rows = showAll ? group.facts : group.facts.slice(0, GROUP_PREVIEW_ROWS);
        const hidden = group.facts.length - rows.length;
        return (
          <section
            key={group.key}
            className="graph-group"
            aria-labelledby={`graph-group-${group.key}`}
            data-testid="graph-group"
            data-link-type={group.linkType}
            data-direction={group.direction}
          >
            <header className="graph-group-head">
              <h3 id={`graph-group-${group.key}`} className="graph-group-title">
                <span className="mono">{group.linkType}</span>
                <span className="text-3"> {DIRECTION_HEADING[group.direction]}</span>
              </h3>
              <span className="tag" aria-label={`${group.facts.length} facts`}>
                {group.facts.length}
              </span>
            </header>
            <ul className="data-list" aria-label={`${group.linkType} ${group.direction}`}>
              {rows.map((fact) => (
                <FactRow
                  key={fact.id}
                  fact={fact}
                  objectId={objectId}
                  asOf={asOf}
                  conflicts={conflicts.get(fact.id)}
                  onExpand={onExpand}
                  onProvenance={onProvenance}
                />
              ))}
            </ul>
            {hidden > 0 ? (
              <div className="graph-group-more">
                <Button
                  variant="ghost"
                  size="s"
                  onClick={() => setExpanded((prev) => new Set(prev).add(group.key))}
                  data-testid="graph-group-show-all"
                >
                  显示全部 Show all ({group.facts.length})
                </Button>
                <span className="text-3">还有 {hidden} 条 more</span>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
