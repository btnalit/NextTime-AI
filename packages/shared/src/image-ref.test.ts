import { describe, expect, it } from 'vitest';
import { normalizeImageRef } from './image-ref.js';

describe('normalizeImageRef', () => {
  it('appends :latest to a bare name with no tag, no digest, no registry', () => {
    expect(normalizeImageRef('nexttime-ai-worker-runtime')).toBe(
      'nexttime-ai-worker-runtime:latest',
    );
  });

  it('leaves an already-tagged reference unchanged', () => {
    expect(normalizeImageRef('nexttime-ai-worker-runtime:v1')).toBe(
      'nexttime-ai-worker-runtime:v1',
    );
  });

  it('leaves an explicit :latest unchanged (idempotent)', () => {
    expect(normalizeImageRef('nexttime-ai-worker-runtime:latest')).toBe(
      'nexttime-ai-worker-runtime:latest',
    );
  });

  it('leaves a digest reference unchanged, even with no tag', () => {
    const digest =
      'nexttime-ai-worker-runtime@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(normalizeImageRef(digest)).toBe(digest);
  });

  it('leaves a registry+digest reference unchanged', () => {
    const digest = `registry.example.com/org/name@sha256:${'a'.repeat(64)}`;
    expect(normalizeImageRef(digest)).toBe(digest);
  });

  it('does not mistake a registry host:port for a tag — appends :latest after it', () => {
    expect(normalizeImageRef('host:5000/name')).toBe('host:5000/name:latest');
  });

  it('does not append :latest when a registry host:port reference already has an explicit tag', () => {
    expect(normalizeImageRef('host:5000/name:v1')).toBe('host:5000/name:v1');
  });

  it('a two-part name with no slash is a name:tag pair, not a registry — never touched', () => {
    // Per Docker's own grammar, `name:5000` with no `/` can only be name+tag (a registry
    // authority requires a following `/`), so this must be treated as already-tagged.
    expect(normalizeImageRef('name:5000')).toBe('name:5000');
  });

  it('appends :latest to a multi-segment repo path with no registry and no tag', () => {
    expect(normalizeImageRef('org/name')).toBe('org/name:latest');
  });

  it('leaves a multi-segment repo path with an explicit tag unchanged', () => {
    expect(normalizeImageRef('org/name:v2')).toBe('org/name:v2');
  });

  it('appends :latest to a fully-qualified registry+repo path with no tag', () => {
    expect(normalizeImageRef('registry.example.com/org/name')).toBe(
      'registry.example.com/org/name:latest',
    );
  });

  it('is idempotent — normalizing an already-normalized ref is a no-op', () => {
    const once = normalizeImageRef('nexttime-ai-worker-runtime');
    expect(normalizeImageRef(once)).toBe(once);
  });
});
