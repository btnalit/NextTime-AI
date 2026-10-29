import type { ObservationAbsenceCheck, OperationSummaryWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { absenceOperationKey } from '../../lib/goals.js';

/** An Operation whose read failed (review #501 on #780) — told apart from one that has no
 *  published version, which the platform cannot make the check on. */
export const ABSENCE_OPERATION_UNREADABLE = 'unreadable';

/** What is known of the Operation an absence check calls: its published version, `null` when it
 *  has none, or {@link ABSENCE_OPERATION_UNREADABLE}. */
export type AbsenceOperation = OperationSummaryWire | null | typeof ABSENCE_OPERATION_UNREADABLE;

/** By `absenceOperationKey`; a key not in the map is still being read. */
export type AbsenceOperations = ReadonlyMap<string, AbsenceOperation>;

const NONE: AbsenceOperations = new Map();

/**
 * components/goals/useAbsenceOperations (S11 「门确认不存在」 B): for each absence check, the
 * version in force of the Operation it calls — which of the target's answers it declares mean "not
 * there", and who confirmed, publishing it, that the gate's credentials can see what it looks up.
 * The kernel asks both of that version each time it makes the check, so the page shows them beside
 * it (`AbsenceBasis`). One `list_operations{gatekeeperId, q}` read per Operation (a plan names a
 * few).
 */
export function useAbsenceOperations(
  http: CapabilityCaller,
  checks: readonly Pick<ObservationAbsenceCheck, 'gatekeeperId' | 'operation'>[],
): AbsenceOperations {
  const key = [...new Set(checks.map(absenceOperationKey))].sort().join('\n');
  const [operations, setOperations] = useState<AbsenceOperations>(NONE);
  useEffect(() => {
    if (key === '') return;
    let live = true;
    void Promise.all(
      key.split('\n').map(async (name): Promise<readonly [string, AbsenceOperation]> => {
        // A gatekeeper id is a UUID: the first `::` ends it.
        const at = name.indexOf('::');
        const gatekeeperId = name.slice(0, at);
        const operation = name.slice(at + 2);
        try {
          // `q` matches a substring of the name: walk the pages until the name itself shows up.
          let cursor: string | undefined;
          do {
            const page = await http.call<{
              readonly items: readonly OperationSummaryWire[];
              readonly nextCursor?: string;
            }>('list_operations', {
              gatekeeperId,
              q: operation,
              ...(cursor ? { cursor } : {}),
            });
            const published = page.items.find(
              (row) => row.name === operation && row.status === 'published',
            );
            if (published) return [name, published] as const;
            cursor = page.nextCursor === cursor ? undefined : page.nextCursor;
          } while (cursor !== undefined);
          return [name, null] as const;
        } catch {
          // Not "none": the check's line says the read failed, not that the check cannot be made.
          return [name, ABSENCE_OPERATION_UNREADABLE] as const;
        }
      }),
    ).then((rows) => {
      if (live) setOperations(new Map(rows));
    });
    return () => {
      live = false;
    };
  }, [http, key]);
  return key === '' ? NONE : operations;
}
