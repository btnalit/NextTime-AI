import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE_SHARED_CREDENTIAL_SLOT,
  HANDLE_SIGNING_ALG,
  internalAuthorizationHeader,
  mintGateHostToken,
} from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectedAccountStore } from './credentials/index.js';
import { type GateHost, createGateHost } from './host.js';
import { operationDefinitionDigest } from './operation-digest.js';

/**
 * host.test: `createGateHost` (P-B2a) end-to-end against a fake kernel + fake MCP target, driven
 * by hand (`tick()`, `listen:false`) — mirrors announce.test.ts's fake-fetch pattern for the
 * self-registration side and server.test.ts's `app.inject` pattern for the HTTP surface.
 */

const KERNEL_URL = 'http://kernel.test';
const GATE_TOKEN = 'gate-host-test-gate-token-0123456789abcdef0123456789';

/** Legacy K: the digest a kernel sends for `name` — computed from what the instance describes. */
async function announcedDigest(host: GateHost, gateId: string, name: string): Promise<string> {
  const described = await host.app.inject({
    method: 'GET',
    url: `/i/${gateId}/gate/describe_operations`,
    headers: { authorization: `Bearer ${GATE_TOKEN}` },
  });
  const operations = described.json().result.operations as { name: string }[];
  return operationDefinitionDigest(operations.find((op) => op.name === name));
}
const INTERNAL_TOKEN = 'gate-host-test-internal-token-0123456789abcdef01234567';

interface McpTool {
  readonly name: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
}

const READ_TOOL: McpTool = { name: 'read_tool', annotations: { readOnlyHint: true } };
const WRITE_TOOL: McpTool = {
  name: 'write_tool',
  annotations: { destructiveHint: false, idempotentHint: true },
};

const DEMO_MCP_ITEM = {
  gateId: 'demo-mcp',
  displayName: 'Demo',
  status: 'enabled',
  definition: {
    transportKind: 'mcp' as const,
    target: 'http://mcp.test/',
    credentialMode: 'shared' as 'shared' | 'connected_account',
    manifestSource: null,
  },
};

interface FakeState {
  items: Array<typeof DEMO_MCP_ITEM>;
  mcpListShouldFail: boolean;
  /** R-69 fixture: when set, the fake MCP server answers every method — `tools/list` included —
   *  with 401 unless the request carries `Authorization: Bearer <this>`. */
  mcpRequiredToken?: string;
  announcements: Array<{ url: string; body: Record<string, unknown> }>;
  instanceListCalls: Array<{ headers: Record<string, string> }>;
}

function makeFetch(state: FakeState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url === `${KERNEL_URL}/internal/gate-host/instances` && method === 'GET') {
      state.instanceListCalls.push({ headers });
      return new Response(JSON.stringify({ ok: true, result: { items: state.items } }), {
        status: 200,
      });
    }

    if (url === `${KERNEL_URL}/internal/gates/announce` && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      state.announcements.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }

    if (url === 'http://mcp.test/' && method === 'POST') {
      const rpc = JSON.parse(String(init?.body ?? '{}')) as {
        id: number;
        method: string;
      };
      if (
        state.mcpRequiredToken !== undefined &&
        headers.authorization !== `Bearer ${state.mcpRequiredToken}`
      ) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      if (rpc.method === 'tools/list') {
        if (state.mcpListShouldFail) {
          return new Response(JSON.stringify({}), { status: 500 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { tools: [READ_TOOL, WRITE_TOOL] },
          }),
          { status: 200 },
        );
      }
      if (rpc.method === 'tools/call') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: 'ok' }] },
          }),
          { status: 200, headers: { 'x-recorded-authorization': headers.authorization ?? '' } },
        );
      }
    }

    throw new Error(`fake fetch: unexpected request ${method} ${url}`);
  }) as unknown as typeof fetch;
}

/** Records every fetch call (url, method, headers, body) alongside routing them through
 *  `makeFetch` — used by tests that need to assert on what was actually sent (e.g. the
 *  connected-account credential header reaching the fake MCP server). */
function recordingFetch(
  state: FakeState,
  calls: Array<{ url: string; init: RequestInit }>,
): typeof fetch {
  const inner = makeFetch(state);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return inner(input, init);
  }) as unknown as typeof fetch;
}

async function generateHandleKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
    crv: 'Ed25519',
    extractable: true,
  });
  return { privateKey, publicKey };
}

describe('createGateHost (P-B2a)', () => {
  let dir: string;
  let privateKey: CryptoKey;
  let env: NodeJS.ProcessEnv;
  let state: FakeState;
  let calls: Array<{ url: string; init: RequestInit }>;
  let host: GateHost | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gate-host-test-'));
    await writeFile(join(dir, 'gate.token'), `${GATE_TOKEN}\n`);
    await writeFile(join(dir, 'internal.token'), `${INTERNAL_TOKEN}\n`);
    await writeFile(join(dir, 'store.key'), 'a-passphrase-not-32-bytes-long');

    const keyPair = await generateHandleKeyPair();
    privateKey = keyPair.privateKey;
    await writeFile(join(dir, 'handle.pub'), await exportSPKI(keyPair.publicKey));

    await mkdir(join(dir, 'data'), { recursive: true });

    env = {
      KERNEL_URL,
      GATE_DATA_DIR: join(dir, 'data'),
      GATE_PUBLIC_ENDPOINT: 'http://gate-host.test:8083',
      GATE_HOST_PUBLIC_KEY_FILE: join(dir, 'handle.pub'),
      GATE_KERNEL_TOKEN_FILE: join(dir, 'gate.token'),
      GATE_INTERNAL_TOKEN_FILE: join(dir, 'internal.token'),
      GATE_STORE_KEY_FILE: join(dir, 'store.key'),
    };

    state = {
      items: [DEMO_MCP_ITEM],
      mcpListShouldFail: false,
      announcements: [],
      instanceListCalls: [],
    };
    calls = [];
  });

  afterEach(async () => {
    if (host) await host.close();
    host = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('tick() pulls, builds the mcp instance and announces it exactly once', async () => {
    host = await createGateHost({ env, fetchImpl: recordingFetch(state, calls), listen: false });

    expect(await host.tick()).toBe(true);
    expect(host.instances()).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);

    expect(state.instanceListCalls).toHaveLength(1);
    expect(state.instanceListCalls[0]?.headers.authorization).toBe(
      internalAuthorizationHeader(INTERNAL_TOKEN),
    );

    expect(state.announcements).toHaveLength(1);
    const [announced] = state.announcements;
    expect(announced?.body).toMatchObject({
      gateId: 'demo-mcp',
      connector: 'mcp',
      endpoint: 'http://gate-host.test:8083/i/demo-mcp',
    });
    expect(announced?.body.healthEndpoint).toMatch(/\/gate\/health$/);
    const operations = announced?.body.operations as Array<Record<string, unknown>>;
    expect(operations).toHaveLength(2);
    const readOp = operations.find((op) => op.name === 'read_tool');
    const writeOp = operations.find((op) => op.name === 'write_tool');
    expect(readOp).toMatchObject({ mode: 'observe', read_only_hint: true });
    expect(writeOp).toMatchObject({
      mode: 'execute',
      destructive_hint: false,
      idempotent_hint: true,
    });
  });

  it('routes /i/:gateId/gate/* by gate token, 404s an unknown gate, and /healthz needs no auth', async () => {
    host = await createGateHost({ env, fetchImpl: makeFetch(state), listen: false });
    await host.tick();

    const withAuth = await host.app.inject({
      method: 'GET',
      url: '/i/demo-mcp/gate/describe_operations',
      headers: { authorization: `Bearer ${GATE_TOKEN}` },
    });
    expect(withAuth.statusCode).toBe(200);
    expect(withAuth.json().result.operations).toHaveLength(2);

    const withoutAuth = await host.app.inject({
      method: 'GET',
      url: '/i/demo-mcp/gate/describe_operations',
    });
    expect(withoutAuth.statusCode).toBe(401);

    const unknownGate = await host.app.inject({
      method: 'GET',
      url: '/i/unknown/gate/health',
      headers: { authorization: `Bearer ${GATE_TOKEN}` },
    });
    expect(unknownGate.statusCode).toBe(404);
    expect(unknownGate.json().error.code).toBe('gate_not_found');

    const healthz = await host.app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
  });

  // Leftover 87 (review B1): the gate label is bounded by this host's own instance table — an
  // unauthenticated caller naming arbitrary gate ids must not mint a new series per request.
  it('calls naming a gate this host does not serve never become a gate label value', async () => {
    host = await createGateHost({
      env,
      fetchImpl: makeFetch(state),
      listen: false,
      log: () => {},
    });
    await host.tick();

    for (const id of ['attacker-1', 'attacker-2', 'demo-mcp']) {
      await host.app.inject({ method: 'POST', url: `/i/${id}/gate/observe`, payload: {} });
    }
    await host.app.inject({
      method: 'GET',
      url: '/i/attacker-3/gate/health',
      headers: { authorization: `Bearer ${GATE_TOKEN}` },
    });

    const metrics = await host.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: `Bearer ${GATE_TOKEN}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).not.toContain('attacker');
    const gateLabels = new Set([...metrics.body.matchAll(/gate="([^"]*)"/g)].map((m) => m[1]));
    expect([...gateLabels].every((g) => g === '' || g === 'demo-mcp')).toBe(true);
  });

  // Leftover 87.
  it('GET /internal/metrics needs the gate token; each /gate/* call is logged with its correlation id and counted', async () => {
    const lines: string[] = [];
    host = await createGateHost({
      env,
      fetchImpl: makeFetch(state),
      listen: false,
      log: (line) => lines.push(line),
    });
    await host.tick();

    await host.app.inject({
      method: 'GET',
      url: '/i/demo-mcp/gate/describe_operations',
      headers: { authorization: `Bearer ${GATE_TOKEN}`, 'x-correlation-id': 'turn-abcd-0001' },
    });

    expect((await host.app.inject({ method: 'GET', url: '/internal/metrics' })).statusCode).toBe(
      401,
    );
    const metrics = await host.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: `Bearer ${GATE_TOKEN}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain(
      'nexttime_gate_calls_total{gate="demo-mcp",route="describe_operations",operation="",status="200"} 1',
    );

    const callLines = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'gate call');
    expect(callLines).toEqual([
      expect.objectContaining({
        correlationId: 'turn-abcd-0001',
        gateRoute: 'describe_operations',
        gateId: 'demo-mcp',
        status: 200,
      }),
    ]);
  });

  it('a platform token stores the credential under its own obo slot, ignoring the body, and the credential reaches the target', async () => {
    host = await createGateHost({ env, fetchImpl: recordingFetch(state, calls), listen: false });
    await host.tick();

    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });

    const stored = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/connected-accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { onBehalfOf: 'someone-else', credential: { token: 'secret-1' } },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().result).toEqual({ stored: true });

    const accountStore = new ConnectedAccountStore({
      dataDir: join(dir, 'data', 'demo-mcp'),
      keyFilePath: join(dir, 'store.key'),
    });
    expect(await accountStore.get(GATE_SHARED_CREDENTIAL_SLOT)).toEqual({ token: 'secret-1' });
    expect(await accountStore.get('someone-else')).toBeUndefined();

    calls.length = 0;
    const observed = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/observe',
      headers: { authorization: `Bearer ${GATE_TOKEN}` },
      payload: {
        operation: 'read_tool',
        params: {},
        operationDigest: await announcedDigest(host, 'demo-mcp', 'read_tool'),
      },
    });
    expect(observed.statusCode).toBe(200);

    const mcpCall = calls.find((c) => c.url === 'http://mcp.test/');
    const headers = mcpCall?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-1');
  });

  it('rejects (401) every misuse of a platform token', async () => {
    host = await createGateHost({ env, fetchImpl: makeFetch(state), listen: false });
    await host.tick();

    const { token: validToken } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });
    const onObserve = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/observe',
      headers: { authorization: `Bearer ${validToken}` },
      payload: { operation: 'read_tool', params: {} },
    });
    expect(onObserve.statusCode).toBe(401);

    // Review finding: the shared gate_token (which the kernel presents on every call, including a
    // workspace-driven `create_connection` aimed at this host) must NOT open the credential routes.
    for (const method of ['POST', 'DELETE'] as const) {
      const withGateToken = await host.app.inject({
        method,
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${GATE_TOKEN}` },
        payload: { onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT, credential: { token: 'poison' } },
      });
      expect(withGateToken.statusCode).toBe(401);
    }

    const { token: otherGateToken } = await mintGateHostToken({
      privateKey,
      gateId: 'other-gate',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });
    const wrongGate = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/connected-accounts',
      headers: { authorization: `Bearer ${otherGateToken}` },
      payload: { onBehalfOf: 'x', credential: { token: 'y' } },
    });
    expect(wrongGate.statusCode).toBe(401);

    const { privateKey: otherPrivateKey } = await generateHandleKeyPair();
    const { token: wrongKeyToken } = await mintGateHostToken({
      privateKey: otherPrivateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });
    const wrongKey = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/connected-accounts',
      headers: { authorization: `Bearer ${wrongKeyToken}` },
      payload: { onBehalfOf: 'x', credential: { token: 'y' } },
    });
    expect(wrongKey.statusCode).toBe(401);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const handleShaped = await new SignJWT({
      ws: '00000000-0000-4000-8000-000000000000',
      sid: '00000000-0000-4000-8000-000000000001',
      obo: '00000000-0000-4000-8000-000000000002',
      scope: { capabilities: [], resources: {} },
      jti: '00000000-0000-4000-8000-000000000003',
      iat: nowSeconds,
      exp: nowSeconds + 300,
    })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);
    const handleShapedResp = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/connected-accounts',
      headers: { authorization: `Bearer ${handleShaped}` },
      payload: { onBehalfOf: 'x', credential: { token: 'y' } },
    });
    expect(handleShapedResp.statusCode).toBe(401);

    const { token: expiredToken } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
      nowMs: Date.now() - 10 * 60_000,
    });
    const expiredResp = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/connected-accounts',
      headers: { authorization: `Bearer ${expiredToken}` },
      payload: { onBehalfOf: 'x', credential: { token: 'y' } },
    });
    expect(expiredResp.statusCode).toBe(401);
  });

  it('reconciles: drops an instance the kernel stops listing, retries a broken target, and recovers', async () => {
    host = await createGateHost({ env, fetchImpl: recordingFetch(state, calls), listen: false });
    await host.tick();
    expect(host.instances()).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);

    // Store a credential first so removal has something to wipe (review finding: a re-created
    // instance must not inherit the old credential).
    const { token: slotToken } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });
    const stored = await host.app.inject({
      method: 'POST',
      url: '/i/demo-mcp/gate/connected-accounts',
      headers: { authorization: `Bearer ${slotToken}` },
      payload: { onBehalfOf: 'ignored', credential: { token: 'old-secret' } },
    });
    expect(stored.statusCode).toBe(200);
    await expect(access(join(dir, 'data', 'demo-mcp'))).resolves.toBeUndefined();

    state.items = [];
    expect(await host.tick()).toBe(true);
    expect(host.instances()).toEqual([]);
    await expect(access(join(dir, 'data', 'demo-mcp'))).rejects.toThrow();
    const goneHealth = await host.app.inject({
      method: 'GET',
      url: '/i/demo-mcp/gate/health',
      headers: { authorization: `Bearer ${GATE_TOKEN}` },
    });
    expect(goneHealth.statusCode).toBe(404);

    state.items = [DEMO_MCP_ITEM];
    state.mcpListShouldFail = true;
    const announcedBefore = state.announcements.length;
    expect(await host.tick()).toBe(true);
    const broken = host.instances();
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ gateId: 'demo-mcp', ready: false, operationCount: 0 });
    expect(broken[0]?.buildError).toBeTruthy();
    expect(state.announcements).toHaveLength(announcedBefore);

    state.mcpListShouldFail = false;
    expect(await host.tick()).toBe(true);
    const recovered = host.instances();
    expect(recovered).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);
    expect(state.announcements.length).toBeGreaterThan(announcedBefore);
  });

  describe('R-69: a target whose tools/list needs the credential', () => {
    async function sharedSlotToken(): Promise<string> {
      const { token } = await mintGateHostToken({
        privateKey,
        gateId: 'demo-mcp',
        onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
        subject: 'admin-1',
      });
      return token;
    }

    function toolsListCalls(): Array<{ url: string; init: RequestInit }> {
      return calls.filter(
        (c) =>
          c.url === 'http://mcp.test/' &&
          (JSON.parse(String(c.init.body ?? '{}')) as { method?: string }).method === 'tools/list',
      );
    }

    it('connect → store the shared credential → tools/list succeeds: taken over and announced before the response', async () => {
      state.mcpRequiredToken = 'auth-secret-r69';
      const lines: string[] = [];
      host = await createGateHost({
        env,
        fetchImpl: recordingFetch(state, calls),
        listen: false,
        log: (line) => lines.push(line),
      });

      // Connect: the handshake is refused, so the instance is not taken over and not announced.
      expect(await host.tick()).toBe(true);
      const before = host.instances();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ gateId: 'demo-mcp', ready: false, operationCount: 0 });
      expect(before[0]?.buildError).toMatch(/401/);
      expect(state.announcements).toHaveLength(0);

      // Store the credential on the not-yet-built instance — this used to 404 `gate_not_found`.
      const stored = await host.app.inject({
        method: 'POST',
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${await sharedSlotToken()}` },
        payload: {
          onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
          credential: { token: 'auth-secret-r69' },
        },
      });
      expect(stored.statusCode).toBe(200);
      expect(stored.json().result).toEqual({ stored: true });

      // Re-handshaken with the stored credential and announced — no tick needed.
      expect(host.instances()).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);
      const lastList = toolsListCalls().at(-1);
      expect((lastList?.init.headers as Record<string, string>).authorization).toBe(
        'Bearer auth-secret-r69',
      );
      expect(state.announcements).toHaveLength(1);
      expect(state.announcements[0]?.body).toMatchObject({ gateId: 'demo-mcp' });
      expect(state.announcements[0]?.body.operations).toHaveLength(2);

      const observed = await host.app.inject({
        method: 'POST',
        url: '/i/demo-mcp/gate/observe',
        headers: { authorization: `Bearer ${GATE_TOKEN}` },
        payload: {
          operation: 'read_tool',
          params: {},
          // Legacy K: the digest of the definition the host announced — what the kernel approves.
          operationDigest: operationDefinitionDigest(
            (state.announcements[0]?.body.operations as { name: string }[]).find(
              (op) => op.name === 'read_tool',
            ),
          ),
        },
      });
      expect(observed.statusCode).toBe(200);

      // The credential stays in the gate's store: never in a log line, never in an announcement.
      expect(lines.some((l) => l.includes('auth-secret-r69'))).toBe(false);
      expect(JSON.stringify(state.announcements)).not.toContain('auth-secret-r69');
    });

    it('a rejected credential is still stored (200) but the instance stays not ready; DELETE works on it; the right one takes it over', async () => {
      state.mcpRequiredToken = 'right-secret';
      host = await createGateHost({
        env,
        fetchImpl: recordingFetch(state, calls),
        listen: false,
        log: () => {},
      });
      await host.tick();

      const wrong = await host.app.inject({
        method: 'POST',
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${await sharedSlotToken()}` },
        payload: { onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT, credential: { token: 'wrong' } },
      });
      expect(wrong.statusCode).toBe(200);
      expect(wrong.json().result).toEqual({ stored: true });
      const afterWrong = host.instances();
      expect(afterWrong[0]).toMatchObject({ ready: false, operationCount: 0 });
      expect(afterWrong[0]?.buildError).toMatch(/401/);
      expect(state.announcements).toHaveLength(0);

      const deleted = await host.app.inject({
        method: 'DELETE',
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${await sharedSlotToken()}` },
        payload: { onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().result).toEqual({ deleted: true });
      const accountStore = new ConnectedAccountStore({
        dataDir: join(dir, 'data', 'demo-mcp'),
        keyFilePath: join(dir, 'store.key'),
      });
      expect(await accountStore.get(GATE_SHARED_CREDENTIAL_SLOT)).toBeUndefined();

      const right = await host.app.inject({
        method: 'POST',
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${await sharedSlotToken()}` },
        payload: { onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT, credential: { token: 'right-secret' } },
      });
      expect(right.statusCode).toBe(200);
      expect(host.instances()).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);
      expect(state.announcements).toHaveLength(1);
    });

    it('re-handshakes an instance already taken over, keeping the working gate when the new credential is rejected', async () => {
      host = await createGateHost({
        env,
        fetchImpl: recordingFetch(state, calls),
        listen: false,
        log: () => {},
      });
      await host.tick();
      expect(host.instances()).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);
      const announcedBefore = state.announcements.length;

      // The target starts requiring a token; the administrator first enters a wrong one.
      state.mcpRequiredToken = 'rotated';
      const wrong = await host.app.inject({
        method: 'POST',
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${await sharedSlotToken()}` },
        payload: { onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT, credential: { token: 'bad' } },
      });
      expect(wrong.statusCode).toBe(200);
      const kept = host.instances();
      expect(kept[0]).toMatchObject({ ready: true, operationCount: 2 });
      expect(kept[0]?.buildError).toMatch(/401/);
      const describe = await host.app.inject({
        method: 'GET',
        url: '/i/demo-mcp/gate/describe_operations',
        headers: { authorization: `Bearer ${GATE_TOKEN}` },
      });
      expect(describe.json().result.operations).toHaveLength(2);

      const right = await host.app.inject({
        method: 'POST',
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${await sharedSlotToken()}` },
        payload: { onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT, credential: { token: 'rotated' } },
      });
      expect(right.statusCode).toBe(200);
      expect(host.instances()).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);
      expect(state.announcements.length).toBe(announcedBefore + 1);
    });

    it('a member credential on a connected_account instance never drives discovery', async () => {
      state.items = [
        {
          ...DEMO_MCP_ITEM,
          definition: {
            ...DEMO_MCP_ITEM.definition,
            credentialMode: 'connected_account' as const,
          },
        },
      ];
      host = await createGateHost({
        env,
        fetchImpl: recordingFetch(state, calls),
        listen: false,
        log: () => {},
      });
      await host.tick();
      expect(host.instances()).toEqual([{ gateId: 'demo-mcp', ready: true, operationCount: 2 }]);
      const listsBefore = toolsListCalls().length;

      const { token } = await mintGateHostToken({
        privateKey,
        gateId: 'demo-mcp',
        onBehalfOf: 'principal-1',
        subject: 'principal-1',
      });
      const stored = await host.app.inject({
        method: 'POST',
        url: '/i/demo-mcp/gate/connected-accounts',
        headers: { authorization: `Bearer ${token}` },
        payload: { onBehalfOf: 'principal-1', credential: { token: 'member-secret' } },
      });
      expect(stored.statusCode).toBe(200);
      expect(toolsListCalls()).toHaveLength(listsBefore);
    });

    it('a credential for a gate this host does not list is still 404 gate_not_found', async () => {
      host = await createGateHost({
        env,
        fetchImpl: makeFetch(state),
        listen: false,
        log: () => {},
      });
      await host.tick();
      const { token } = await mintGateHostToken({
        privateKey,
        gateId: 'not-listed',
        onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
        subject: 'admin-1',
      });
      const resp = await host.app.inject({
        method: 'POST',
        url: '/i/not-listed/gate/connected-accounts',
        headers: { authorization: `Bearer ${token}` },
        payload: { onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT, credential: { token: 'x' } },
      });
      expect(resp.statusCode).toBe(404);
      expect(resp.json().error.code).toBe('gate_not_found');
    });
  });
});
