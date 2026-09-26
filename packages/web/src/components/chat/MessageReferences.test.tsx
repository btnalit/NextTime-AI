// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { MessageReferences } from './MessageReferences.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
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

const FACT_ID = '12345678-abcd-4321-8888-000000000000';

describe('MessageReferences', () => {
  it('renders nothing for prose with no id-shaped token — no explain call', () => {
    const http = scriptedHttp({});
    render(<MessageReferences http={http} text="入口 agent 观察了系统并给出了建议。" />);
    expect(screen.queryByTestId('message-references')).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('renders nothing when explain does not recognise the id (journey ④ "空": no dead trace entry)', async () => {
    const http = scriptedHttp({
      explain: () => Promise.reject(new Error('not_found')),
    });
    render(<MessageReferences http={http} text={`见 ${FACT_ID}`} />);
    await waitFor(() => expect(http.calls).toHaveLength(1));
    expect(screen.queryByTestId('message-references')).toBeNull();
  });

  it('renders a clickable reference chip into the audit explain view when explain resolves the id', async () => {
    const http = scriptedHttp({
      explain: (params) => {
        expect(params).toEqual({ nodeId: FACT_ID });
        return {
          nodeType: 'fact',
          fact: { id: FACT_ID, linkType: 'depends_on', epistemicStatus: 'observed' },
          activity: { id: 'a-1', kind: 'ingest.submit_observations', status: 'completed' },
        };
      },
    });
    render(<MessageReferences http={http} text={`这依据 ${FACT_ID} 得出。`} />);

    const refs = await screen.findByTestId('message-references');
    const chip = refs.querySelector(`[data-ref-id="${FACT_ID}"]`);
    expect(chip).not.toBeNull();
    const link = chip?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`#/govern/audit?nodeId=${FACT_ID}`);
  });

  // Console redesign P3-2 (V3 "对话"): an Activity-only result used to name the chip with the raw
  // wire `activity.kind` ("agent_turn") plus a "(activity)" type suffix — a human label replaces
  // both instead of exposing that internal enum value.
  it('gives an Activity-only reference a human label, never the raw kind or type suffix', async () => {
    const ACTIVITY_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
    const http = scriptedHttp({
      explain: () => ({
        nodeType: 'activity',
        activity: { id: ACTIVITY_ID, kind: 'agent_turn', status: 'completed' },
      }),
    });
    render(<MessageReferences http={http} text={`见 ${ACTIVITY_ID}`} />);

    const refs = await screen.findByTestId('message-references');
    const chip = refs.querySelector(`[data-ref-id="${ACTIVITY_ID}"]`);
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('本轮记录');
    expect(chip?.textContent).not.toContain('agent_turn');
    expect(chip?.textContent).not.toContain('activity');
  });
});
