import { describe, expect, it, vi } from 'vitest';
import {
  objectSource,
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
  it('an inherited name from the URL (?resourceType=__proto__) gets the audit-log source, not a crash', () => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      const source = resourceIdSource(name, t);
      expect(source?.key).toContain('audit_query');
      expect(source?.fallback).toBeUndefined();
    }
  });

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

  it('tells two same-name Worker definitions apart by short id (#554 acceptance P2)', async () => {
    const http = caller({
      list_worker_definitions: () => ({
        items: [
          { id: 'aaaaaaaa-1111', version: 1, kind: 'pi', definition: { name: 'ops-runner' } },
          { id: 'bbbbbbbb-2222', version: 1, kind: 'pi', definition: { name: 'ops-runner' } },
          { id: 'cccccccc-3333', version: 1, kind: 'pi', definition: { name: 'collector' } },
        ],
      }),
    });
    const options = await resourceIdSource('worker_definition', t)?.load(http, '');
    expect(options?.map((option) => option.label)).toEqual([
      'ops-runner · aaaaaaaa',
      'ops-runner · bbbbbbbb',
      'collector',
    ]);
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
      // Legacy sweep (console batch, 2026-10-16): the status reads as its label.
      { id: 'gk-1:restart', label: 'restart', detail: 'docker-prod · 已发布' },
    ]);
  });

  it('legacy sweep: a Decision picker option shows its status as a label, never the raw value', async () => {
    const http = caller({
      query_decisions: () => ({
        items: [
          {
            id: 'dec-1',
            status: 'superseded',
            summary: 'restart web',
            createdAt: '2026-09-03T00:00:00.000Z',
          },
        ],
      }),
    });
    const [option] = await provenanceNodeSource('decision', t).load(http, '');
    expect(option?.detail).toContain('已被取代');
    expect(option?.detail).not.toContain('superseded');
  });

  it('UX P3 on #672: a Decision about an ActionRequest reads as the verb, the request and its kind', async () => {
    const requestId = '0f8c3706-228e-497d-97e9-1fa5690c0679';
    const http = caller({
      query_decisions: () => ({
        items: [
          {
            id: 'dec-1',
            status: 'approved',
            summary: `approve action_request ${requestId}`,
            rationale: { actionRequestId: requestId, actionKind: 'docker.restart' },
            createdAt: '2026-09-03T00:00:00.000Z',
          },
          {
            id: 'dec-2',
            status: 'approved',
            summary: `reconcile action_request ${requestId}: effect_seen`,
            rationale: { actionRequestId: requestId, decision: 'reconcile' },
            createdAt: '2026-09-03T00:00:00.000Z',
          },
          {
            id: 'dec-3',
            status: 'approved',
            summary: 'restart web',
            createdAt: '2026-09-03T00:00:00.000Z',
          },
        ],
      }),
    });
    const options = await provenanceNodeSource('decision', t).load(http, '');
    const labels = options.map((option) => option.label);
    expect(labels[0]).toMatch(/^批准动作请求 0f8c3706 · docker restart$/);
    expect(labels[1]).toMatch(/^核对动作请求 0f8c3706$/);
    expect(labels[2]).toBe('restart web');
  });

  it('maps an ontology type to its name (the kernel’s resourceId for it)', async () => {
    const http = caller({
      list_types: () => ({ items: [{ kind: 'object', name: 'Host', description: '' }] }),
    });
    const options = await resourceIdSource('ontology_type', t)?.load(http, '');
    expect(options).toEqual([{ id: 'Host', label: 'Host', detail: '对象' }]);
  });

  it('legacy 247 (review #501 on #661): a masked connection-request address is labelled as hidden, never as `[redacted]`', async () => {
    const http = caller({
      list_connection_requests: () => ({
        items: [
          { id: 'req-1', kind: 'http', target: '[redacted]', status: 'pending' },
          {
            id: 'req-2',
            kind: 'http',
            target: 'https://hooks.example.com/[redacted]/x',
            status: 'pending',
          },
          { id: 'req-3', kind: 'http', target: 'https://api.example.com', status: 'pending' },
        ],
      }),
    });
    const options = await resourceIdSource('connection_request', t)?.load(http, '');
    expect(options?.map((option) => option.label)).toEqual([
      '地址带有凭据，已隐藏',
      '地址带有凭据，已隐藏',
      'https://api.example.com',
    ]);
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
    // Legacy sweep (console batch, 2026-10-16): the action reads as its label, not the raw name.
    expect(options.map((o) => [o.id, o.label])).toEqual([['f-1', '验证事实']]);
  });
});

describe('legacy 153 ②: candidate labels in the console’s words, not the ontology’s', () => {
  it('a platform ObjectType is named in Chinese, and a letterless identity name follows its type', async () => {
    const http = caller({
      search: () => ({
        items: [
          {
            id: 'o-1',
            objectType: 'WorkerDefinition',
            identityKey: { definitionId: '6d1f0a52-1111-4222-8333-944455556666', version: 1 },
            properties: { kind: 'entry' },
          },
          {
            id: 'o-2',
            objectType: 'ConnectedSystem',
            identityKey: { name: 'docker-prod' },
            properties: {},
          },
          { id: 'o-3', objectType: 'Server', identityKey: { hostname: 'web-01' }, properties: {} },
        ],
      }),
    });
    const options = await objectSource(t).load(http, '');
    expect(options.map((option) => [option.label, option.detail])).toEqual([
      ['Worker 定义 1', 'Worker 定义'],
      ['docker-prod', '已接入的系统'],
      ['web-01', 'Server'],
    ]);
  });

  it('a gate reads its transport, an ontology type its kind, in words', async () => {
    const gates = await resourceIdSource('gatekeeper', t)?.load(
      caller({
        list_gatekeepers: () => ({
          items: [{ id: 'gk-1', name: 'docker-prod', kind: 'cli', status: 'active' }],
        }),
      }),
      '',
    );
    expect(gates?.[0]?.detail).not.toBe('cli');
    const types = await resourceIdSource('ontology_type', t)?.load(
      caller({ list_types: () => ({ items: [{ kind: 'object', name: 'Server' }] }) }),
      '',
    );
    expect(types?.[0]?.detail).toBe('对象');
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
