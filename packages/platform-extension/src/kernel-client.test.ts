import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelClient, KernelError } from './kernel-client.js';
import { type FakeKernel, startFakeKernel } from './test-support/fake-kernel.js';

describe('KernelClient', () => {
  let kernel: FakeKernel;

  beforeEach(async () => {
    kernel = await startFakeKernel();
  });

  afterEach(async () => {
    await kernel.close();
  });

  it('POSTs to /api/cap/<name> with a Bearer handle and resolves with `result` on {ok:true}', async () => {
    kernel.setHandler('get_object', () => ({
      ok: true,
      result: { objectId: 'obj-1', kind: 'Host' },
    }));
    const client = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'secret-handle' });

    const result = await client.call('get_object', { objectId: 'obj-1' });

    expect(result).toEqual({ objectId: 'obj-1', kind: 'Host' });
    expect(kernel.requests).toHaveLength(1);
    expect(kernel.requests[0]?.capability).toBe('get_object');
    expect(kernel.requests[0]?.params).toEqual({ objectId: 'obj-1' });
    expect(kernel.requests[0]?.authorization).toBe('Bearer secret-handle');
  });

  it('throws a capability_error KernelError carrying code and message on {ok:false}', async () => {
    kernel.setHandler('get_object', () => ({
      ok: false,
      error: { code: 'not_found', message: 'no such object' },
    }));
    const client = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' });

    const error = await client.call('get_object', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).kind).toBe('capability_error');
    expect((error as KernelError).code).toBe('not_found');
    expect((error as KernelError).message).toBe('no such object');
  });

  it('throws invalid_response on a non-JSON body', async () => {
    kernel.setHandler('search', () => ({ raw: true, status: 200, body: undefined }));
    const client = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' });

    const error = await client.call('search', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).kind).toBe('invalid_response');
  });

  it('throws invalid_response on a well-formed JSON body that is not the envelope shape', async () => {
    kernel.setHandler('search', () => ({ raw: true, status: 200, body: { unexpected: true } }));
    const client = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' });

    const error = await client.call('search', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).kind).toBe('invalid_response');
  });

  it('throws a timeout KernelError when the kernel does not respond within timeoutMs', async () => {
    kernel.setHandler(
      'traverse',
      () =>
        new Promise<{ ok: true; result: unknown }>((resolve) =>
          setTimeout(() => resolve({ ok: true, result: {} }), 200),
        ),
    );
    const client = new KernelClient({
      kernelUrl: kernel.url,
      capabilityHandle: 'h',
      timeoutMs: 20,
    });

    const error = await client.call('traverse', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).kind).toBe('timeout');
  });

  it('throws network on an unroutable kernelUrl', async () => {
    const client = new KernelClient({
      kernelUrl: 'http://127.0.0.1:1',
      capabilityHandle: 'h',
      timeoutMs: 2000,
    });

    const error = await client.call('get_object', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).kind).toBe('network');
  });

  it('never includes the capability handle in a thrown error message', async () => {
    kernel.setHandler('get_object', () => ({
      ok: false,
      error: { code: 'denied', message: 'forbidden' },
    }));
    const client = new KernelClient({
      kernelUrl: kernel.url,
      capabilityHandle: 'very-secret-handle-xyz',
    });

    const error = await client.call('get_object', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).message).not.toContain('very-secret-handle-xyz');
    expect(String(error)).not.toContain('very-secret-handle-xyz');
  });

  it('returns a 404 from the fake kernel as a capability_error for an unhandled capability', async () => {
    const client = new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' });

    const error = await client.call('no_such_capability', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).kind).toBe('capability_error');
    expect((error as KernelError).code).toBe('not_found');
  });
});
