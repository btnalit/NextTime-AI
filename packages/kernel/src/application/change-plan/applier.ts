import type { PoolClient } from 'pg';
import { ChangeApplierNotAPersonError } from './errors.js';

/**
 * I-A1 at run time (STATUS legacy 407; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
 * §3.3): whoever applies or rolls back a ChangePlan segment is a person, never a Handle. The
 * type `ChangeChannel` already says so; this check holds when a caller casts around it, and when
 * a service Principal's API key reaches a segment-writing capability some other way than the
 * registry's `actsForPerson` refusal. `channel` must be `human` (the person's own call) or
 * `platform` (workspace creation on the first owner's behalf), and the Principal named as applier
 * must be a person (`kind = 'human'`) of this workspace. Read inside the applying transaction.
 */
export async function assertChangeApplierIsPerson(
  client: PoolClient,
  workspaceId: string,
  channel: unknown,
  principalId: string,
  action: 'apply' | 'roll_back',
): Promise<void> {
  if (channel !== 'human' && channel !== 'platform') {
    throw new ChangeApplierNotAPersonError(action, `channel ${String(channel)}`);
  }
  const result = await client.query<{ kind: string }>(
    'select kind from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const kind = result.rows[0]?.kind;
  if (kind !== 'human') {
    throw new ChangeApplierNotAPersonError(
      action,
      kind === undefined ? `no principal ${principalId} here` : `a ${kind} principal`,
    );
  }
}
