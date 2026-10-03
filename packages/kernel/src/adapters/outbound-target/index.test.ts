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

  it('refuses a malformed subnet loudly instead of dropping the rule', () => {
    expect(() => outboundTargetPolicyFromEnv({ NEXTTIME_SUBNET_CONTROL: 'not-a-cidr' })).toThrow();
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

  it('withoutRedirects forces redirect: error on every fetch it wraps', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    await withoutRedirects(fetchImpl)('https://api.example.com/openapi.json', {
      method: 'GET',
      redirect: 'follow',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.com/openapi.json', {
      method: 'GET',
      redirect: 'error',
    });
  });
});
