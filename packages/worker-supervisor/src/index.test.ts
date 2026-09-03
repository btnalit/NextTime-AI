import { describe, expect, it } from 'vitest';
import {
  VERSION,
  buildTaskSpawnSpec,
  createDockerClient,
  createEgressMapStore,
  createResidentService,
  createServer,
  createTaskService,
  isImageAllowed,
  isSkillHostPathAllowed,
  loadConfig,
  main,
  taskContainerName,
  taskSourceId,
} from './index.js';

describe('@nexttime/worker-supervisor', () => {
  it('exposes a semantic version', () => {
    expect(VERSION).toBe('0.1.0');
  });

  it('exposes the wiring functions main() assembles (real startup needs a docker socket + ' +
    'NEXTTIME_DATA — exercised by resident-service.test.ts / server.test.ts against a fake ' +
    'DockerClient, and on the host in docs/private/host-s1-5a-*.md, not here)', () => {
    expect(typeof main).toBe('function');
    expect(typeof loadConfig).toBe('function');
    expect(typeof createDockerClient).toBe('function');
    expect(typeof createEgressMapStore).toBe('function');
    expect(typeof createResidentService).toBe('function');
    expect(typeof createServer).toBe('function');
  });

  it('exposes the one-shot Task mode (S2.8) wiring functions alongside resident mode', () => {
    expect(typeof createTaskService).toBe('function');
    expect(typeof buildTaskSpawnSpec).toBe('function');
    expect(typeof taskContainerName).toBe('function');
    expect(typeof taskSourceId).toBe('function');
    expect(typeof isImageAllowed).toBe('function');
    expect(typeof isSkillHostPathAllowed).toBe('function');
  });
});
