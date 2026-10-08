/**
 * application/gateway/turn-errors: the Turn-addressing errors shared by `handlers.ts`
 * (`report_turn`, `record_decision`) and `attribution-handlers.ts` (S10 E1). Their own module so
 * a split-out handler file can throw them without importing `handlers.ts` (which imports every
 * handler file — a cycle). Mapped in interfaces/http/capability-route.ts and interfaces/ws/rpc.ts.
 */

export class TurnNotFoundError extends Error {
  constructor(workspaceId: string, turnId: string) {
    super(`Turn not found: workspace ${workspaceId}, id ${turnId}`);
    this.name = 'TurnNotFoundError';
  }
}

/** Thrown by `record_decision` / `record_procedure_followed` when the caller has no
 *  currently-`running` Turn to attribute the record to (`findAttributableTurn`'s recency-window
 *  fallback is deliberately *not* accepted — see `recordDecisionHandler`'s own doc comment for
 *  why). HTTP 409 `no_active_turn`. */
export class NoActiveTurnError extends Error {
  constructor(capability = 'record_decision', what = 'this Decision') {
    super(`${capability}: no currently-running Turn to attribute ${what} to`);
    this.name = 'NoActiveTurnError';
  }
}
