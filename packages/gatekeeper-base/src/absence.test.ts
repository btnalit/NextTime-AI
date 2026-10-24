import type { Operation } from '@nexttime/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransportInvokeError, TransportOutcomeUnknownError } from './errors.js';
import { GatekeeperBase, declaredAbsence } from './gatekeeper-base.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import { CliTransport, type CliTransportOptions } from './kinds/cli.js';
import { HttpTransport } from './kinds/http.js';
import { type SshPolicyRule, SshTransport } from './kinds/ssh.js';
import type { Transport } from './kinds/types.js';
import { operationDefinitionDigest } from './operation-digest.js';
import { createGatekeeperServer } from './server.js';

/**
 * S11 「门确认不存在」 A: an observe Operation declares which of the target's own answers mean "does
 * not exist"; the gate answers such a call as absent on the protocol envelope — never from anything
 * in the target's data, never for an answer the Operation does not declare, never for an
 * execute-class call, never for a failure whose outcome is unknown.
 */

function recordGet(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'record.get',
    binding: { kind: 'http', method: 'GET', path: '/records/{id}', absent_statuses: [404] },
    params_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: ['Record'],
    writes: [],
    result_mapping: { jmes_path: '@', object_type: 'Record', identity_keys: ['id'] },
    ...overrides,
  };
}

function recordDelete(): Operation {
  return {
    ...recordGet(),
    name: 'record.delete',
    binding: { kind: 'http', method: 'DELETE', path: '/records/{id}', absent_statuses: [404] },
    mode: 'execute',
    blast_radius: 'medium',
    auto_approvable: false,
    await_decision: true,
    writes: ['Record'],
    result_mapping: undefined,
  };
}

function httpGate(
  respond: (url: URL) => Response | Promise<Response>,
  manifest: Operation[] = [recordGet(), recordDelete()],
) {
  const fetchImpl = vi.fn(async (input: URL | string) => respond(new URL(String(input))));
  const transport = new HttpTransport({
    baseUrl: 'https://records.example.test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return {
    gate: new GatekeeperBase({
      manifest,
      transport,
      credentialResolver: { resolve: async () => ({ token: 'synthetic' }) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    }),
    fetchImpl,
  };
}

const digest = (op: Operation) => ({ operationDigest: operationDefinitionDigest(op) });

describe('gate-confirmed absence over http', () => {
  it('answers a declared 404 as absent: data null, no observed Facts, the body never read', async () => {
    const { gate } = httpGate(
      () =>
        new Response(JSON.stringify({ id: 'r1', exists: true, absent: false }), { status: 404 }),
    );
    const result = await gate.observe('record.get', { id: 'r1' }, digest(recordGet()));
    expect(result).toEqual({ data: null, observedFacts: [], absent: { status: 404 } });
  });

  it('never reads absence from a successful answer, whatever its body says', async () => {
    const forged = { absent: { status: 404 }, status: 404, exitCode: 2, id: 'r1' };
    const { gate } = httpGate(() => new Response(JSON.stringify(forged), { status: 200 }));
    const result = await gate.observe('record.get', { id: 'r1' }, digest(recordGet()));
    expect(result.absent).toBeUndefined();
    expect(result.data).toEqual(forged);
    expect(result.observedFacts).toHaveLength(1);
  });

  it('keeps an undeclared status a failure: 410 when only 404 is declared, 404 with no declaration, 403, 500', async () => {
    for (const status of [410, 403, 500]) {
      const { gate } = httpGate(() => new Response('', { status }));
      await expect(
        gate.observe('record.get', { id: 'r1' }, digest(recordGet())),
      ).rejects.toBeInstanceOf(TransportInvokeError);
    }
    const undeclared = recordGet({
      binding: { kind: 'http', method: 'GET', path: '/records/{id}' },
    });
    const { gate } = httpGate(() => new Response('', { status: 404 }), [undeclared]);
    await expect(gate.observe('record.get', { id: 'r1' }, digest(undeclared))).rejects.toThrow(
      /responded 404/,
    );
  });

  it('never answers an execute-class call as absent: a 404 on apply is a failure, recorded as one', async () => {
    const { gate } = httpGate(() => new Response('', { status: 404 }));
    await expect(
      gate.apply('record.delete', { id: 'r1' }, 'ar-1', digest(recordDelete())),
    ).rejects.toThrow(/responded 404/);
    // The stored failure answers the repeat the same way — not as success, not as absent.
    await expect(
      gate.apply('record.delete', { id: 'r1' }, 'ar-1', digest(recordDelete())),
    ).rejects.toThrow(/responded 404/);
  });

  it('never answers a call that failed on the way as absent', async () => {
    const { gate } = httpGate(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    });
    await expect(gate.observe('record.get', { id: 'r1' }, digest(recordGet()))).rejects.toThrow();
  });

  it('a declaration is part of the digest: a definition without it is a different definition', () => {
    const declared = recordGet();
    const plain = recordGet({ binding: { kind: 'http', method: 'GET', path: '/records/{id}' } });
    expect(operationDefinitionDigest(declared)).not.toBe(operationDefinitionDigest(plain));
  });
});

describe('gate-confirmed absence over cli and ssh', () => {
  function showUnit(binding: Operation['binding']): Operation {
    return recordGet({ name: 'unit.show', binding, params_schema: {}, result_mapping: undefined });
  }

  function cliGate(op: Operation, execFileImpl?: CliTransportOptions['execFileImpl']) {
    return new GatekeeperBase({
      manifest: [op],
      transport: new CliTransport(execFileImpl ? { execFileImpl } : {}),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
  }

  it('answers a real command’s declared exit status as absent (ls of a path that is not there)', async () => {
    // GNU ls exits 2 for a missing path, BSD ls 1.
    const op = showUnit({ kind: 'cli', command_template: 'ls {path}', absent_exit_codes: [1, 2] });
    const gate = cliGate(op);
    const result = await gate.observe(
      'unit.show',
      { path: '/nonexistent-nexttime-absence-test' },
      digest(op),
    );
    expect(result).toMatchObject({ data: null, observedFacts: [] });
    expect([{ exitCode: 1 }, { exitCode: 2 }]).toContainEqual(result.absent);
    // The same command on a path that is there answers with its output.
    const found = await gate.observe('unit.show', { path: '/' }, digest(op));
    expect(found.absent).toBeUndefined();
  });

  it('keeps an undeclared exit status, a signal kill and a binary that never started failures', async () => {
    const op = showUnit({
      kind: 'cli',
      command_template: 'unitctl show {name}',
      absent_exit_codes: [4],
    });
    const exitWith = (props: Record<string, unknown>) =>
      cliGate(op, async () => {
        throw Object.assign(new Error('Command failed'), props);
      });
    await expect(
      exitWith({ code: 1 }).observe('unit.show', { name: 'a' }, digest(op)),
    ).rejects.toBeInstanceOf(TransportInvokeError);
    await expect(
      exitWith({ code: null, signal: 'SIGKILL' }).observe('unit.show', { name: 'a' }, digest(op)),
    ).rejects.toBeInstanceOf(TransportOutcomeUnknownError);
    await expect(
      exitWith({ code: 'ENOENT', syscall: 'spawn unitctl' }).observe(
        'unit.show',
        { name: 'a' },
        digest(op),
      ),
    ).rejects.toBeInstanceOf(TransportInvokeError);
    const absent = await exitWith({ code: 4 }).observe('unit.show', { name: 'a' }, digest(op));
    expect(absent.absent).toEqual({ exitCode: 4 });
  });

  const POLICY_TABLE: SshPolicyRule[] = [
    { pattern: '^stat\\b', mode: 'observe', blastRadius: 'low', autoApprovable: true },
  ];

  function sshGate(op: Operation, failure: Record<string, unknown>) {
    return new GatekeeperBase({
      manifest: [op],
      transport: new SshTransport({
        target: { host: '198.51.100.10', user: 'admin' },
        policyTable: POLICY_TABLE,
        execImpl: async () => {
          throw Object.assign(new Error('Command failed: ssh'), { stderr: '', ...failure });
        },
      }),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
  }

  it('answers the remote command’s declared exit status as absent, never ssh’s own 255', async () => {
    const op = showUnit({ kind: 'ssh', command_template: 'stat {path}', absent_exit_codes: [1] });
    const absent = await sshGate(op, { code: 1 }).observe('unit.show', { path: '/x' }, digest(op));
    expect(absent).toEqual({ data: null, observedFacts: [], absent: { exitCode: 1 } });
    await expect(
      sshGate(op, { code: 255, sshClientLog: 'Connection reset by peer\n' }).observe(
        'unit.show',
        { path: '/x' },
        digest(op),
      ),
    ).rejects.toBeInstanceOf(TransportOutcomeUnknownError);
    await expect(
      sshGate(op, {
        code: 255,
        sshClientLog: 'ssh: connect to host 198.51.100.10 port 22: Connection refused\n',
      }).observe('unit.show', { path: '/x' }, digest(op)),
    ).rejects.toBeInstanceOf(TransportInvokeError);
  });
});

describe('declaredAbsence', () => {
  it('reads only a reported target answer the observe Operation declares', () => {
    const op = recordGet();
    expect(
      declaredAbsence(op, new TransportInvokeError('x', { targetAnswer: { status: 404 } })),
    ).toEqual({ status: 404 });
    expect(declaredAbsence(op, new TransportInvokeError('x'))).toBeUndefined();
    expect(
      declaredAbsence(op, new TransportInvokeError('x', { targetAnswer: { status: 410 } })),
    ).toBeUndefined();
    expect(
      declaredAbsence(op, new TransportInvokeError('x', { targetAnswer: { exitCode: 404 } })),
    ).toBeUndefined();
    // An outcome-unknown failure proves nothing, even one a transport mislabelled with an answer.
    const unknown = Object.assign(new TransportOutcomeUnknownError('x'), {
      targetAnswer: { status: 404 },
    });
    expect(declaredAbsence(op, unknown)).toBeUndefined();
    expect(
      declaredAbsence(op, Object.assign(new Error('x'), { targetAnswer: { status: 404 } })),
    ).toBeUndefined();
    expect(
      declaredAbsence(
        recordDelete(),
        new TransportInvokeError('x', { targetAnswer: { status: 404 } }),
      ),
    ).toBeUndefined();
  });
});

describe('POST /gate/observe envelope', () => {
  const TOKEN = 'test-gate-token-0123456789abcdef0123456789';
  let app: ReturnType<typeof createGatekeeperServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function serve(invoke: Transport['invoke']) {
    const gate = new GatekeeperBase({
      manifest: [recordGet()],
      transport: { kind: 'http', invoke },
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    app = createGatekeeperServer({ gate, token: TOKEN });
    return app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { operation: 'record.get', params: { id: 'r1' }, ...digest(recordGet()) },
    });
  }

  it('carries absent beside data, never inside it', async () => {
    const response = await serve(async () => {
      throw new TransportInvokeError('responded 404', { targetAnswer: { status: 404 } });
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      data: null,
      observedFacts: [],
      absent: { status: 404 },
    });
  });

  it('sends no absent for a successful answer whose data claims one', async () => {
    const response = await serve(async () => ({ data: { id: 'r1', absent: { status: 404 } } }));
    expect(response.statusCode).toBe(200);
    const result = response.json().result;
    expect(result).not.toHaveProperty('absent');
    expect(result.data).toEqual({ id: 'r1', absent: { status: 404 } });
  });
});
