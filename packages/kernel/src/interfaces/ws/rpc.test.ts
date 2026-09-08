import { describe, expect, it } from 'vitest';
import { OperationIdentityConflictError } from '../../governance/gatekeepers/index.js';
import { WS_ERROR_CODES, mapDispatchError } from './rpc.js';

/**
 * interfaces/ws/rpc.test: unit coverage for `mapDispatchError` (pure — no IO, no DB), mirroring
 * interfaces/http/capability-route.test.ts's `mapCapabilityError` suite. Scoped to the review
 * 2026-09 addition (docs/development-tasks.md S2.4 "实现说明补充") — `OperationIdentityConflictError`
 * is the one class this task added a branch for; the rest of `mapDispatchError`'s ~30 branches are
 * exercised indirectly through the existing HTTP-side unit tests and the WS integration tests, not
 * duplicated here.
 */

describe('mapDispatchError — OperationIdentityConflictError (review 2026-09, P0)', () => {
  it('maps to ILLEGAL_TRANSITION (-32011), the same state-conflict code as IllegalTransition', () => {
    const mapped = mapDispatchError(
      new OperationIdentityConflictError('gk-1', 'container.restart', 'published'),
    );
    expect(mapped.code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);
    expect(mapped.message).toContain('container.restart');
  });
});
