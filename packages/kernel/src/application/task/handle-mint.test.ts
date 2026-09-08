import { randomUUID } from 'node:crypto';
import type { CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  HandleIssuanceError,
  WORKER_CEILING_CAPABILITIES,
  generateEphemeralHandleKeyPair,
  verifyHandle,
} from '../../governance/capability/index.js';
import {
  EMPTY_CAPABILITY_SCOPE,
  type MintWorkerRunHandleInput,
  computeChildHandleScope,
  mintWorkerRunHandle,
} from './handle-mint.js';
import { InvokeWorkerAttenuationError, InvokeWorkerValidationError } from './types.js';

/**
 * application/task/handle-mint.test: pure, no-DB unit tests for `computeChildHandleScope` — the
 * literal mechanism behind docs/development-tasks.md S2.7's acceptance criterion "入口 Handle 请求
 * 含 execute 的子 Handle 被拒" (see handle-mint.ts's own module doc comment for the full rule).
 */

describe('computeChildHandleScope', () => {
  it('narrows to the intersection of declared capabilities and the worker ceiling (drops an unregistered name)', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: ['get_object', 'not_a_real_capability'],
      declaredGates: [],
    });
    // S2.9: list_allowed_operations/report_task_result are force-unioned in unconditionally (see
    // handle-mint.ts's own doc comment) — with `unconstrained` authority every non-execute-class
    // name passes through, so both appear here alongside the explicitly declared `get_object`.
    expect(scope.capabilities).toEqual([
      'get_object',
      'list_allowed_operations',
      'report_task_result',
      // S2.12 host run: a Worker reads its own Task on `context` — infrastructure, not a need.
      'get_task',
    ]);
  });

  it('entry Handle (no execute-class capability in scope) requesting an execute-class capability is rejected — S2.7 acceptance', () => {
    const entryLikeScope = {
      capabilities: ['get_object', 'traverse', 'invoke_worker'], // never <gate>.<op>:execute
      resources: {},
    };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: entryLikeScope,
        declaredCapabilities: ['get_object', '<gate>.<op>:execute'],
        declaredGates: [],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('request_action is also treated as execute-class and rejected the same way when the parent holds no gate resources', () => {
    const entryLikeScope = { capabilities: ['get_object'], resources: {} };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: entryLikeScope,
        declaredCapabilities: ['request_action'],
        declaredGates: [],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  // Spec correction (S2.12 / G1): the right to *propose* on a gate is delegated with the gate
  // resource. An entry Handle never holds `request_action` by name, but it carries the gates its
  // user was granted via connect_gatekeeper — a Worker it invokes may request actions on exactly
  // those gates (execution still goes through policy/approval), and on nothing else.
  it('an entry Handle granted gate X can mint a Worker that holds request_action scoped to X', () => {
    const entryScopeWithGate = {
      capabilities: ['get_object', 'invoke_worker'],
      resources: { gatekeeper: ['gk-x'] },
    };
    const child = computeChildHandleScope({
      parentAuthority: entryScopeWithGate,
      declaredCapabilities: ['get_object', 'request_action'],
      declaredGates: ['gk-x'],
    });
    expect(child.capabilities).toContain('request_action');
    expect(child.capabilities).not.toContain('<gate>.<op>:execute');
    expect(child.resources.gatekeeper).toEqual(['gk-x']);
  });

  it('an entry Handle granted gate X is still rejected for a Worker that needs request_action on gate Y', () => {
    const entryScopeWithGate = {
      capabilities: ['get_object', 'invoke_worker'],
      resources: { gatekeeper: ['gk-x'] },
    };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: entryScopeWithGate,
        declaredCapabilities: ['request_action'],
        declaredGates: ['gk-y'],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('gate resources never delegate the direct <gate>.<op>:execute projection by name', () => {
    const entryScopeWithGate = {
      capabilities: ['get_object', 'invoke_worker'],
      resources: { gatekeeper: ['gk-x'] },
    };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: entryScopeWithGate,
        declaredCapabilities: ['<gate>.<op>:execute'],
        declaredGates: ['gk-x'],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('a non-execute-class capability the parent lacks is silently dropped, not rejected', () => {
    const parentScope = { capabilities: ['get_object'], resources: {} };
    const scope = computeChildHandleScope({
      parentAuthority: parentScope,
      declaredCapabilities: ['get_object', 'propose_skill'], // propose_skill not held by parent
      declaredGates: [],
    });
    expect(scope.capabilities).toEqual(['get_object']);
  });

  it('a Worker Handle that already holds the execute-class capability can pass it to a child', () => {
    const workerScope = {
      capabilities: ['get_object', '<gate>.<op>:execute'],
      resources: { gatekeeper: ['gk-1'] },
    };
    const scope = computeChildHandleScope({
      parentAuthority: workerScope,
      declaredCapabilities: ['get_object', '<gate>.<op>:execute'],
      declaredGates: ['gk-1'],
    });
    expect(scope.capabilities).toContain('<gate>.<op>:execute');
    expect(scope.resources.gatekeeper).toEqual(['gk-1']);
  });

  it('requesting a gate not covered by the parent scope is rejected when execute-class capabilities are involved', () => {
    const workerScope = {
      capabilities: ['<gate>.<op>:execute'],
      resources: { gatekeeper: ['gk-1'] },
    };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: workerScope,
        declaredCapabilities: ['<gate>.<op>:execute'],
        declaredGates: ['gk-1', 'gk-2'],
        requestedGates: ['gk-2'],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('requesting a gate the WorkerDefinition itself never declared is a validation error, not attenuation', () => {
    expect(() =>
      computeChildHandleScope({
        parentAuthority: 'unconstrained',
        declaredCapabilities: ['get_object'],
        declaredGates: ['gk-1'],
        requestedGates: ['gk-not-declared'],
      }),
    ).toThrow(InvokeWorkerValidationError);
  });

  it('unconstrained (human/owner root call) skips the subset check entirely, including for execute-class capabilities', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: ['get_object', '<gate>.<op>:execute'],
      declaredGates: ['gk-1'],
    });
    expect(scope.capabilities).toContain('<gate>.<op>:execute');
    expect(scope.resources.gatekeeper).toEqual(['gk-1']);
  });

  it('an empty scope (non-owner human, or a caller with nothing) rejects any execute-class need', () => {
    expect(() =>
      computeChildHandleScope({
        parentAuthority: EMPTY_CAPABILITY_SCOPE,
        declaredCapabilities: ['<gate>.<op>:execute'],
        declaredGates: ['gk-1'],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('defaults requestedGates to every declared gate when omitted', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: ['get_object'],
      declaredGates: ['gk-1', 'gk-2'],
    });
    expect(scope.resources.gatekeeper).toEqual(['gk-1', 'gk-2']);
  });

  it('never returns a capability outside WORKER_CEILING_CAPABILITIES', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: [...WORKER_CEILING_CAPABILITIES, 'grant_capability'], // human-only, must be filtered
      declaredGates: [],
    });
    expect(scope.capabilities).not.toContain('grant_capability');
    for (const capability of scope.capabilities) {
      expect(WORKER_CEILING_CAPABILITIES).toContain(capability);
    }
  });
});

// -------------------------------------------------------------------------------------------
// mintWorkerRunHandle — lane-1 P2 follow-up fix: the same Date.now()-then-await-then-Date.now()
// rounding race handles.test.ts's `attenuate` test covers, reproduced here against
// mintWorkerRunHandle's own two reads (parentRemainingSeconds above, issueHandle's own iatSeconds
// after the session INSERT round trip below).
// -------------------------------------------------------------------------------------------

interface FakeSessionRow {
  workspaceId: string;
  onBehalfOf: string;
}

interface FakeHandleRow {
  workspace_id: string;
  session_id: string;
  on_behalf_of: string;
  parent_jti: string | null;
  scope: CapabilityScope;
  expires_at: string;
}

/** A tiny in-memory stand-in for `sessions` + `capability_handles`, matched against the exact
 *  small set of SQL statements mintWorkerRunHandle (session INSERT) and issueHandle (session
 *  SELECT, capability_handles INSERT) issue — same pattern as governance/capability/
 *  handles.test.ts's own `createFakeCapabilityClient`. */
function createFakeMintClient() {
  const sessions = new Map<string, FakeSessionRow>();
  const handles = new Map<string, FakeHandleRow>();

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.trim();

    if (sql.startsWith('insert into sessions')) {
      const [workspaceId, , onBehalfOf] = params as [string, string, string];
      // A real UUID — HandleClaimsSchema validates `sid` as a uuid string.
      const id = randomUUID();
      sessions.set(id, { workspaceId, onBehalfOf });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.startsWith('select workspace_id, on_behalf_of from sessions')) {
      const [sessionId] = params as [string];
      const row = sessions.get(sessionId);
      return {
        rows: row ? [{ workspace_id: row.workspaceId, on_behalf_of: row.onBehalfOf }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (sql.startsWith('insert into capability_handles')) {
      const [workspaceId, jti, sessionId, onBehalfOf, parentJti, scopeJson, expiresAt] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
      ];
      handles.set(jti, {
        workspace_id: workspaceId,
        session_id: sessionId,
        on_behalf_of: onBehalfOf,
        parent_jti: parentJti,
        scope: JSON.parse(scopeJson) as CapabilityScope,
        expires_at: expiresAt,
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`fake mint client: unhandled query: ${sql}`);
  });

  const client = { query } as unknown as PoolClient;
  return { client, sessions, handles };
}

describe('mintWorkerRunHandle', () => {
  it('lane-1 P2 follow-up fix: a Date.now() step between parentRemainingSeconds and issueHandle’s own never lets the child’s expires_at exceed the parent’s (rounding race, governance/0008’s trigger)', async () => {
    const { client, handles } = createFakeMintClient();
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
    const workspaceId = randomUUID();
    const onBehalfOf = randomUUID();

    const parentExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const parentJti = randomUUID();

    const input: MintWorkerRunHandleInput = {
      onBehalfOf,
      parentClaims: { jti: parentJti, exp: parentExpSeconds },
      scope: { capabilities: ['get_object'], resources: {} },
      ttlSeconds: 3600, // >= the parent's remaining ttl — the worst case for this race
      privateKey,
    };

    // Same monotonically-advancing fake clock as handles.test.ts's `attenuate` race test: every
    // Date.now() call sees strictly more elapsed time than the one before it (1.5s/call, forcing
    // at least one whole-second Math.floor shift), regardless of how many calls land in between.
    const realNow = Date.now();
    let calls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      return realNow + calls * 1500;
    });

    let child: Awaited<ReturnType<typeof mintWorkerRunHandle>>;
    try {
      child = await mintWorkerRunHandle(client, workspaceId, input);
    } finally {
      nowSpy.mockRestore();
    }

    const parentExpiresAtMs = parentExpSeconds * 1000;
    expect(child.expiresAt.getTime()).toBeLessThanOrEqual(parentExpiresAtMs);

    const childClaims = await verifyHandle(child.token, {
      publicKey,
      isRevoked: async () => false,
    });
    expect(childClaims.exp).toBeLessThanOrEqual(parentExpSeconds);
    expect(childClaims.par).toBe(parentJti);

    const dbRow = handles.get(child.jti);
    expect(dbRow).toBeDefined();
    expect(new Date(dbRow?.expires_at ?? 0).getTime()).toBeLessThanOrEqual(parentExpiresAtMs);
  });

  it('lane-1 P2 follow-up fix: an already-expired parent throws HandleIssuanceError instead of minting an over-long child', async () => {
    const { client, handles } = createFakeMintClient();
    const { privateKey } = await generateEphemeralHandleKeyPair();
    const workspaceId = randomUUID();
    const onBehalfOf = randomUUID();

    // Expired 10 seconds ago — parentRemainingSeconds is strongly negative, so (with the
    // Math.max(..., 1) floor removed) ttlSeconds flows through unmodified into issueHandle's own
    // `ttlSeconds must be a positive number` check. Before this fix, the floor would have
    // manufactured a 1-second-TTL child anyway — silently minting a Handle under an authority
    // that had already run out.
    const parentExpSeconds = Math.floor(Date.now() / 1000) - 10;

    const input: MintWorkerRunHandleInput = {
      onBehalfOf,
      parentClaims: { jti: randomUUID(), exp: parentExpSeconds },
      scope: { capabilities: ['get_object'], resources: {} },
      ttlSeconds: 300,
      privateKey,
    };

    await expect(mintWorkerRunHandle(client, workspaceId, input)).rejects.toThrow(
      HandleIssuanceError,
    );
    expect(handles.size).toBe(0);
  });
});
