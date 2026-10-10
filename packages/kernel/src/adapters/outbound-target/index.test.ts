import { describe, expect, it, vi } from 'vitest';
import {
  OutboundTargetRefusedError,
  createOutboundTargetGuard,
  outboundTargetPolicyFromEnv,
  withoutRedirects,
} from './index.js';

/** See `@nexttime/shared` net-address.test.ts: no literal RFC1918 text in this file. */
const quad = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join('.');

describe('adapters/outbound-target (R-27)', () => {
  it('reads both platform subnets and the operator allow-list from the environment', () => {
    const policy = outboundTargetPolicyFromEnv({
      NEXTTIME_SUBNET_CONTROL: `${quad(10, 77, 0, 0)}/24`,
      NEXTTIME_SUBNET_WORKERS: ` ${quad(10, 78, 0, 0)}/24 `,
      NEXTTIME_CONNECTION_ALLOW_HOSTS: ' accept-s2-ssh-gate, ,accept-s2-mcp ',
    });
    expect(policy.platformSubnets).toHaveLength(2);
    expect(policy.allowHosts).toEqual(['accept-s2-ssh-gate', 'accept-s2-mcp']);
    expect(outboundTargetPolicyFromEnv({})).toEqual({ platformSubnets: [], allowHosts: [] });
  });

  it('allows the union of the operator list and the fixed acceptance-fixture list', () => {
    const policy = outboundTargetPolicyFromEnv({
      NEXTTIME_CONNECTION_ALLOW_HOSTS: 'lab-gate',
      NEXTTIME_CONNECTION_FIXTURE_HOSTS: 'accept-s2-ssh-gate,accept-s2-mcp',
    });
    expect(policy.allowHosts).toEqual(['lab-gate', 'accept-s2-ssh-gate', 'accept-s2-mcp']);
  });

  // R-27 without a kernel restart: the compose-level fixture list alone admits the acceptance
  // fixtures; platform services stay refused (worker-supervisor is never on it).
  it('admits a fixture host with an empty operator list, and still refuses platform services', async () => {
    const resolve = vi.fn(async () => [quad(10, 77, 0, 9)]);
    const guard = createOutboundTargetGuard({
      policy: outboundTargetPolicyFromEnv({
        NEXTTIME_SUBNET_CONTROL: `${quad(10, 77, 0, 0)}/24`,
        NEXTTIME_CONNECTION_ALLOW_HOSTS: '',
        NEXTTIME_CONNECTION_FIXTURE_HOSTS:
          'accept-s2-ssh-gate,accept-s2-http-gate,accept-s2-openapi,accept-s2-mcp',
      }),
      resolve,
    });
    await expect(guard('http://accept-s2-ssh-gate:8090', 'endpoint')).resolves.toBeUndefined();
    await expect(guard('http://accept-s2-mcp:8080', 'manifestSource')).resolves.toBeUndefined();
    for (const url of [
      'http://worker-supervisor:8081/task/1/terminate',
      'http://kernel:8080/api/health',
      'http://localhost:8090',
    ]) {
      await expect(guard(url, 'manifestSource')).rejects.toMatchObject({
        code: 'connection_target_refused',
        reason: 'bare-hostname',
      });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a malformed subnet loudly instead of dropping the rule', () => {
    expect(() => outboundTargetPolicyFromEnv({ NEXTTIME_SUBNET_CONTROL: 'not-a-cidr' })).toThrow();
  });

  // fix/egress-suffix-match: the allow-side rule is strict, so `.x` / `*.x` used to be silently
  // inert here; it is logged and dropped now (never widened into "x and its subdomains", never
  // fatal — it only ever failed closed).
  it('logs and drops an allow-host entry that could never match, naming the variable and the entry', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const entries = ['.lab.example', '*.lab.example', 'http://lab.example', 'lab.example:8443'];
      const policy = outboundTargetPolicyFromEnv({
        NEXTTIME_CONNECTION_ALLOW_HOSTS: ['ok.example', ...entries].join(','),
        NEXTTIME_CONNECTION_FIXTURE_HOSTS: 'accept-s2-mcp,.bad',
      });
      expect(policy.allowHosts).toEqual(['ok.example', 'accept-s2-mcp']);
      const logged = errorSpy.mock.calls.map(
        (call) => JSON.parse(String(call[0])) as { level: string; msg: string },
      );
      expect(logged).toHaveLength(entries.length + 1);
      for (const [i, entry] of entries.entries()) {
        expect(logged[i]?.level).toBe('error');
        expect(logged[i]?.msg).toContain(`NEXTTIME_CONNECTION_ALLOW_HOSTS entry "${entry}"`);
      }
      expect(logged[entries.length]?.msg).toContain(
        'NEXTTIME_CONNECTION_FIXTURE_HOSTS entry ".bad"',
      );
      expect(logged[0]?.msg).toContain('write the bare name "lab.example"');

      errorSpy.mockClear();
      expect(
        outboundTargetPolicyFromEnv({
          NEXTTIME_CONNECTION_ALLOW_HOSTS: 'lab.example,203.0.113.9,::1',
        }).allowHosts,
      ).toEqual(['lab.example', '203.0.113.9', '::1']);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('throws OutboundTargetRefusedError naming the field and the host, never resolving a compose name', async () => {
    const resolve = vi.fn(async () => [quad(10, 77, 0, 9)]);
    const guard = createOutboundTargetGuard({
      policy: outboundTargetPolicyFromEnv({ NEXTTIME_SUBNET_CONTROL: `${quad(10, 77, 0, 0)}/24` }),
      resolve,
    });
    const thrown = await guard('http://worker-supervisor:8081/task/1/terminate', 'manifestSource')
      .then(() => undefined)
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(OutboundTargetRefusedError);
    expect(thrown).toMatchObject({ code: 'connection_target_refused', reason: 'bare-hostname' });
    expect((thrown as Error).message).toMatch(/^manifestSource "worker-supervisor" is refused: /);
    expect(resolve).not.toHaveBeenCalled();

    await expect(guard('https://gate.lab.example', 'endpoint')).rejects.toMatchObject({
      reason: 'platform-subnet',
    });
  });

  it('lets a public target through', async () => {
    const guard = createOutboundTargetGuard({
      policy: { platformSubnets: [] },
      resolve: async () => ['93.184.216.34'],
    });
    await expect(guard('https://api.example.com/openapi.json')).resolves.toBeUndefined();
  });

  it('withoutRedirects forces redirect: manual on every fetch it wraps', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    await withoutRedirects(fetchImpl)('https://api.example.com/openapi.json', {
      method: 'GET',
      redirect: 'follow',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.com/openapi.json', {
      method: 'GET',
      redirect: 'manual',
    });
  });
});
