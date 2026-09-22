import type { ConflictWire, FactWire } from '@nexttime/shared';
import type { KeyboardEvent } from 'react';
import { shortId } from '../../lib/format.js';
import { freshnessOf } from '../../lib/graph-freshness.js';
import { neighbourId } from '../../lib/graph-view.js';
import { useGraphObjects, useResolvedObjects } from './GraphObjectsContext.js';

export interface NeighbourhoodViewProps {
  readonly objectId: string;
  readonly objectName: string | undefined;
  readonly facts: readonly FactWire[];
  readonly asOf: number;
  readonly conflicts: ReadonlyMap<string, readonly ConflictWire[]>;
  readonly onFocus: (objectId: string) => void;
}

/** Neighbours drawn on the ring; the rest are counted in the centre label. A ring of more is
 *  unreadable at this size — the list below is the complete view. */
export const RING_MAX = 24;

const WIDTH = 520;
const HEIGHT = 360;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const RING_R = 128;
const NODE_R = 12;
const CENTRE_R = 18;
const LABEL_MAX = 16;

function clip(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

interface RingNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Freshness tone of the strongest edge to this neighbour (danger > warn > neutral > ok). */
  readonly edgeTone: string;
  readonly edgeCount: number;
}

const TONE_RANK: Readonly<Record<string, number>> = { danger: 3, warn: 2, neutral: 1, ok: 0 };

/**
 * components/graph/NeighbourhoodView (plan §5.7 "compact neighbourhood picture", optional):
 * the focused Object in the centre and up to `RING_MAX` distinct neighbours on a ring, one edge
 * per neighbour coloured by the worst freshness among the Facts joining them — drawn with inline
 * SVG and a fixed layout (no physics, no dependency: plan §3 "不做"). Each neighbour is a
 * focusable `role="button"` group (Enter / Space / click focuses it — the same action as the list's
 * "展开"), so the picture is a shortcut, never the only path (§5.9 principle 6). Colours come
 * from `styles/graph.css` classes over the semantic tokens; every node also carries its label.
 */
export function NeighbourhoodView({
  objectId,
  objectName,
  facts,
  asOf,
  conflicts,
  onFocus,
}: NeighbourhoodViewProps) {
  const { nameOf } = useGraphObjects();

  const byNeighbour = new Map<string, { tone: string; count: number }>();
  for (const fact of facts) {
    const other = neighbourId(fact, objectId);
    if (other === objectId) continue;
    const tone = freshnessOf(
      {
        lastObservedAt: fact.lastObservedAt,
        supersededAt: fact.supersededAt,
        invalidatedAt: fact.invalidatedAt,
        invalidationReason: fact.invalidationReason,
        epistemicStatus: fact.epistemicStatus,
        inConflict: (conflicts.get(fact.id)?.length ?? 0) > 0,
      },
      asOf,
    ).tone;
    const current = byNeighbour.get(other);
    if (!current) byNeighbour.set(other, { tone, count: 1 });
    else {
      current.count += 1;
      if ((TONE_RANK[tone] ?? 0) > (TONE_RANK[current.tone] ?? 0)) current.tone = tone;
    }
  }
  const all = [...byNeighbour.entries()];
  const shown = all.slice(0, RING_MAX);
  const overflow = all.length - shown.length;
  useResolvedObjects(shown.map(([id]) => id));
  const nodes: RingNode[] = shown.map(([id, edge], index) => {
    const angle = (index / shown.length) * Math.PI * 2 - Math.PI / 2;
    return {
      id,
      x: CX + Math.cos(angle) * RING_R,
      y: CY + Math.sin(angle) * RING_R,
      edgeTone: edge.tone,
      edgeCount: edge.count,
    };
  });

  function onNodeKey(event: KeyboardEvent<SVGGElement>, id: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onFocus(id);
    }
  }

  const centreLabel = objectName ?? shortId(objectId);
  return (
    <figure className="graph-picture" data-testid="graph-picture">
      <svg
        className="graph-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${centreLabel} 与 ${all.length} 个邻居 and ${all.length} neighbours`}
      >
        <title>
          {centreLabel} — {all.length} 邻居 neighbours
        </title>
        {nodes.map((node) => (
          <line
            key={`edge-${node.id}`}
            className={`graph-edge graph-edge-${node.edgeTone}`}
            x1={CX}
            y1={CY}
            x2={node.x}
            y2={node.y}
            strokeWidth={node.edgeCount > 1 ? 2.5 : 1.5}
          />
        ))}
        <g className="graph-node graph-node-centre" data-testid="graph-node-centre">
          <circle cx={CX} cy={CY} r={CENTRE_R} />
          <text x={CX} y={CY + CENTRE_R + 14} textAnchor="middle" className="graph-node-label">
            {clip(centreLabel)}
          </text>
          {overflow > 0 ? (
            <text x={CX} y={CY + 4} textAnchor="middle" className="graph-node-overflow">
              +{overflow}
            </text>
          ) : null}
        </g>
        {nodes.map((node) => {
          const name = nameOf(node.id);
          const label = name ?? shortId(node.id);
          return (
            <g
              key={node.id}
              className={`graph-node graph-node-${node.edgeTone}${name === undefined ? ' graph-node-bare' : ''}`}
              // biome-ignore lint/a11y/useSemanticElements: an SVG node cannot be a <button>; the group carries role / tabIndex / Enter+Space itself, and the same action is a real button in the list below.
              role="button"
              tabIndex={0}
              aria-label={`聚焦 Focus ${label}`}
              data-testid="graph-node"
              data-object-id={node.id}
              onClick={() => onFocus(node.id)}
              onKeyDown={(event) => onNodeKey(event, node.id)}
            >
              <title>
                {label} · {node.edgeCount} facts
              </title>
              <circle cx={node.x} cy={node.y} r={NODE_R} />
              <text
                x={node.x}
                y={node.y + NODE_R + 12}
                textAnchor="middle"
                className="graph-node-label"
              >
                {clip(label)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="text-3 text-small">
        环上最多 {RING_MAX} 个邻居，边色 = 该邻居各事实中最差的新鲜度 · At most {RING_MAX} on the
        ring; edge colour = the worst freshness among the Facts to that neighbour
      </figcaption>
    </figure>
  );
}
