import { describe, expect, it } from 'vitest';
import { NoActiveTurnError, TurnNotFoundError } from '../../application/gateway/handlers.js';
import {
  ConflictNotFoundError,
  DecisionNotFoundError,
  ExplainNodeNotFoundError,
  FactHasNoEvidenceError,
  FactNotFoundError,
  OntologyChangeValidationError,
  OntologyDraftNotFoundError,
  SupersedeIdentityMismatchError,
} from '../../application/gateway/index.js';
import { TaskRuntimeNotConfiguredError } from '../../application/task/index.js';
import { HandleIssuanceError, ScopeValidationError } from '../../governance/capability/index.js';
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

describe('mapDispatchError — lane-4 P2 fix: previously-unmapped error classes → 500', () => {
  it('TurnNotFoundError (report_turn) maps to NOT_FOUND (-32004), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new TurnNotFoundError('ws-1', 'turn-1'));
    expect(mapped.code).toBe(WS_ERROR_CODES.NOT_FOUND);
  });

  it('NoActiveTurnError (record_decision) maps to ILLEGAL_TRANSITION (-32011), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new NoActiveTurnError());
    expect(mapped.code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);
  });

  it('ScopeValidationError (invoke_worker Handle mint) maps to INVALID_PARAMS (-32602), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new ScopeValidationError('unknown capability "bogus"'));
    expect(mapped.code).toBe(WS_ERROR_CODES.INVALID_PARAMS);
  });
});

describe('mapDispatchError — review fix F10: previously-unmapped error classes → 500', () => {
  it('HandleIssuanceError (invoke_worker Handle mint) maps to INVALID_PARAMS (-32602), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new HandleIssuanceError('ttlSeconds must be positive'));
    expect(mapped.code).toBe(WS_ERROR_CODES.INVALID_PARAMS);
  });

  it('TaskRuntimeNotConfiguredError (invoke_worker) maps to SERVICE_UNAVAILABLE (-32015), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new TaskRuntimeNotConfiguredError());
    expect(mapped.code).toBe(WS_ERROR_CODES.SERVICE_UNAVAILABLE);
  });
});

describe('mapDispatchError — lane-4 hookup: ExplainNodeNotFoundError (explain)', () => {
  it('maps to NOT_FOUND (-32004), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new ExplainNodeNotFoundError('fact', 'ws-1', 'fact-1'));
    expect(mapped.code).toBe(WS_ERROR_CODES.NOT_FOUND);
  });
});

describe('mapDispatchError — error-mapping followup: previously-unmapped S3.1/S3.2/S3.3 error classes → 500', () => {
  it('OntologyChangeValidationError (propose_ontology_change) maps to INVALID_PARAMS (-32602), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new OntologyChangeValidationError([{ path: ['x'] }]));
    expect(mapped.code).toBe(WS_ERROR_CODES.INVALID_PARAMS);
  });

  it('OntologyDraftNotFoundError (publish_ontology_version) maps to NOT_FOUND (-32004), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new OntologyDraftNotFoundError('ont-1', 2));
    expect(mapped.code).toBe(WS_ERROR_CODES.NOT_FOUND);
  });

  it('ConflictNotFoundError (resolve_conflict/list_conflicts) maps to NOT_FOUND (-32004), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new ConflictNotFoundError('ws-1', 'conflict-1'));
    expect(mapped.code).toBe(WS_ERROR_CODES.NOT_FOUND);
  });

  it('DecisionNotFoundError (causal_chain/decision_impact) maps to NOT_FOUND (-32004), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new DecisionNotFoundError('ws-1', 'decision-1'));
    expect(mapped.code).toBe(WS_ERROR_CODES.NOT_FOUND);
  });

  it('FactNotFoundError (supersede_fact/invalidate_fact/verify_fact) maps to NOT_FOUND (-32004), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new FactNotFoundError('ws-1', 'fact-1'));
    expect(mapped.code).toBe(WS_ERROR_CODES.NOT_FOUND);
  });

  it('SupersedeIdentityMismatchError (supersede_fact, I5) maps to INVALID_PARAMS (-32602), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new SupersedeIdentityMismatchError('ws-1', 'fact-1'));
    expect(mapped.code).toBe(WS_ERROR_CODES.INVALID_PARAMS);
  });

  it('FactHasNoEvidenceError (verify_fact, I3.6) maps to ILLEGAL_TRANSITION (-32011), not INTERNAL_ERROR', () => {
    const mapped = mapDispatchError(new FactHasNoEvidenceError('fact-1'));
    expect(mapped.code).toBe(WS_ERROR_CODES.ILLEGAL_TRANSITION);
  });
});
