// @vitest-environment jsdom
import type { ExplainResultWire } from '@nexttime/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_RESOURCE_TYPES,
  auditActionSuggestions,
  auditEntryFromHash,
  auditFilterFromEntry,
  auditHref,
  downloadJson,
  downloadName,
  explainView,
  resourceHref,
} from './audit.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('audit entry links', () => {
  it('round-trips an entry through the #/govern/audit?… hash and drops blanks', () => {
    const href = auditHref({ nodeId: 'fact 1', resourceType: '', actionRequestId: 'ar-1' });
    expect(href).toBe('#/govern/audit?nodeId=fact+1&actionRequestId=ar-1');
    expect(auditEntryFromHash(href)).toEqual({ nodeId: 'fact 1', actionRequestId: 'ar-1' });
    expect(auditHref({})).toBe('#/govern/audit');
    expect(auditEntryFromHash('#/govern/audit')).toEqual({});
    expect(auditEntryFromHash('#/work/chats?nodeId=x')).toEqual({});
    expect(auditEntryFromHash('#/govern/audit?bogus=1&resourceId=t-1')).toEqual({
      resourceId: 't-1',
    });
  });

  it('turns an entry into the audit_query filter; an approval entry filters on the action_request', () => {
    expect(auditFilterFromEntry({ resourceType: 'task', resourceId: 't-1', action: 'x' })).toEqual({
      resourceType: 'task',
      resourceId: 't-1',
      action: 'x',
    });
    expect(auditFilterFromEntry({ actionRequestId: 'ar-1' })).toEqual({
      resourceType: 'action_request',
      resourceId: 'ar-1',
    });
    expect(auditFilterFromEntry({ nodeId: 'f-1' })).toEqual({});
  });

  it('links a row’s resource to its console page only where one exists', () => {
    expect(resourceHref('action_request', 'ar-1')).toBe('#/work/approvals/ar-1');
    expect(resourceHref('task', 't-1')).toBe('#/work/tasks/t-1');
    expect(resourceHref('skill', 's-1')).toBeUndefined();
    expect(resourceHref('task', null)).toBeUndefined();
  });

  it('suggests workspace capability names plus lifecycle actions, never platform capabilities', () => {
    const names = auditActionSuggestions();
    expect(names).toContain('approve');
    expect(names).toContain('action_request.approve');
    expect(names).toContain('audit_query');
    expect(names).not.toContain('platform_audit_query');
    expect(names).toEqual([...names].sort());
    expect(AUDIT_RESOURCE_TYPES).toContain('action_request');
  });
});

describe('explainView', () => {
  const principal = { id: 'p-1', kind: 'human', role: 'owner', displayName: 'Alice' };
  const source = {
    id: 'src-1',
    kind: 'http',
    uri: 'https://x',
    visibility: 'workspace',
    ownerPrincipal: null,
  };

  it('maps a Fact root: fact + activity + the Fact’s own Source, and the Activity’s metadata links', () => {
    const result: ExplainResultWire = {
      nodeType: 'fact',
      fact: {
        id: 'fact-1',
        linkType: 'runs_on',
        epistemicStatus: 'observed',
        assertedByPrincipal: principal,
        verifiedByPrincipal: null,
        observationId: 'obs-1',
        invalidatedAt: null,
        invalidationReason: null,
        lastObservation: { id: 'obs-1', createdAt: '2026-09-03T00:00:00.000Z', source },
      },
      activity: {
        id: 'act-1',
        kind: 'worker_result',
        status: 'completed',
        createdAt: '2026-09-03T00:00:00.000Z',
        endedAt: null,
        startedByPrincipal: principal,
        observations: [],
        metadata: { taskId: 'task-1', workerRunId: 'run-1', onBehalfOf: 'p-9' },
        onBehalfOfPrincipal: null,
      },
    };
    const view = explainView(result);
    expect(view.nodeType).toBe('fact');
    expect(view.fact?.id).toBe('fact-1');
    expect(view.activity?.kind).toBe('worker_result');
    expect(view.source?.id).toBe('src-1');
    expect(view.decision).toBeNull();
    expect(view.links).toEqual({ taskId: 'task-1', workerRunId: 'run-1', onBehalfOf: 'p-9' });
  });

  it('maps a Decision root: decision + its Source; a missing activity leaves every link empty', () => {
    const result: ExplainResultWire = {
      nodeType: 'decision',
      decision: {
        id: 'dec-1',
        status: 'approved',
        summary: 'approve action_request ar-1',
        decidedByPrincipal: principal,
        source,
      },
      activity: null,
    };
    const view = explainView(result);
    expect(view.decision?.id).toBe('dec-1');
    expect(view.activity).toBeNull();
    expect(view.fact).toBeNull();
    expect(view.source?.id).toBe('src-1');
    expect(view.links).toEqual({});
  });
});

describe('downloads', () => {
  it('builds a safe file name', () => {
    expect(downloadName('provenance', 'fact/1 x')).toBe('provenance-fact-1-x.json');
    expect(downloadName('audit', '')).toBe('audit.json');
  });

  it('downloadJson clicks a temporary <a download> on an object URL and revokes it; false without the API', () => {
    const create = vi.fn(() => 'blob:nexttime/1');
    const revoke = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const url = URL as unknown as Record<string, unknown>;
    const original = { create: url.createObjectURL, revoke: url.revokeObjectURL };
    url.createObjectURL = create;
    url.revokeObjectURL = revoke;
    try {
      expect(downloadJson('x.json', { a: 1 })).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:nexttime/1');
      expect(document.querySelector('a[download]')).toBeNull();
      url.createObjectURL = undefined;
      expect(downloadJson('x.json', { a: 1 })).toBe(false);
    } finally {
      url.createObjectURL = original.create;
      url.revokeObjectURL = original.revoke;
    }
  });
});
