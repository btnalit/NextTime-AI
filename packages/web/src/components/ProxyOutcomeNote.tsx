import type { OutcomeBasis } from '@nexttime/shared';
import { useT } from '../lib/i18n.js';
import { proxyOutcomeNote } from '../lib/labels.js';

/** S11 W1a: next to an outcome on a proxy basis (an agent's own report, a reviewer's assessment),
 *  that it is not counted toward attainment, and what is (`lib/labels` `proxyOutcomeNote`) — both
 *  visible, not only on hover. Renders nothing for the requester's word or a confirmed check. */
export function ProxyOutcomeNote({ basis }: { readonly basis: OutcomeBasis }) {
  const t = useT();
  const note = proxyOutcomeNote(basis, t);
  if (!note) return null;
  return (
    <span className="row-wrap" data-testid="outcome-proxy-note">
      <span className="turn-outcome-basis text-3 text-small">{note.short}</span>
      <span className="text-3 text-small">{note.detail}</span>
    </span>
  );
}
