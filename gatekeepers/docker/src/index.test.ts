import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildDockerGate } from './index.js';

/**
 * Smoke test for `buildDockerGate`'s wiring — never listens on a real port or touches
 * `/var/run/docker.sock` or a real `docker-socket-proxy-gate` (`dockerode`'s `new
 * Docker({socketPath})` / `new Docker({host,port})` do not connect eagerly; nothing here calls a
 * docker-client method).
 */

const dir = mkdtempSync(join(tmpdir(), 'gatekeeper-docker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tokenFile = join(dir, 'gate.token');
writeFileSync(tokenFile, `${'a'.repeat(40)}\n`);

function envWithToken(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { GATE_KERNEL_TOKEN_FILE: tokenFile, ...overrides } as NodeJS.ProcessEnv;
}

describe('buildDockerGate', () => {
  it('loads the bundled manifest.json and exposes every operation via describe_operations', async () => {
    const { gate, app } = await buildDockerGate(envWithToken());
    try {
      const ops = gate.describeOperations();
      expect(ops.map((op) => op.name).sort()).toEqual([
        'compose.down',
        'compose.ls',
        'compose.up',
        'container.inspect',
        'container.logs_tail',
        'container.restart',
        'containers.list',
      ]);
    } finally {
      await app.close();
    }
  });

  it('refuses to build without a readable gate auth token (review lane 5, P1-1)', async () => {
    await expect(
      buildDockerGate({ GATE_KERNEL_TOKEN_FILE: join(dir, 'missing.token') } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/gate auth token file/);
  });

  // fix/gate-docker-socket-proxy: DOCKER_HOST=tcp://docker-socket-proxy-gate:2375 (docker-
  // compose.yml) must resolve to the `tcp` DockerConnection branch, not silently fall back to the
  // (now-unmounted) plain socket path. Still no eager connection — `new Docker({host,port})`
  // doesn't dial anything at construction time either, same as the `socketPath` variant.
  it('wires DOCKER_HOST into a tcp connection instead of the plain socket fallback', async () => {
    const { gate, app } = await buildDockerGate(
      envWithToken({ DOCKER_HOST: 'tcp://docker-socket-proxy-gate:2375' }),
    );
    try {
      expect(gate.describeOperations().length).toBe(7);
    } finally {
      await app.close();
    }
  });
});
