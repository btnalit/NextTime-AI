import { describe, expect, it } from 'vitest';
import { parseDockerConnection } from './container-io.js';

/** fix/socket-proxy-and-backup-user: DOCKER_HOST parsing — docker-socket-proxy sits between
 *  agent-host and /var/run/docker.sock (docker-compose.yml's `dockerapi` network); every
 *  non-`tcp://` or unparsable value must fall back to the plain socket path instead of being
 *  guessed at. Mirrors @nexttime/worker-supervisor's identical `config.ts` test (same function,
 *  duplicated for the reason given on `DockerConnection`'s own doc comment in container-io.ts). */
describe('parseDockerConnection', () => {
  it('falls back to the socket path when DOCKER_HOST is unset', () => {
    expect(parseDockerConnection(undefined, '/var/run/docker.sock')).toEqual({
      kind: 'socket',
      socketPath: '/var/run/docker.sock',
    });
  });

  it('parses a tcp:// DOCKER_HOST into host/port', () => {
    expect(parseDockerConnection('tcp://docker-socket-proxy:2375', '/var/run/docker.sock')).toEqual(
      {
        kind: 'tcp',
        host: 'docker-socket-proxy',
        port: 2375,
      },
    );
  });

  it('defaults the port to 2375 when DOCKER_HOST omits one', () => {
    expect(parseDockerConnection('tcp://docker-socket-proxy', '/var/run/docker.sock')).toEqual({
      kind: 'tcp',
      host: 'docker-socket-proxy',
      port: 2375,
    });
  });

  it('falls back to the socket path for a unix:// DOCKER_HOST (not produced by this repo)', () => {
    expect(parseDockerConnection('unix:///var/run/docker.sock', '/tmp/docker.sock')).toEqual({
      kind: 'socket',
      socketPath: '/tmp/docker.sock',
    });
  });

  it('falls back to the socket path for an unparsable DOCKER_HOST', () => {
    expect(parseDockerConnection('tcp://', '/tmp/docker.sock')).toEqual({
      kind: 'socket',
      socketPath: '/tmp/docker.sock',
    });
    expect(parseDockerConnection('not a url', '/tmp/docker.sock')).toEqual({
      kind: 'socket',
      socketPath: '/tmp/docker.sock',
    });
  });
});
