import { describe, expect, it } from 'vitest';
import { buildDockerGate } from './index.js';

/**
 * Smoke test for `buildDockerGate`'s wiring — never listens on a real port or touches
 * `/var/run/docker.sock` (`dockerode`'s `new Docker({socketPath})` does not connect eagerly;
 * nothing here calls a docker-client method).
 */

describe('buildDockerGate', () => {
  it('loads the bundled manifest.json and exposes every operation via describe_operations', async () => {
    const { gate, app } = await buildDockerGate({} as NodeJS.ProcessEnv);
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
});
