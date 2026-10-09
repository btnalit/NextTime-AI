import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandleBindingFileSchema } from '@nexttime/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddressHeldError, bindExclusive, createHandleBindingStore } from './handle-bindings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-bindings-'));
  file = join(dir, 'bindings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date('2026-10-09T00:00:00.000Z');

function readBindings() {
  return HandleBindingFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

describe('createHandleBindingStore', () => {
  it('writes a schema-valid, owner-only file by rename, with nothing left beside it', () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', { handle: 'h.a.1', sourceId: 'entry:ws:alice', containerId: 'c1' });
    expect(readBindings()).toEqual({
      '192.0.2.7': {
        handle: 'h.a.1',
        sourceId: 'entry:ws:alice',
        containerId: 'c1',
        boundAt: '2026-10-09T00:00:00.000Z',
      },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['bindings.json']);

    const inode = statSync(file).ino;
    store.bind('192.0.2.8', { handle: 'h.b.2', sourceId: 'worker:ws:run', containerId: 'c2' });
    expect(statSync(file).ino).not.toBe(inode);
    expect(store.unbind('192.0.2.7', 'c1')).toBe(true);
    expect(Object.keys(readBindings())).toEqual(['192.0.2.8']);
  });

  it('unbinds an address only for the container bound there (compare-and-delete)', () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', { handle: 'h', sourceId: 'entry:ws:bob', containerId: 'c-bob' });
    const inode = statSync(file).ino;
    // Alice's container held this address before; her late unbind must not touch Bob's binding.
    expect(store.unbind('192.0.2.7', 'c-alice')).toBe(false);
    expect(readBindings()['192.0.2.7']).toMatchObject({ containerId: 'c-bob' });
    expect(statSync(file).ino).toBe(inode);
    expect(store.unbind('192.0.2.9', 'c-bob')).toBe(false);
    expect(store.unbind('192.0.2.7', 'c-bob')).toBe(true);
    expect(readBindings()).toEqual({});
  });

  it('unbinds a binding that names no container for any caller (nothing can confirm whose it is)', () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', { handle: 'h', sourceId: 'entry:ws:alice' });
    expect(store.unbind('192.0.2.7', 'c-any')).toBe(true);
    expect(store.snapshot().size).toBe(0);
  });

  it('replaces whatever was bound to an address', () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', { handle: 'old', sourceId: 'entry:ws:alice', containerId: 'c1' });
    store.bind('192.0.2.7', { handle: 'new', sourceId: 'entry:ws:bob', containerId: 'c2' });
    expect(readBindings()['192.0.2.7']).toMatchObject({ handle: 'new', containerId: 'c2' });
  });

  it('keeps the bindings of a previous run of this process (the file outlives a restart)', () => {
    createHandleBindingStore(file, { now }).bind('192.0.2.7', {
      handle: 'h',
      sourceId: 's',
      containerId: 'c1',
    });
    const restarted = createHandleBindingStore(file, { now });
    expect(restarted.snapshot().get('192.0.2.7')?.containerId).toBe('c1');
  });

  it('starts empty from a malformed file, reporting why without quoting it', () => {
    writeFileSync(file, '{"192.0.2.7": {"handle": "secret.handle.value"');
    const reasons: string[] = [];
    const store = createHandleBindingStore(file, { onLoadError: (reason) => reasons.push(reason) });
    expect(store.snapshot().size).toBe(0);
    expect(reasons).toEqual(['not valid JSON']);
    expect(reasons.join()).not.toContain('secret');
  });

  it('leaves file and memory unchanged when a write fails', () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', { handle: 'h', sourceId: 's', containerId: 'c1' });
    rmSync(dir, { recursive: true, force: true });
    expect(() =>
      store.bind('192.0.2.8', { handle: 'h2', sourceId: 's2', containerId: 'c2' }),
    ).toThrow();
    expect([...store.snapshot().keys()]).toEqual(['192.0.2.7']);
  });

  it('retainLive drops dead bindings, but not one re-bound while it was checking', async () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', { handle: 'h1', sourceId: 's', containerId: 'gone' });
    store.bind('192.0.2.8', { handle: 'h2', sourceId: 's', containerId: 'running' });
    store.bind('192.0.2.9', { handle: 'h3', sourceId: 's', containerId: 'replaced' });

    const dropped = await store.retainLive(async (ip, binding) => {
      if (ip === '192.0.2.9') {
        // A spawn binds a new container to the address while Docker is being asked.
        store.bind('192.0.2.9', { handle: 'h4', sourceId: 's', containerId: 'new' });
      }
      return binding.containerId === 'running';
    });

    expect(dropped).toEqual(['192.0.2.7']);
    expect(Object.keys(readBindings()).sort()).toEqual(['192.0.2.8', '192.0.2.9']);
    expect(readBindings()['192.0.2.9']?.containerId).toBe('new');
  });
});

describe('bindExclusive', () => {
  const binding = (handle: string, containerId: string) => ({
    handle,
    sourceId: `entry:ws:${containerId}`,
    containerId,
  });

  it('replaces the binding of a container that is gone (Docker reused its address)', async () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', binding('h.dead.1', 'dead'));
    const asked: string[] = [];
    await bindExclusive(store, '192.0.2.7', binding('h.new.1', 'new'), async (id) => {
      asked.push(id);
      return false;
    });
    expect(asked).toEqual(['dead']);
    expect(readBindings()['192.0.2.7']).toMatchObject({ handle: 'h.new.1', containerId: 'new' });
  });

  it('refuses an address another container still runs at, and leaves its binding alone', async () => {
    const store = createHandleBindingStore(file, { now });
    store.bind('192.0.2.7', binding('h.live.1', 'live'));
    await expect(
      bindExclusive(store, '192.0.2.7', binding('h.new.1', 'new'), async () => true),
    ).rejects.toBeInstanceOf(AddressHeldError);
    expect(readBindings()['192.0.2.7']).toMatchObject({ handle: 'h.live.1', containerId: 'live' });
  });

  it('rebinds the same container without asking Docker, and replaces a binding with no container id', async () => {
    const store = createHandleBindingStore(file, { now });
    const never = async () => {
      throw new Error('must not be asked');
    };
    store.bind('192.0.2.7', binding('h.c1.1', 'c1'));
    await bindExclusive(store, '192.0.2.7', binding('h.c1.2', 'c1'), never);
    expect(readBindings()['192.0.2.7']?.handle).toBe('h.c1.2');

    store.bind('192.0.2.8', { handle: 'h.legacy.1', sourceId: 'entry:ws:legacy' });
    await bindExclusive(store, '192.0.2.8', binding('h.c2.1', 'c2'), never);
    expect(readBindings()['192.0.2.8']?.containerId).toBe('c2');
  });
});
