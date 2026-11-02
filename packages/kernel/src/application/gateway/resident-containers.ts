import { getConfiguredTaskRuntime } from '../task/runtime.js';

/**
 * application/gateway/resident-containers: asking worker-supervisor to stop people's resident
 * containers once what they may do has already been taken away in a committed transaction.
 *
 * A person has an entry container per membership and, as a platform administrator in a trial
 * workspace, an admin agent container beside it (S11 AA4c-2; worker-supervisor `resident-kind.ts`).
 * Both run under Handles: every caller here has already revoked them, so a container that survives
 * (worker-supervisor unreachable, no runtime configured in a unit test) can no longer act — the stop
 * only reclaims its resources sooner. Never throws.
 */

/** Which of a person's resident containers to stop. */
export type ResidentContainerKind = 'entry' | 'admin_agent';

export const EVERY_RESIDENT_CONTAINER_KIND: readonly ResidentContainerKind[] = [
  'entry',
  'admin_agent',
];

/** Best-effort, after commit: `POST /resident/stop` for each principal and kind (design §8). The
 *  entry container's call is the one every release has sent; the admin agent's names its kind. */
export async function stopResidentContainers(
  principalIds: readonly string[],
  kinds: readonly ResidentContainerKind[],
): Promise<void> {
  if (principalIds.length === 0 || kinds.length === 0) return;
  let stop: ((principalId: string, agentKind?: 'admin_agent') => Promise<boolean>) | undefined;
  try {
    const client = getConfiguredTaskRuntime().supervisorClient;
    stop = client.stopResident?.bind(client);
  } catch {
    return; // no task runtime configured (unit tests / CLI) — nothing to stop
  }
  if (!stop) return;
  for (const principalId of principalIds) {
    for (const kind of kinds) {
      try {
        await (kind === 'entry' ? stop(principalId) : stop(principalId, kind));
      } catch {
        // Logged nowhere on purpose: the failure carries no state the platform relies on.
      }
    }
  }
}
