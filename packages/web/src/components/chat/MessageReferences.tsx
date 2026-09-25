import type { ExplainResultWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { auditHrefForNode } from '../../lib/graph-route.js';
import { useT } from '../../lib/i18n.js';
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
}

/** A short label for the chip — the same fields `ProvenanceChain`/`ExplainSection` already use to
 *  name a Fact/Decision/Activity, so a reference chip here and the same node's own segment on the
 *  audit page read consistently. */
function labelFor(result: ExplainResultWire): string | null {
  if (result.fact) return result.fact.linkType;
  if (result.decision) return result.decision.summary;
  return result.activity?.kind ?? null;
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
        next.push({
          id: ids[index] as string,
          nodeType: outcome.value.nodeType,
          name: labelFor(outcome.value),
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
          typeName={ref.nodeType}
          href={auditHrefForNode(ref.id)}
          size="s"
          testId={`message-reference-${ref.id}`}
        />
      ))}
    </div>
  );
}
