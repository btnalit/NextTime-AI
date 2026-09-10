import type { CapabilityScope } from '@nexttime/shared';
import {
  entryScope,
  issueHandle,
  listActiveGrantResourceScopes,
} from '../../governance/capability/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY } from '../../governance/policy/index.js';
import { getConfiguredTaskRuntime } from '../task/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/issue-handle-handler: `issue_handle` (design doc §5.1.4, §9.2 "mcp_session
 * （外部运行时）", §9.3 governance row "human（owner）"; docs/development-tasks.md W2-B). Issues a
 * CapabilityHandle for a *new* `kind='mcp_session'` session — the design's own term for an
 * `interactive`-mode client running outside the platform (Claude Code, a developer's local `pi`,
 * §7.4) — on behalf of the *calling* human Principal. Never a caller-supplied target session or
 * principal (I13: `on_behalf_of` is always derived from the caller, never accepted as input).
 *
 * **Scope computation reuses the exact building blocks `agent-host-runtime.ts`'s
 * `ensureEntryHandle` already uses for the resident entry agent's own Handle**
 * (`listActiveGrantResourceScopes` + `entryScope()`, governance/capability/handles.ts): an
 * interactive Handle's ceiling is, by construction, never wider than an entry Handle's — same
 * fixed `ENTRY_CEILING_CAPABILITIES` (entry-only; structurally never contains an execute-class
 * name), same Grant-derived `resources.gatekeeper`. The caller's own `params.scope` (optional)
 * further narrows that ceiling via a pure intersection (`intersectScope` below) — never a request
 * that can widen it (§5.3 item 8 "Handle 范围大于其来源").
 *
 * Not an `attenuate()` call: `attenuate` mints a child bound to the *same session* as an existing,
 * already-verified parent Handle (governance/capability/handles.ts's own doc comment) — this is a
 * fresh top-level issuance from the human channel, which has no Handle of its own to attenuate
 * from (the same reasoning `application/task/handle-mint.ts`'s `mintWorkerRunHandle` already
 * documents for `invoke_worker`'s child-Handle minting). `intersectScope` below is deliberately a
 * silent narrowing, not `assertScopeIsSubset`'s stricter "subset or throw" — a caller requesting a
 * capability slightly beyond their own ceiling (e.g. because they don't know its exact contents in
 * advance) gets the intersection back in the result, not an error.
 */

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h — same default as the resident entry Handle's own DEFAULT_ENTRY_HANDLE_TTL_SECONDS (agent-host-runtime.ts).

interface RequestedScope {
  readonly capabilities?: readonly string[];
  readonly resources?: Readonly<Record<string, readonly string[]>>;
}

interface IssueHandleParams {
  readonly sessionKind: 'interactive';
  readonly ttlSeconds?: number;
  readonly scope?: RequestedScope;
}

/**
 * Intersects `requested` (omitted — or an omitted field within it — means "everything the ceiling
 * allows on that axis") against `ceiling`, on both axes independently. A requested id/name not
 * present in the ceiling is simply dropped, never rejected — the returned `scope` is always what
 * the caller actually gets, and the handler's own result surfaces it so a caller can see exactly
 * what was granted.
 */
export function intersectScope(
  ceiling: CapabilityScope,
  requested: RequestedScope | undefined,
): CapabilityScope {
  const ceilingCapabilities = new Set(ceiling.capabilities);
  const capabilities = requested?.capabilities
    ? requested.capabilities.filter((name) => ceilingCapabilities.has(name))
    : [...ceiling.capabilities];

  const resources: Record<string, string[]> = {};
  if (requested?.resources) {
    for (const [key, ids] of Object.entries(requested.resources)) {
      const ceilingIds = new Set(ceiling.resources[key] ?? []);
      const narrowed = ids.filter((resourceId) => ceilingIds.has(resourceId));
      if (narrowed.length > 0) resources[key] = narrowed;
    }
  } else {
    for (const [key, ids] of Object.entries(ceiling.resources)) {
      resources[key] = [...ids];
    }
  }

  return { capabilities, resources };
}

export const issueHandleHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  // Fail fast — before any DB write — if the kernel has no Handle-signing keypair configured
  // (application/task/runtime.ts, the same singleton `invoke_worker`'s Handle-minting path already
  // reads; see this file's own module doc comment for why reusing it here, rather than threading a
  // second private-key channel through `dispatchCapability`, is the right seam).
  const { privateKey } = getConfiguredTaskRuntime();

  const input = params as IssueHandleParams;
  const onBehalfOf = ctx?.principalId ?? '';

  const grantedGatekeeperIds = await listActiveGrantResourceScopes(client, workspaceId, {
    principalId: onBehalfOf,
    resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY,
  });
  // W5.5 (STATUS leftover 18): narrow the ceiling by the calling Principal's role. `issue_handle`
  // is `minRole:'owner'` today, so this is a no-op here, but the rule is applied at every issuer.
  const ceiling = entryScope(
    grantedGatekeeperIds.length > 0 ? { resources: { gatekeeper: grantedGatekeeperIds } } : {},
    ctx?.principal ? { role: ctx.principal.role } : {},
  );
  const scope = intersectScope(ceiling, input.scope);

  const sessionResult = await client.query<{ id: string }>(
    `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
     values ($1, $2, 'mcp_session', $3, 'active')
     returning id`,
    [workspaceId, onBehalfOf, onBehalfOf],
  );
  const sessionId = sessionResult.rows[0]?.id;
  if (!sessionId) {
    throw new Error('issue_handle: session INSERT ... RETURNING produced no row');
  }

  const issued = await issueHandle(client, {
    sessionId,
    scope,
    ttlSeconds: input.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    privateKey,
  });

  return {
    result: {
      handle: issued.token,
      sessionId: issued.sessionId,
      onBehalfOf: issued.onBehalfOf,
      expiresAt: issued.expiresAt.toISOString(),
      scope: issued.scope,
    },
    resourceType: 'session',
    resourceId: sessionId,
  };
};
