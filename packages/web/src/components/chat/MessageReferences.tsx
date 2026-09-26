import type { ExplainResultWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { auditHrefForNode } from '../../lib/graph-route.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { extractIdCandidates } from '../../lib/message-references.js';
import { RefChip } from '../kit/ref-chip.js';

export interface MessageReferencesProps {
  readonly http: CapabilityCaller;
  readonly text: string;
}

interface ResolvedReference {
  readonly id: string;
  readonly nodeType: ExplainResultWire['nodeType'];
  readonly name: string | null;
  /** `undefined` suppresses `kit/ref-chip`'s own `(typeName)` suffix — used for an Activity, whose
   *  `name` is already a human label standing in for both (see `labelFor`'s own doc comment). */
  readonly typeName: string | undefined;
}

/** A short label for the chip — the same fields `ProvenanceChain`/`ExplainSection` already use to
 *  name a Fact/Decision, so a reference chip here and the same node's own segment on the audit page
 *  read consistently. An Activity has no such field to fall back on — before console redesign P3-2
 *  this rendered the raw wire `activity.kind` (e.g. "agent_turn") as the chip's name, plus
 *  `nodeType` ("activity") as its type suffix, together reading as an internal implementation
 *  detail ("agent_turn (activity)", the V3 finding) rather than something a reader recognizes; a
 *  translated human label replaces both parts (`typeName: undefined` suppresses the suffix `kit/
 *  ref-chip` would otherwise add), falling back to a generic "活动记录" for any kind other than the
 *  one this app currently produces on a chat's own timeline. */
function labelFor(
  result: ExplainResultWire,
  t: Translate,
): { readonly name: string | null; readonly typeName: string | undefined } {
  if (result.fact) return { name: result.fact.linkType, typeName: result.nodeType };
  if (result.decision) return { name: result.decision.summary, typeName: result.nodeType };
  if (result.activity) {
    return {
      name:
        result.activity.kind === 'agent_turn'
          ? t('本轮记录', 'This turn')
          : t('活动记录', 'Activity record'),
      typeName: undefined,
    };
  }
  return { name: null, typeName: result.nodeType };
}

/**
 * components/chat/MessageReferences (S8 W4-A, journey ④ / ui-audit J8): renders every id-shaped
 * token in a persisted assistant message's text that `explain` actually recognises (a Fact,
 * Decision, or Activity — the id resolves via `explain{nodeId}`, not merely "looks like a uuid")
 * as a clickable `kit/ref-chip` into 审计 Audit's `explain` view (`auditHrefForNode`) — journey
 * ④'s own "从一句具体回复出发...点击追溯到审计页并看到完整来源链".
 *
 * Verifies before rendering (`explain` must actually succeed) rather than rendering every
 * id-shaped substring as if it were a known reference — an id `explain` does not recognise (never
 * called by this workspace, a hallucinated-looking token, unrelated content) renders nothing,
 * which is also exactly journey ④'s own "空" state: a reply that names no real Fact/Decision/
 * Activity offers no trace entry at all, not a dead link into an empty `explain`. A Fact that was
 * since superseded/invalidated still resolves (explain answers truthfully — its own
 * `invalidatedAt`/`invalidationReason` — journey ④'s "错" state), it is only an unrecognised id
 * that renders nothing.
 */
export function MessageReferences({ http, text }: MessageReferencesProps) {
  const t = useT();
  const idsKey = extractIdCandidates(text).join(',');
  const [resolved, setResolved] = useState<readonly ResolvedReference[]>([]);

  // `t` is read at resolve time only (a language switch mid-flight is not worth a re-resolve);
  // `idsKey`/`http` are the real triggers, same as before this file computed labels at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',');
    if (ids.length === 0) {
      setResolved([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const settled = await Promise.allSettled(
        ids.map((id) => http.call<ExplainResultWire>('explain', { nodeId: id })),
      );
      if (cancelled) return;
      const next: ResolvedReference[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status !== 'fulfilled') return;
        const label = labelFor(outcome.value, t);
        next.push({
          id: ids[index] as string,
          nodeType: outcome.value.nodeType,
          name: label.name,
          typeName: label.typeName,
        });
      });
      setResolved(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [http, idsKey]);

  if (resolved.length === 0) return null;

  return (
    <div className="row-wrap message-references" data-testid="message-references">
      <span className="text-3 text-small">{t('引用', 'References')}</span>
      {resolved.map((ref) => (
        <RefChip
          key={ref.id}
          kind="object"
          id={ref.id}
          name={ref.name ?? ref.nodeType}
          typeName={ref.typeName}
          href={auditHrefForNode(ref.id)}
          size="s"
          testId={`message-reference-${ref.id}`}
        />
      ))}
    </div>
  );
}
