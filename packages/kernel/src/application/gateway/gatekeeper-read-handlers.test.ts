import { afterEach, describe, expect, it } from 'vitest';
import {
  type GatekeeperClient,
  GatekeeperClientError,
  platformGateTarget,
} from '../../adapters/gatekeeper-client/index.js';
import {
  probeGatekeeper,
  probeGatekeeperHealth,
  setGatekeeperReadHandlerDeps,
} from './gatekeeper-read-handlers.js';

/** A client whose only working call is `health`, answering `answer` (or throwing it). */
function clientAnswering(answer: () => Promise<unknown>): GatekeeperClient {
  const unused = async () => {
    throw new Error('not called by the probe');
  };
  return {
    describeOperations: unused,
    observe: unused,
    simulate: unused,
    apply: unused,
    lookupApply: unused,
    revert: unused,
    health: answer as GatekeeperClient['health'],
    storeConnectedAccount: unused,
    deleteConnectedAccount: unused,
  };
}

const GATE = platformGateTarget('http://127.0.0.1:9/');

describe('probeGatekeeper — what a gate says about checking digests (legacy 215)', () => {
  afterEach(() => setGatekeeperReadHandlerDeps({}));

  async function probe(answer: () => Promise<unknown>) {
    setGatekeeperReadHandlerDeps({ gatekeeperClient: clientAnswering(answer) });
    return probeGatekeeper(GATE);
  }

  it('declared when the health answer says so, whatever the status', async () => {
    expect(await probe(async () => ({ status: 'ok', checksOperationDigest: true }))).toEqual({
      health: 'ok',
      operationDigestCheck: 'declared',
    });
    expect(
      await probe(async () => ({
        status: 'degraded',
        detail: 'slow',
        checksOperationDigest: true,
      })),
    ).toEqual({ health: 'unreachable', operationDigestCheck: 'declared' });
  });

  it('undeclared when the gate answered without saying so — an older gatekeeper-base', async () => {
    expect(await probe(async () => ({ status: 'ok' }))).toEqual({
      health: 'ok',
      operationDigestCheck: 'undeclared',
    });
  });

  it('only a literal true declares; an answer that is not an object declares nothing', async () => {
    for (const value of ['true', 1, {}, false, null]) {
      expect(await probe(async () => ({ status: 'ok', checksOperationDigest: value }))).toEqual({
        health: 'ok',
        operationDigestCheck: 'undeclared',
      });
    }
    for (const answer of [null, 'ok', 42]) {
      expect(await probe(async () => answer)).toEqual({
        health: 'unreachable',
        operationDigestCheck: 'undeclared',
      });
    }
  });

  it('nothing to read without an answer: unauthorized on a 401, unreachable otherwise', async () => {
    const refused = new GatekeeperClientError('no', { code: 'unauthorized', status: 401 });
    expect(
      await probe(async () => {
        throw refused;
      }),
    ).toEqual({ health: 'unauthorized', operationDigestCheck: null });
    expect(
      await probe(async () => {
        throw new Error('connection refused');
      }),
    ).toEqual({ health: 'unreachable', operationDigestCheck: null });
  });

  it('probeGatekeeperHealth reads the same answer, health only', async () => {
    setGatekeeperReadHandlerDeps({
      gatekeeperClient: clientAnswering(async () => ({ status: 'ok' })),
    });
    expect(await probeGatekeeperHealth(GATE)).toBe('ok');
  });
});
