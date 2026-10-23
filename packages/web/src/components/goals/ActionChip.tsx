import { useCanOpen } from '../../hooks/useCanOpen.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { hrefs } from '../../lib/router.js';
import { RefChip } from '../kit/ref-chip.js';

/** An action of a goal (its ActionRequest) as a chip, linking to its approval only where the
 *  reader's role opens the approval queue (`hooks/useCanOpen`) — a member who asked for the goal
 *  sees the chip without a dead link. `name`: the action's kind, when the caller already has it
 *  (otherwise the chip reads it). */
export function ActionChip({
  actionRequestId,
  name,
  http,
}: {
  readonly actionRequestId: string;
  readonly name?: string;
  readonly http: CapabilityCaller;
}) {
  const canOpen = useCanOpen();
  const href = hrefs.approval(actionRequestId);
  return (
    <RefChip
      kind="actionRequest"
      id={actionRequestId}
      name={name}
      http={http}
      href={canOpen(href) !== false ? href : undefined}
      size="s"
    />
  );
}
