// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { WorkerDefinitionEditor } from './WorkerDefinitionEditor.js';

afterEach(cleanup);

function http(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: { name: string; params: unknown }[] = [];
  const caller: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
  return { caller, calls };
}

describe('WorkerDefinitionEditor (S6-A A2)', () => {
  it('new family: submits propose_worker_definition{kind, definition} with only the declared fields, then publishes {definitionId, version}', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-9', version: 1, status: 'draft' }),
      publish_worker_definition: () => ({ id: 'wd-9', version: 1, status: 'published' }),
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        models={[{ id: 'p/m', provider: 'p', model: 'm' }]}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'Fixer' } });
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'Fix things.' } });
    fireEvent.change(screen.getByLabelText(/^模型/), { target: { value: 'p/m' } });
    fireEvent.change(screen.getByLabelText(/能力/), {
      target: { value: 'search\ntraverse' },
    });
    fireEvent.change(screen.getByLabelText(/可作用的门/), { target: { value: 'gk-1' } });
    fireEvent.change(screen.getByLabelText(/使用的 Skill/), { target: { value: 'restart-web' } });
    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]).toEqual({
      name: 'propose_worker_definition',
      params: {
        kind: 'worker',
        definition: {
          systemPrompt: 'Fix things.',
          model: 'p/m',
          name: 'Fixer',
          capabilities: ['search', 'traverse'],
          gates: ['gk-1'],
          skills: ['restart-web'],
        },
      },
    });
    expect(screen.getByTestId('draft-private-notice').textContent).toContain('只显示已发布版本');
    fireEvent.click(screen.getByTestId('draft-publish'));
    await waitFor(() =>
      expect(calls[1]).toEqual({
        name: 'publish_worker_definition',
        params: { definitionId: 'wd-9', version: 1 },
      }),
    );
  });

  it('entry kind: capabilities is always sent and worker-only fields disappear; a blank prompt is a field error', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-e', version: 1, status: 'draft' }),
    });
    render(<WorkerDefinitionEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('wd-kind'), { target: { value: 'entry' } });
    expect(screen.queryByLabelText(/gates/)).toBeNull();
    fireEvent.click(screen.getByTestId('worker-submit'));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'Entry.' } });
    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      kind: 'entry',
      definition: { systemPrompt: 'Entry.', capabilities: [] },
    });
  });

  it('JSON view applies an edited definition back into the form', () => {
    const { caller } = http({});
    render(<WorkerDefinitionEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByTestId('worker-view-json'));
    const json = screen.getByTestId('worker-json');
    fireEvent.change(within(json).getByRole('textbox'), {
      target: { value: JSON.stringify({ systemPrompt: 'From JSON', egressDeny: ['.internal'] }) },
    });
    fireEvent.click(screen.getByTestId('worker-json-apply'));
    expect((screen.getByLabelText(/系统提示词/) as HTMLTextAreaElement).value).toBe('From JSON');
    expect((screen.getByLabelText(/出网拒绝/) as HTMLTextAreaElement).value).toBe('.internal');
  });
});
