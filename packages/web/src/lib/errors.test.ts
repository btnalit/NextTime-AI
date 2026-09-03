import { describe, expect, it } from 'vitest';
import { describeError, errorMessage, isForbiddenError } from './errors.js';
import { HttpError } from './http-client.js';
import { RpcError, TurnAlreadyRunningError } from './ws-client.js';

describe('describeError', () => {
  it('surfaces the HTTP wire code and the kernel message verbatim', () => {
    const described = describeError(
      new HttpError('capability_error', 'principal role "member" does not satisfy', 'forbidden'),
    );
    expect(described).toEqual({
      code: 'forbidden',
      title: 'Not permitted',
      message: 'principal role "member" does not satisfy',
    });
    expect(isForbiddenError(new HttpError('capability_error', 'x', 'forbidden'))).toBe(true);
  });

  it('uses the HttpError kind as the code for network/invalid_response failures', () => {
    expect(describeError(new HttpError('network', 'capability call failed')).code).toBe('network');
    expect(describeError(new HttpError('invalid_response', 'non-JSON')).title).toBe(
      'Unexpected response',
    );
  });

  it('maps JSON-RPC codes to the same stable names the HTTP transport uses', () => {
    expect(describeError(new RpcError(-32001, 'unauthorized')).code).toBe('unauthorized');
    expect(describeError(new RpcError(-32002, 'nope')).code).toBe('forbidden');
    expect(describeError(new RpcError(-32004, 'missing')).code).toBe('not_found');
    expect(describeError(new RpcError(-32602, 'bad')).code).toBe('invalid_params');
    expect(describeError(new TurnAlreadyRunningError('busy')).code).toBe('turn_already_running');
    expect(describeError(new RpcError(-32099, 'weird')).code).toBe('rpc_-32099');
  });

  it('derives a readable title for a wire code it has no curated label for', () => {
    expect(describeError(new HttpError('capability_error', 'x', 'depth_exceeded')).title).toBe(
      'Depth exceeded',
    );
  });

  it('classifies WsClient connection errors and falls back to unknown otherwise', () => {
    expect(describeError(new Error('WsClient: connection closed')).code).toBe('connection_closed');
    expect(describeError('plain string')).toEqual({
      code: 'unknown',
      title: 'Error',
      message: 'plain string',
    });
    expect(errorMessage(new Error('m'))).toBe('m');
  });
});
