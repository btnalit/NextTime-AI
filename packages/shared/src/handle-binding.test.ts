import { describe, expect, it } from 'vitest';
import {
  type HandleBinding,
  HandleBindingFileError,
  type HandleBindingSource,
  SOURCE_BOUND_CAPABILITY_HANDLE,
  createHandleBindingReader,
  decideHandlePresentation,
  normalizePeerAddress,
} from './handle-binding.js';

const binding: HandleBinding = {
  handle: 'header.payload.signature',
  sourceId: 'entry:ws-1:principal-1',
  containerId: 'c0ffee',
  boundAt: '2026-10-09T00:00:00.000Z',
};

/** An in-memory file whose version bumps on every write, like inode+mtime after a rename. */
function memoryFile(initial?: string) {
  let content = initial;
  let version = 0;
  let reads = 0;
  const source: HandleBindingSource = {
    version: () => (content === undefined ? undefined : String(version)),
    read: () => {
      reads += 1;
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
  };
  return {
    source,
    write(next: string | undefined) {
      content = next;
      version += 1;
    },
    get reads() {
      return reads;
    },
  };
}

describe('SOURCE_BOUND_CAPABILITY_HANDLE', () => {
  it('is not shaped like a JWT, so nothing mistakes it for a Handle', () => {
    expect(SOURCE_BOUND_CAPABILITY_HANDLE.split('.')).toHaveLength(1);
  });
});

describe('normalizePeerAddress', () => {
  it('unwraps an IPv4-mapped IPv6 peer and leaves everything else as it is', () => {
    expect(normalizePeerAddress('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizePeerAddress('::FFFF:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizePeerAddress('192.0.2.7')).toBe('192.0.2.7');
    expect(normalizePeerAddress('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('decideHandlePresentation', () => {
  it('uses the binding whenever the peer has one', () => {
    expect(decideHandlePresentation({ binding, fromWorkersSubnet: true })).toEqual({
      kind: 'source',
      binding,
    });
    expect(decideHandlePresentation({ binding, fromWorkersSubnet: false })).toEqual({
      kind: 'source',
      binding,
    });
  });

  it('refuses an unbound peer on the workers network instead of falling back to a header', () => {
    expect(decideHandlePresentation({ binding: undefined, fromWorkersSubnet: true })).toEqual({
      kind: 'refused',
      reason: 'unbound_source',
    });
  });

  it('reads the header for an unbound peer elsewhere', () => {
    expect(decideHandlePresentation({ binding: undefined, fromWorkersSubnet: false })).toEqual({
      kind: 'bearer',
    });
  });
});

describe('createHandleBindingReader', () => {
  it('finds a binding by peer address, IPv4-mapped or not', async () => {
    const file = memoryFile(JSON.stringify({ '192.0.2.7': binding }));
    const reader = createHandleBindingReader({ source: file.source });
    await expect(reader.lookup('192.0.2.7')).resolves.toEqual(binding);
    await expect(reader.lookup('::ffff:192.0.2.7')).resolves.toEqual(binding);
    await expect(reader.lookup('192.0.2.8')).resolves.toBeUndefined();
  });

  it('re-reads only when the file version changes, and drops a removed binding at once', async () => {
    const file = memoryFile(JSON.stringify({ '192.0.2.7': binding }));
    const reader = createHandleBindingReader({ source: file.source });
    await reader.lookup('192.0.2.7');
    await reader.lookup('192.0.2.7');
    expect(file.reads).toBe(1);

    file.write(JSON.stringify({}));
    await expect(reader.lookup('192.0.2.7')).resolves.toBeUndefined();
    expect(file.reads).toBe(2);
  });

  it('never resolves an inherited object key as a binding', async () => {
    const file = memoryFile(JSON.stringify({ '192.0.2.7': binding }));
    const reader = createHandleBindingReader({ source: file.source });
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      await expect(reader.lookup(key)).resolves.toBeUndefined();
    }
  });

  it('binds nothing from a malformed file and reports it once (fail closed)', async () => {
    const errors: HandleBindingFileError[] = [];
    const file = memoryFile(JSON.stringify({ '192.0.2.7': binding }));
    const reader = createHandleBindingReader({
      source: file.source,
      onError: (err) => errors.push(err),
    });
    await expect(reader.lookup('192.0.2.7')).resolves.toEqual(binding);

    file.write(`{"192.0.2.7": {"handle": "${binding.handle}`);
    await expect(reader.lookup('192.0.2.7')).resolves.toBeUndefined();
    await expect(reader.lookup('192.0.2.7')).resolves.toBeUndefined();
    expect(errors.map((err) => err.reason)).toEqual(['malformed']);

    file.write(JSON.stringify({ '192.0.2.7': { ...binding, extra: 'field' } }));
    await expect(reader.lookup('192.0.2.7')).resolves.toBeUndefined();
    expect(errors.map((err) => err.reason)).toEqual(['malformed', 'invalid']);

    // V8's JSON.parse errors quote the input; what the reader reports never does.
    for (const err of errors) {
      expect(err).toBeInstanceOf(HandleBindingFileError);
      expect(err.message).not.toContain(binding.handle);
    }
  });

  it('binds nothing while the file is missing', async () => {
    const file = memoryFile(undefined);
    const reader = createHandleBindingReader({ source: file.source });
    await expect(reader.lookup('192.0.2.7')).resolves.toBeUndefined();
  });

  it('waits for a registration that lands within the window, and only when asked to', async () => {
    let clock = 0;
    const file = memoryFile(JSON.stringify({}));
    const sleeps: number[] = [];
    const reader = createHandleBindingReader({
      source: file.source,
      registrationWaitMs: 1000,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
        if (clock === 300) file.write(JSON.stringify({ '192.0.2.7': binding }));
      },
    });

    await expect(reader.lookup('192.0.2.7')).resolves.toBeUndefined();
    expect(sleeps).toEqual([]);

    await expect(reader.lookup('192.0.2.7', { waitForRegistration: true })).resolves.toEqual(
      binding,
    );
    expect(sleeps).toEqual([100, 100, 100]);
  });

  it('gives up on a registration that never lands', async () => {
    let clock = 0;
    const file = memoryFile(JSON.stringify({}));
    const reader = createHandleBindingReader({
      source: file.source,
      registrationWaitMs: 500,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await expect(
      reader.lookup('192.0.2.7', { waitForRegistration: true }),
    ).resolves.toBeUndefined();
    expect(clock).toBe(500);
  });
});
