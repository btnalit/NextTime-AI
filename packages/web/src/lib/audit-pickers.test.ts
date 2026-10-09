import { describe, expect, it, vi } from 'vitest';
import {
  optionMatches,
  platformAuditActionSuggestions,
  provenanceNodeSource,
  resourceIdSource,
} from './audit-pickers.js';
import type { CapabilityCaller } from './clients.js';
import type { Translate } from './i18n.js';

const t: Translate = (zh) => zh;

function caller(handlers: Record<string, (params: unknown) => unknown>): CapabilityCaller {
  return {
    call: vi.fn(async (name: string, params?: unknown) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

describe('resourceIdSource', () => {
  it('has no source until a type is chosen', () => {
    expect(resourceIdSource('', t)).toBeNull();
  });

  it('uses the type’s list capability with the audit log as fallback, or the audit log alone', () => {
    const gatekeeper = resourceIdSource('gatekeeper', t);
    expect(gatekeeper?.key).toContain('list_gatekeepers');
    expect(gatekeeper?.searchable).toBe(true);
    expect(gatekeeper?.fallback?.key).toBe('audit_query:resource:gatekeeper');

    const fact = resourceIdSource('fact', t);
    expect(fact?.key).toBe('audit_query:resource:fact');
    expect(fact?.fallback).toBeUndefined();
  });

  it('maps an Operation to the `${gatekeeperId}:${name}` id the kernel audits it under, named by its gate', async () => {
    const http = caller({
      list_operations: (params) => {
        expect(params).toEqual({ q: 'restart' });
        return { items: [{ gatekeeperId: 'gk-1', name: 'restart', status: 'published' }] };
      },
      list_gatekeepers: () => ({ items: [{ id: 'gk-1', name: 'docker-prod' }] }),
    });
    const options = await resourceIdSource('operation', t)?.load(http, ' restart ');
    expect(options).toEqual([
      { id: 'gk-1:restart', label: 'restart', detail: 'docker-prod · published' },
    ]);
  });

  it('maps an ontology type to its name (the kernel’s resourceId for it)', async () => {
    const http = caller({
      list_types: () => ({ items: [{ kind: 'object', name: 'Host', description: '' }] }),
    });
    const options = await resourceIdSource('ontology_type', t)?.load(http, '');
    expect(options).toEqual([{ id: 'Host', label: 'Host', detail: 'object' }]);
  });

  it('the audit-log source keeps one option per id, newest first', async () => {
    const row = (id: string, resourceId: string, action: string) => ({
      id,
      actorPrincipalId: 'p-1',
      action,
      resourceType: 'fact',
      resourceId,
      payload: {},
      createdAt: '2026-09-03T00:00:00.000Z',
    });
    const http = caller({
      audit_query: () => ({
        items: [row('a-1', 'f-1', 'verify_fact'), row('a-2', 'f-1', 'attest_fact')],
      }),
      resolve_refs: () => ({ items: [] }),
    });
    const options = await provenanceNodeSource('fact', t).load(http, '');
    expect(options.map((o) => [o.id, o.label])).toEqual([['f-1', 'verify_fact']]);
  });
});

describe('platformAuditActionSuggestions', () => {
  it('is sorted, platform-scope only, and includes the lifecycle actions', () => {
    const names = platformAuditActionSuggestions();
    expect([...names]).toEqual([...names].sort());
    expect(names).toContain('list_users');
    expect(names).toContain('platform.user_purged');
    expect(names).not.toContain('explain');
  });
});

describe('optionMatches', () => {
  it('matches id, label or detail case-insensitively', () => {
    const option = { id: 'abc-123', label: 'Web-01', detail: 'Host' };
    expect(optionMatches(option, 'web')).toBe(true);
    expect(optionMatches(option, 'ABC')).toBe(true);
    expect(optionMatches(option, 'host')).toBe(true);
    expect(optionMatches(option, 'db')).toBe(false);
    expect(optionMatches(option, ' ')).toBe(true);
  });
});
