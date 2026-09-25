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

describe('WorkerDefinitionEditor (S6-A A2, S8 W2 U2)', () => {
  it('new family: capabilities/gates/skills pickers submit the picked names/ids; model is a dropdown; then publishes {definitionId, version}', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-9', version: 1, status: 'draft' }),
      publish_worker_definition: () => ({ id: 'wd-9', version: 1, status: 'published' }),
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        models={[{ id: 'p/m', provider: 'p', model: 'm' }]}
        capabilityNames={[
          { name: 'search', mode: 'observe' },
          { name: 'traverse', mode: 'observe' },
        ]}
        gatekeepers={[
          {
            id: 'gk-1',
            name: 'Docker',
            kind: 'docker',
            status: 'enabled',
            operationCount: 1,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ]}
        skills={[
          {
            id: 'sk-1',
            version: 1,
            status: 'published',
            name: 'restart-web',
            description: 'Restart web',
          },
          {
            id: 'sk-2',
            version: 1,
            status: 'draft',
            name: 'unpublished-skill',
            description: 'Not yet published',
          },
        ]}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'Fixer' } });
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'Fix things.' } });
    fireEvent.change(screen.getByLabelText(/^模型/), { target: { value: 'p/m' } });
    fireEvent.click(screen.getByLabelText('search'));
    fireEvent.click(screen.getByLabelText('traverse'));
    fireEvent.click(screen.getByLabelText('Docker'));
    fireEvent.click(screen.getByLabelText('restart-web'));
    // A draft (unpublished) Skill must never appear as a pickable option.
    expect(screen.queryByLabelText('unpublished-skill')).toBeNull();
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
    expect(screen.getByTestId('draft-private-notice').textContent).toContain('我的草稿');
    // R6: the Publish button already has focus — publishing straight from this screen is still
    // the fastest path, even though the Workers tab's own "我的草稿" section can now find the
    // draft too.
    expect(document.activeElement).toBe(screen.getByTestId('draft-publish'));
    fireEvent.click(screen.getByTestId('draft-publish'));
    await waitFor(() =>
      expect(calls[1]).toEqual({
        name: 'publish_worker_definition',
        params: { definitionId: 'wd-9', version: 1 },
      }),
    );
  });

  it('a brand-new draft offers only kind=worker (no entry option) — J7 "owner 视角隐藏 kind=entry"', () => {
    const { caller } = http({});
    render(<WorkerDefinitionEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    const kindSelect = screen.getByTestId('wd-kind') as HTMLSelectElement;
    expect(Array.from(kindSelect.options).map((option) => option.value)).toEqual(['worker']);
    expect(kindSelect.disabled).toBe(true);
    expect(kindSelect.value).toBe('worker');
  });

  it('entry kind is only reachable as an existing family’s next version: capabilities is always sent, worker-only fields disappear, a blank prompt is a field error, and an already-selected capability outside the loaded directory is never silently dropped', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-e', version: 2, status: 'draft' }),
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        newVersionOf={{
          id: 'wd-e',
          version: 1,
          kind: 'entry',
          status: 'published',
          definition: { capabilities: ['search'] },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const kindSelect = screen.getByTestId('wd-kind') as HTMLSelectElement;
    expect(kindSelect.disabled).toBe(true);
    expect(kindSelect.value).toBe('entry');
    expect(screen.queryByTestId('wd-gates')).toBeNull();
    expect(screen.queryByTestId('wd-skills')).toBeNull();
    // `capabilityNames` was not passed at all — the pre-selected 'search' still renders (as a
    // fallback option outside the loaded directory) and stays checked, so it is not silently
    // dropped from the submitted payload.
    const searchCheckbox = screen.getByLabelText('search') as HTMLInputElement;
    expect(searchCheckbox.checked).toBe(true);
    fireEvent.click(screen.getByTestId('worker-submit'));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'Entry.' } });
    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      definitionId: 'wd-e',
      kind: 'entry',
      definition: { systemPrompt: 'Entry.', capabilities: ['search'] },
    });
  });

  it('J7/CW1 "从模板创建（ops-runner）": a template-prefilled new draft still only offers kind=worker and keeps the prefilled fields', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-t', version: 1, status: 'draft' }),
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        initialForm={{
          kind: 'worker',
          name: 'ops-runner',
          description: '',
          systemPrompt: 'You are `ops-runner`, a general-purpose Worker.',
          model: '',
          capabilities: '',
          gates: '',
          skills: '',
          egressDeny: '',
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe('ops-runner');
    expect((screen.getByLabelText(/系统提示词/) as HTMLTextAreaElement).value).toBe(
      'You are `ops-runner`, a general-purpose Worker.',
    );
    const kindSelect = screen.getByTestId('wd-kind') as HTMLSelectElement;
    expect(kindSelect.disabled).toBe(true);
    expect(kindSelect.value).toBe('worker');
    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      kind: 'worker',
      definition: {
        systemPrompt: 'You are `ops-runner`, a general-purpose Worker.',
        name: 'ops-runner',
      },
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
