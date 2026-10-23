// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import {
  comboboxOptionTexts,
  findComboboxOption,
  pickComboboxOption,
} from '../kit/combobox.test-helpers.js';
import { ProvenanceToolsSection } from './ProvenanceToolsSection.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call {
  readonly name: string;
  readonly params: unknown;
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

const forbidden = () => Promise.reject(new HttpError('capability_error', 'role', 'forbidden'));

function decision(id: string, summary: string) {
  return {
    id,
    status: 'approved',
    activityId: `act-${id}`,
    sourceId: null,
    summary,
    rationale: null,
    decidedBy: 'p-1',
    createdAt: '2026-09-03T00:00:00.000Z',
    decidedAt: '2026-09-03T00:00:00.000Z',
  };
}

function objectRow(id: string, name: string) {
  return {
    id,
    objectType: 'Host',
    identityKey: null,
    properties: { name },
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    lastObservedAt: null,
  };
}

function operation(gatekeeperId: string, name: string) {
  return {
    gatekeeperId,
    name,
    mode: 'act',
    blastRadius: 'low',
    autoApprovable: false,
    version: 1,
    status: 'published',
  };
}

const baseHandlers = {
  audit_query: () => ({
    items: [
      {
        id: 'a-1',
        actorPrincipalId: 'p-1',
        action: 'attest_fact',
        resourceType: 'fact',
        resourceId: 'fact-1',
        payload: {},
        createdAt: '2026-09-03T00:00:00.000Z',
      },
    ],
  }),
  resolve_refs: () => ({ items: [] }),
  query_decisions: () => ({ items: [decision('dec-1', 'approve restart')] }),
  search: () => ({ items: [objectRow('o-1', 'web-01')] }),
  list_operations: () => ({ items: [operation('gk-1', 'container_restart')] }),
  list_gatekeepers: () => ({
    items: [
      {
        id: 'gk-1',
        name: 'docker-prod',
        kind: 'http',
        status: 'active',
        operationCount: 1,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  }),
};

/** Field-inventory §11 issue 13: the reasoning-chain tools pick ids, action kinds and times. */
describe('ProvenanceToolsSection pickers', () => {
  it('causal chain: offers recent Facts from the audit log, then Decisions (query_decisions) once the kind changes; tracing uses the picked id', async () => {
    const http = scriptedHttp({
      ...baseHandlers,
      causal_chain: () => ({ rootType: 'decision', rootId: 'dec-1', chain: [], truncated: false }),
      decision_impact: () => ({ facts: [], actionRequests: [], taskIds: [] }),
    });
    render(<ProvenanceToolsSection http={http} />);

    const box = screen.getByTestId('causal-chain-node-id');
    // Legacy sweep (console batch, 2026-10-16): the option names the action, not its raw name.
    await findComboboxOption(box, '人工确认事实');
    expect(comboboxOptionTexts(box).join(' ')).not.toContain('attest_fact');
    expect(http.calls.find((c) => c.name === 'audit_query')?.params).toEqual({
      filter: { resourceType: 'fact' },
      limit: 200,
    });

    fireEvent.change(screen.getByLabelText('节点类型'), { target: { value: 'decision' } });
    await pickComboboxOption(box, 'approve restart');
    fireEvent.submit(screen.getByTestId('causal-chain-form'));
    await screen.findByTestId('causal-chain-result');
    expect(http.calls.find((c) => c.name === 'causal_chain')?.params).toEqual({
      decisionId: 'dec-1',
    });
    expect(http.calls.find((c) => c.name === 'decision_impact')?.params).toEqual({
      decisionId: 'dec-1',
    });
  });

  it('causal chain: a member refused the audit log keeps the id box with a one-line note', async () => {
    const http = scriptedHttp({ ...baseHandlers, audit_query: forbidden });
    render(<ProvenanceToolsSection http={http} />);
    await screen.findByTestId('causal-chain-node-id-refused');
    expect(screen.getByLabelText('起点 ID')).toBeTruthy();
  });

  it('precedents: Object and action kind come from search / list_operations (named by gate); Find precedents waits for one of them', async () => {
    const http = scriptedHttp({
      ...baseHandlers,
      find_precedents: () => ({ items: [decision('dec-9', 'prior restart')] }),
    });
    render(<ProvenanceToolsSection http={http} />);

    const findButton = screen.getByRole('button', { name: '查找先例' });
    expect((findButton as HTMLButtonElement).disabled).toBe(true);

    await pickComboboxOption(screen.getByTestId('precedents-object-id'), 'web-01');
    const kindBox = screen.getByTestId('precedents-action-kind');
    const kind = await findComboboxOption(kindBox, 'container_restart');
    // The option names the gates that offer the Operation.
    expect(kind.textContent).toContain('docker-prod');
    fireEvent.click(kind);
    expect((screen.getByLabelText('动作种类') as HTMLInputElement).value).toBe('container_restart');
    expect((findButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(findButton);
    await screen.findByTestId('precedents-result');
    expect(http.calls.find((c) => c.name === 'find_precedents')?.params).toEqual({
      objectId: 'o-1',
      actionKindTag: 'container_restart',
    });
    // Legacy sweep (console batch, 2026-10-16): a precedent's status reads as a label.
    expect(screen.getByTestId('precedent-status').textContent).toBe('已批准');
    expect(screen.getByTestId('precedents-result').textContent).not.toContain('approved');
  });

  it('precedents: typing an operation name re-asks list_operations{q}', async () => {
    const http = scriptedHttp(baseHandlers);
    render(<ProvenanceToolsSection http={http} />);
    await findComboboxOption(screen.getByTestId('precedents-action-kind'), 'container_restart');
    fireEvent.change(screen.getByLabelText('动作种类'), { target: { value: 'restart' } });
    await waitFor(() =>
      expect(
        http.calls.some(
          (c) =>
            c.name === 'list_operations' &&
            (c.params as { q?: string } | undefined)?.q === 'restart',
        ),
      ).toBe(true),
    );
  });

  it('since: a preset fills the datetime-local box and Query decisions sends it as an ISO instant', async () => {
    const http = scriptedHttp(baseHandlers);
    render(<ProvenanceToolsSection http={http} />);
    const before = Date.now();
    fireEvent.click(screen.getByTestId('precedents-since-24h'));
    const input = screen.getByTestId('precedents-since') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    fireEvent.click(screen.getByRole('button', { name: '查询决定' }));
    await screen.findByTestId('precedents-result');
    const call = http.calls.filter((c) => c.name === 'query_decisions').at(-1);
    const since = (call?.params as { since?: string }).since ?? '';
    expect(since).toMatch(/Z$/);
    const ms = Date.parse(since);
    // datetime-local keeps minutes, so the instant is at most a minute before "now - 24h".
    expect(ms).toBeLessThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(ms).toBeGreaterThan(before - 24 * 60 * 60 * 1000 - 2 * 60 * 1000);

    fireEvent.click(screen.getByTestId('precedents-since-clear'));
    expect(input.value).toBe('');
  });
});

/** Legacy 421: a Decision the reader may not see answers like a missing one — the tools say so. */
describe('ProvenanceToolsSection — Decisions the reader may not see', () => {
  const notFound = () =>
    Promise.reject(new HttpError('capability_error', 'no such decision', 'not_found'));

  it('causal chain: a 404 says the node may be one the reader may not see', async () => {
    const http = scriptedHttp({ ...baseHandlers, causal_chain: notFound });
    render(<ProvenanceToolsSection http={http} />);
    fireEvent.change(screen.getByLabelText('节点类型'), { target: { value: 'decision' } });
    fireEvent.change(screen.getByLabelText('起点 ID'), { target: { value: 'dec-hidden' } });
    fireEvent.submit(screen.getByTestId('causal-chain-form'));
    const banner = await screen.findByTestId('causal-chain-error');
    expect(banner.getAttribute('data-error-code')).toBe('not_found');
    expect(banner.textContent).toMatch(/找不到这个节点，或者你无权查看它/);
    expect(banner.textContent).toMatch(/审批和核对的决定只对能看到那个动作请求的人显示/);
  });

  it('causal chain: a Fact that is not found says nothing about who may see Decisions (legacy 430)', async () => {
    const http = scriptedHttp({ ...baseHandlers, causal_chain: notFound });
    render(<ProvenanceToolsSection http={http} />);
    fireEvent.change(screen.getByLabelText('起点 ID'), { target: { value: 'fact-gone' } });
    fireEvent.submit(screen.getByTestId('causal-chain-form'));
    const banner = await screen.findByTestId('causal-chain-error');
    expect(banner.textContent).toMatch(/找不到这个节点，或者你无权查看它/);
    expect(banner.textContent).not.toMatch(/决定/);
    // UX P3 on #724: the form's controls were disabled while it ran; focus lands on the error.
    await waitFor(() => expect(document.activeElement).toBe(banner.parentElement));
    // Switching the select afterwards does not rewrite what the error was about.
    fireEvent.change(screen.getByLabelText('节点类型'), { target: { value: 'decision' } });
    expect(screen.getByTestId('causal-chain-error').textContent).not.toMatch(/决定/);
  });

  it('precedents and query: an empty list says it shows only Decisions the reader may see', async () => {
    const http = scriptedHttp({
      ...baseHandlers,
      query_decisions: () => ({ items: [] }),
      find_precedents: () => ({ items: [] }),
    });
    render(<ProvenanceToolsSection http={http} />);
    fireEvent.click(screen.getByRole('button', { name: '查询决定' }));
    expect((await screen.findByTestId('precedents-empty')).textContent).toMatch(
      /^没有你能查看的匹配决定。/,
    );

    await pickComboboxOption(screen.getByTestId('precedents-action-kind'), 'container_restart');
    fireEvent.submit(screen.getByTestId('precedents-form'));
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'find_precedents')).toHaveLength(1),
    );
    expect((await screen.findByTestId('precedents-empty')).textContent).toMatch(
      /别人私聊里的决定、你看不到的冲突的裁决也不显示/,
    );
  });

  it('the recent-Decisions picker with nothing to offer says why', async () => {
    const http = scriptedHttp({ ...baseHandlers, query_decisions: () => ({ items: [] }) });
    render(<ProvenanceToolsSection http={http} />);
    fireEvent.change(screen.getByLabelText('节点类型'), { target: { value: 'decision' } });
    const box = screen.getByTestId('causal-chain-node-id');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'query_decisions')).toBe(true));
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect((await screen.findByTestId('causal-chain-node-id-empty')).textContent).toMatch(
      /^还没有你能查看的决定；可直接粘贴 ID。/,
    );
  });
});
