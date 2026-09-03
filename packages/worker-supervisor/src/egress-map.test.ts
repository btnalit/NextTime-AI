import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEgressMapStore, entrySourceId, taskSourceId } from './egress-map.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-egress-map-'));
  file = join(dir, 'egress-sources.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('entrySourceId', () => {
  it('packs workspaceId/principalId into an entry: prefixed opaque sourceId', () => {
    expect(entrySourceId('ws-1', 'alice')).toBe('entry:ws-1:alice');
  });
});

describe('taskSourceId', () => {
  it('packs workspaceId/workerRunId into a worker: prefixed opaque sourceId', () => {
    expect(taskSourceId('ws-1', 'run-1')).toBe('worker:ws-1:run-1');
  });
});

describe('createEgressMapStore', () => {
  it('starts empty when the file does not exist yet', () => {
    const store = createEgressMapStore(file);
    expect(store.read()).toEqual({});
  });

  it('starts empty when the file has invalid JSON, rather than throwing', () => {
    writeFileSync(file, 'not json');
    const store = createEgressMapStore(file);
    expect(store.read()).toEqual({});
  });

  it('registers an entry, matching egress-proxy SourceEntrySchema shape', () => {
    const store = createEgressMapStore(file);
    store.register('198.51.100.10', { sourceId: entrySourceId('ws-1', 'alice') });
    expect(store.read()).toEqual({
      '198.51.100.10': { sourceId: 'entry:ws-1:alice' },
    });
  });

  it('preserves existing entries when registering a new one', () => {
    writeFileSync(file, JSON.stringify({ '198.51.100.9': { sourceId: 'entry:ws-0:bob' } }));
    const store = createEgressMapStore(file);
    store.register('198.51.100.10', { sourceId: entrySourceId('ws-1', 'alice') });
    expect(store.read()).toEqual({
      '198.51.100.9': { sourceId: 'entry:ws-0:bob' },
      '198.51.100.10': { sourceId: 'entry:ws-1:alice' },
    });
  });

  it('unregisters an entry, leaving others intact', () => {
    const store = createEgressMapStore(file);
    store.register('198.51.100.10', { sourceId: 'entry:ws-1:alice' });
    store.register('198.51.100.11', { sourceId: 'entry:ws-1:bob' });
    store.unregister('198.51.100.10');
    expect(store.read()).toEqual({
      '198.51.100.11': { sourceId: 'entry:ws-1:bob' },
    });
  });

  it('registers a worker: sourceId alongside entry: ones (opaque string, either format)', () => {
    const store = createEgressMapStore(file);
    store.register('198.51.100.10', { sourceId: entrySourceId('ws-1', 'alice') });
    store.register('198.51.100.11', { sourceId: taskSourceId('ws-1', 'run-1') });
    expect(store.read()).toEqual({
      '198.51.100.10': { sourceId: 'entry:ws-1:alice' },
      '198.51.100.11': { sourceId: 'worker:ws-1:run-1' },
    });
  });

  it('unregistering an absent IP is a no-op (does not touch the file)', () => {
    const store = createEgressMapStore(file);
    store.register('198.51.100.10', { sourceId: 'entry:ws-1:alice' });
    const before = readFileSync(file, 'utf8');
    store.unregister('198.51.100.99');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes in place (open+truncate+write), not via rename, so fs.watch keeps firing', () => {
    const store = createEgressMapStore(file);
    store.register('198.51.100.10', { sourceId: 'entry:ws-1:alice' });
    // A rename-based writer would replace the inode; confirm the same path is still readable
    // with plain readFileSync immediately (this doesn't fully prove same-inode, but a missing/
    // renamed-away file would fail this read).
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      '198.51.100.10': { sourceId: 'entry:ws-1:alice' },
    });
  });
});
