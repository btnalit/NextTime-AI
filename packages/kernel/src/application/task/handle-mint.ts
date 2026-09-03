import type { CapabilityChannel, HandleClaims, Role } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import {
  type CapabilityScope,
  type IssuedHandle,
  WORKER_CEILING_CAPABILITIES,
  WORKER_INFRASTRUCTURE_CAPABILITY_NAMES,
  assertScopeIsSubset,
  assertValidScope,
  isExecuteClassCapability,
  issueHandle,
} from '../../governance/capability/index.js';
import { InvokeWorkerAttenuationError, InvokeWorkerValidationError } from './types.js';

/**
 * application/task/handle-mint: mints the child CapabilityHandle a WorkerRun holds (design doc
 * §5.1.4 "子 Handle 是自身 Handle 的衰减", §5.2 `WR -->|holds| H2[child Handle ⊂ H]`, §5.4 I13;
 * docs/development-tasks.md S2.7 acceptance "入口 Handle 请求含 execute 的子 Handle 被拒").
 *
 * **Why this does not call `governance/capability/handles.ts`'s `attenuate()`:** `attenuate`
 * mints a child bound to the *same session* as the parent ("attenuation narrows scope, it does
 * not start a new session" — that function's own doc comment). A WorkerRun needs its *own*
 * session (task brief: "sid = a new worker_run-kind session") — one row per running container, so
 * `worker_runs.session_id` and the container-identity/egress-attribution machinery built on it
 * (`packages/worker-supervisor/src/egress-map.ts`'s `worker:<workspaceId>:<workerRunId>`) have
 * something stable to key on even across a requeue (a fresh WorkerRun row, same Task, gets a
 * fresh session and a fresh Handle). `mintWorkerRunHandle` below therefore creates the session row
 * itself and calls `governance/capability`'s lower-level `issueHandle` directly, reusing
 * `attenuate`'s own security-critical subset check (`assertScopeIsSubset`, extracted for exactly
 * this reuse) rather than re-implementing it.
 *
 * **The "entry Handle can never grant execute" rule, precisely** (this is the literal mechanism
 * behind the S2.7 acceptance test named above): `computeChildHandleScope` treats
 * `EXECUTE_CLASS_CAPABILITY_NAMES` (`<gate>.<op>:execute`, `request_action`) specially. A
 * WorkerDefinition's *non*-execute declared needs are silently narrowed to whatever the calling
 * Handle actually has (§8.5's "capabilities ∩ definition's declared needs" reading, informally) —
 * a definition asking for an optional `propose_skill` the caller happens to lack simply does not
 * get it, and the call still succeeds. An execute-class declared need is different: if the calling
 * Handle's own scope does not already contain it, `computeChildHandleScope` **rejects the whole
 * call** (`InvokeWorkerAttenuationError`) rather than silently minting a Worker that cannot do
 * what its own definition says it must. Since `governance/capability/handles.ts`'s
 * `ENTRY_CEILING_CAPABILITIES` never contains an execute-class name (structurally — see that
 * file's own doc comment), *any* entry-Handle-initiated `invoke_worker` call against a
 * WorkerDefinition that declares execute-class needs is rejected by construction; a Worker's own
 * Handle (once one exists, holding whatever it was itself granted) can pass execute-class access
 * on to a grandchild WorkerRun only up to what it itself holds — the chain can only narrow, never
 * widen, at every hop.
 *
 * **The "unconstrained" root case (human channel, no parent Handle at all):** `invoke_worker`'s
 * registry channel is `'handle'`, but `application/gateway/authorize.ts`'s own documented reading
 * lets a *human* caller invoke any `channel:'handle'` capability too (human ⊇ handle trust). A
 * human caller has no CapabilityHandle to attenuate from — `parentAuthority: 'unconstrained'`
 * skips the subset checks entirely (there is nothing to narrow from; a human, and only `owner`
 * specifically — `application/task/invoke.ts` is the one that decides *which* human role may pass
 * `'unconstrained'`, not this file), rather than fabricating a fake all-capabilities
 * `CapabilityScope` that would not correspond to anything real. A human caller who is *not*
 * `'unconstrained'`-eligible is treated as `parentAuthority: EMPTY_SCOPE` (below) — the same
 * strict rejection an entry Handle gets, never a silent bypass.
 */

export const EMPTY_CAPABILITY_SCOPE: CapabilityScope = Object.freeze({
  capabilities: [],
  resources: {},
});

export type ParentAuthority = CapabilityScope | 'unconstrained';

export interface ComputeChildHandleScopeInput {
  readonly parentAuthority: ParentAuthority;
  /** The invoked WorkerDefinition's own declared `capabilities` (already defaulted by the caller
   *  — `invoke.ts` — to the worker ceiling minus execute-class names when the definition itself
   *  declares none; see `packages/shared/src/worker-definition.ts`'s own doc comment). */
  readonly declaredCapabilities: readonly string[];
  /** The invoked WorkerDefinition's own declared `gates` (Gatekeeper Object ids). */
  readonly declaredGates: readonly string[];
  /** `invoke_worker`'s optional `gates` param — narrows `declaredGates` for this one invocation;
   *  every id here must already be in `declaredGates` (`InvokeWorkerValidationError` otherwise).
   *  Omitted defaults to every declared gate. */
  readonly requestedGates?: readonly string[];
}

/**
 * Narrows `declaredCapabilities`/`declaredGates` to what the caller may actually pass down, per
 * the rule this module's own doc comment describes:
 *
 *   - Filtered first to the platform's fixed `WORKER_CEILING_CAPABILITIES` (defensive — a
 *     WorkerDefinition cannot smuggle in an unregistered or human-only capability name).
 *   - An **execute-class** capability/gate the parent does not hold **rejects the whole call**
 *     (`InvokeWorkerAttenuationError`) — never silently dropped, since a Worker that cannot do
 *     what its own definition says it must is a worse failure mode than failing fast.
 *   - A **non-execute-class** capability/gate the parent does not hold is **silently dropped** —
 *     the child simply does not get it, and the call still succeeds (§8.5's "capabilities ∩
 *     definition's declared needs" reading).
 *
 * Every capability/gate that ends up in the returned scope is therefore, by construction, already
 * a subset of the effective parent scope (or `unconstrained`) — never assembled first and checked
 * after (that was the bug an earlier version of this function had: pushing every declared
 * capability into the result and only rejecting execute-class misses, then re-validating the
 * *whole* result with `assertScopeIsSubset`, which also rejected a merely-dropped non-execute
 * capability that this function meant to tolerate). `assertScopeIsSubset` is still called at the
 * end, but only as a cheap, genuinely-redundant safety net against a future regression in this
 * construction — it should never actually fire.
 */
export function computeChildHandleScope(input: ComputeChildHandleScopeInput): CapabilityScope {
  const ceiling = new Set(WORKER_CEILING_CAPABILITIES);
  const parentScope: CapabilityScope =
    input.parentAuthority === 'unconstrained' ? EMPTY_CAPABILITY_SCOPE : input.parentAuthority;
  const unconstrained = input.parentAuthority === 'unconstrained';
  const parentCapabilitySet = new Set(parentScope.capabilities);

  // S2.9: force-union the fixed worker-infrastructure capabilities (list_allowed_operations,
  // report_task_result — governance/capability/handles.ts's own doc comment on
  // WORKER_INFRASTRUCTURE_CAPABILITY_NAMES has the full rationale) into the declared set *before*
  // narrowing, so no WorkerDefinition's own explicit `capabilities` list can omit them. They still
  // go through the exact same parent-intersection every other non-execute-class name does below
  // (never a bypass of I13/§5.3-item-8) — granted whenever the parent Handle is an entry Handle
  // (both names are also in ENTRY_CEILING_EXTRA_CAPABILITY_NAMES) or the call is `unconstrained`.
  const effectiveDeclaredCapabilities = [
    ...new Set([...input.declaredCapabilities, ...WORKER_INFRASTRUCTURE_CAPABILITY_NAMES]),
  ];

  const childCapabilities: string[] = [];
  for (const capability of effectiveDeclaredCapabilities) {
    if (!ceiling.has(capability)) continue;
    const parentHasIt = unconstrained || parentCapabilitySet.has(capability);
    if (isExecuteClassCapability(capability)) {
      if (!parentHasIt) {
        throw new InvokeWorkerAttenuationError(
          `invoke_worker: this WorkerDefinition requires the execute-class capability "${capability}", which the calling Handle does not hold — an execute-class capability can never be granted to a child Handle that lacks it (§5.3 item 11, I13)`,
        );
      }
      childCapabilities.push(capability);
    } else if (parentHasIt) {
      childCapabilities.push(capability);
    }
    // else: declared, non-execute-class, and the caller doesn't hold it — silently dropped.
  }

  const requestedGates = input.requestedGates ?? input.declaredGates;
  const notDeclared = requestedGates.filter((gate) => !input.declaredGates.includes(gate));
  if (notDeclared.length > 0) {
    throw new InvokeWorkerValidationError(
      `invoke_worker: gates ${notDeclared.join(', ')} are not declared by this WorkerDefinition ` +
        `(declared: ${input.declaredGates.join(', ') || '(none)'})`,
    );
  }

  const wantsExecute = childCapabilities.some((capability) => isExecuteClassCapability(capability));
  const parentGateSet = new Set(parentScope.resources.gatekeeper ?? []);
  const grantedGates: string[] = [];
  const missingExecuteGates: string[] = [];
  for (const gate of requestedGates) {
    if (unconstrained || parentGateSet.has(gate)) {
      grantedGates.push(gate);
    } else if (wantsExecute) {
      missingExecuteGates.push(gate);
    }
    // else: an observe-only gate the caller doesn't hold — silently dropped (design doc §11:
    // observation is ungated by design; only execute-class access is credential-gated).
  }
  if (missingExecuteGates.length > 0) {
    throw new InvokeWorkerAttenuationError(
      `invoke_worker: execute access was requested for gatekeeper(s) not in the calling Handle's own scope: ${missingExecuteGates.join(', ')}`,
    );
  }

  const resources: Record<string, string[]> = {};
  if (grantedGates.length > 0) resources.gatekeeper = grantedGates;

  const childScope: CapabilityScope = { capabilities: childCapabilities, resources };
  if (!unconstrained) {
    assertScopeIsSubset(parentScope, childScope);
  }
  return childScope;
}

/** Only the two claims fields `mintWorkerRunHandle` actually needs from a parent Handle: `jti`
 *  (lineage — becomes the minted Handle's `par` claim) and `exp` (the ttl cap). Deliberately
 *  narrower than the full `HandleClaims` shape so a caller can supply either a live request's real
 *  claims (`invoke_worker`'s own flow) or a reconstructed pair read back from a `capability_handles`
 *  row (`lifecycle.ts`'s requeue path, which has no live request to read claims from). */
export interface ParentHandleLineage {
  readonly jti: string;
  readonly exp: number;
}

/**
 * Resolves the `ParentAuthority` a caller (of `invoke_worker`, or of `find_workers`/
 * `find_operations`/`find_procedures`'s own "would this caller actually be able to invoke it"
 * pre-check, `application/task/service.ts`'s `findWorkers`) presents: a `handle`-channel caller's
 * own verified scope; a `human`-channel `owner`'s `'unconstrained'` (no Handle to attenuate from,
 * but the platform's highest human authority); any other `human`-channel caller's
 * `EMPTY_CAPABILITY_SCOPE` (holds nothing to attenuate from — never a silent bypass). Shared by
 * both call sites so the two never drift on what "role gets unconstrained" means.
 */
export async function resolveParentAuthority(
  client: PoolClient,
  workspaceId: string,
  caller: {
    readonly principalId: string;
    readonly channel: CapabilityChannel;
    readonly claims?: HandleClaims;
  },
): Promise<ParentAuthority> {
  if (caller.claims) return caller.claims.scope;
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, caller.principalId],
  );
  const role = result.rows[0]?.role;
  return role === 'owner' ? 'unconstrained' : EMPTY_CAPABILITY_SCOPE;
}

export interface MintWorkerRunHandleInput {
  readonly onBehalfOf: string;
  readonly parentClaims: ParentHandleLineage | undefined;
  readonly scope: CapabilityScope;
  readonly ttlSeconds: number;
  readonly privateKey: CryptoKey;
}

/**
 * Creates a fresh `kind='worker_run'` session (§9.2 `sessions.kind` CHECK; `on_behalf_of` copied
 * verbatim from `input.onBehalfOf` — I13 inheritance) and issues a Handle under it. `ttlSeconds`
 * is additionally capped to the parent Handle's own remaining ttl when one exists (a child should
 * never outlive the credential that authorized it), mirroring `attenuate()`'s own ttl rule.
 */
export async function mintWorkerRunHandle(
  client: PoolClient,
  workspaceId: string,
  input: MintWorkerRunHandleInput,
): Promise<IssuedHandle> {
  assertValidScope(input.scope);

  const sessionResult = await client.query<{ id: string }>(
    `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
     values ($1, $2, 'worker_run', $3, 'active')
     returning id`,
    [workspaceId, input.onBehalfOf, input.onBehalfOf],
  );
  const sessionId = sessionResult.rows[0]?.id;
  if (!sessionId)
    throw new Error('mintWorkerRunHandle: session INSERT ... RETURNING produced no row');

  let ttlSeconds = input.ttlSeconds;
  if (input.parentClaims) {
    const parentRemainingSeconds = input.parentClaims.exp - Math.floor(Date.now() / 1000);
    ttlSeconds = Math.min(ttlSeconds, Math.max(parentRemainingSeconds, 1));
  }

  return issueHandle(client, {
    sessionId,
    scope: input.scope,
    ttlSeconds,
    parentJti: input.parentClaims?.jti,
    privateKey: input.privateKey,
  });
}

/**
 * Default declared capabilities for a WorkerDefinition that does not declare its own
 * `capabilities` (least privilege — `packages/shared/src/worker-definition.ts`'s own doc comment
 * on this exact default): the full worker ceiling **minus every execute-class name**. This is
 * load-bearing, not cosmetic — `computeChildHandleScope` *rejects the whole call* (never a silent
 * per-capability drop) whenever a declared execute-class capability is missing from the caller's
 * scope, and an entry Handle never holds one; defaulting to the *full* ceiling would make every
 * plain WorkerDefinition (the common case — one that declares no `capabilities` at all)
 * uninvocable by the entry agent, the one caller S2's own acceptance flow depends on most. A
 * definition that genuinely needs execute-class access must say so explicitly.
 *
 * Shared by `invoke.ts` (the real minting path) and `service.ts`'s `findWorkers` (the "would this
 * caller actually be able to invoke it" dry-run pre-check) so the two can never quietly disagree
 * on what an undeclared WorkerDefinition defaults to — an earlier version of this codebase had
 * `invoke.ts` return the *full*, unfiltered ceiling here (a real bug an integration test caught:
 * every plain, capability-less WorkerDefinition became uninvocable by an entry Handle) while
 * `service.ts` independently defaulted to *no* capabilities at all — two different, both-wrong
 * answers to the same question, in two different files.
 */
export function defaultWorkerCapabilities(ceiling: readonly string[]): readonly string[] {
  return ceiling.filter((capability) => !isExecuteClassCapability(capability));
}
