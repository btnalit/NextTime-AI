import { gateOwnedParamsOf } from '@nexttime/gatekeeper-base';
import type { GateOwnedParam } from '@nexttime/gatekeeper-base';

/**
 * governance/gatekeepers/gate-owned-params (legacy J, review of #532): an `http` Operation whose
 * `params_schema` declares a param the gate sets itself — a request header that says who is
 * calling, on whose account or where the call goes, a credential in the query string, a cookie,
 * or a query parameter its binding fixes — is never published. The gate refuses that param on
 * every call that passes it (`@nexttime/gatekeeper-base` `kinds/http.ts`, the same rule), so the
 * definition would offer the agent a param that can only fail, and a `required` one would make
 * the Operation impossible to call. A gate's announced manifest drops them on import
 * (`importOpenApi`); this is the check for a hand-written definition and an older announcement.
 *
 * `publishOperation` refuses (400 `gate_owned_params`); the bulk paths (`publishManifest`,
 * `enable_gate_instance`, the CLI's `register-gatekeeper --publish`) leave such a draft unpublished
 * and report it, so one bad entry does not block the rest of a manifest.
 */

export type { GateOwnedParam };

/** A draft left unpublished by a bulk publish, and the params that kept it back. */
export interface GateOwnedParamDraft {
  readonly name: string;
  readonly params: readonly GateOwnedParam[];
}

export class OperationDeclaresGateOwnedParamsError extends Error {
  readonly code = 'gate_owned_params' as const;
  readonly details: { readonly params: readonly GateOwnedParam[] };
  constructor(id: string, params: readonly GateOwnedParam[]) {
    const named = params.map((entry) => `"${entry.param}" (${entry.location})`).join(', ');
    super(
      `Operation ${id} declares param(s) only the gate sets — ${named} — and the gate refuses them on every call, so it is not published. Remove them from params_schema (the gate authenticates with the credential configured on it, and the binding fixes its own query) and publish that revision; for a gate's own manifest, fix the manifest at the gate.`,
    );
    this.name = 'OperationDeclaresGateOwnedParamsError';
    this.details = { params };
  }
}

/** The gate-owned params `operation` declares — empty for anything but an `http` binding. */
export function gateOwnedParamsOfDefinition(operation: unknown): readonly GateOwnedParam[] {
  return gateOwnedParamsOf(operation);
}

/** Throws `OperationDeclaresGateOwnedParamsError` when `operation` declares any. */
export function assertNoGateOwnedParams(id: string, operation: unknown): void {
  const params = gateOwnedParamsOf(operation);
  if (params.length > 0) throw new OperationDeclaresGateOwnedParamsError(id, params);
}
