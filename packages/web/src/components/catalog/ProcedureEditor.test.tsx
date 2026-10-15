// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ProcedureEditor } from './ProcedureEditor.js';

afterEach(cleanup);

const GATES = [
  {
    id: 'gk-1',
    name: 'docker-prod',
    kind: 'http',
    status: 'active',
    operationCount: 3,
    createdAt: '',
  },
];

const OPERATIONS = [
  {
    gatekeeperId: 'gk-1',
    name: 'restart',
    mode: 'execute',
    blastRadius: 'medium',
    autoApprovable: false,
    version: 1,
    status: 'published',
  },
  {
    gatekeeperId: 'gk-1',
    name: 'prune',
    mode: 'execute',
    blastRadius: 'high',
    autoApprovable: false,
    version: 1,
    status: 'draft',
  },
];

function http(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: { name: string; params: unknown }[] = [];
  const caller: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      if (name !== 'get_workspace') calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
  return { caller, calls };
}

/** Opens the Operation combobox and returns the names it offers. */
function offered(input: HTMLInputElement): string[] {
  if (input.getAttribute('aria-expanded') !== 'true') fireEvent.click(input);
  return within(screen.getByRole('listbox'))
    .queryAllByRole('option')
    .map((option) => option.querySelector('.combobox-option-label')?.textContent ?? '');
}

describe('ProcedureEditor (S6-A A2)', () => {
  it('builds typed steps and submits propose_procedure{procedure} in the ProposeProcedureContentSchema shape', async () => {
    const { caller, calls } = http({
      propose_procedure: () => ({ id: 'pr-1', version: 1, status: 'draft', name: 'Deploy' }),
      publish_procedure: () => ({ id: 'pr-1', version: 1, status: 'published' }),
      list_operations: () => ({ items: OPERATIONS }),
    });
    render(
      <ProcedureEditor
        http={caller}
        gatekeepers={[
          {
            id: 'gk-1',
            name: 'docker-prod',
            kind: 'http',
            status: 'active',
            operationCount: 3,
            createdAt: '',
          },
        ]}
        workerDefinitions={[
          {
            id: 'wd-1',
            version: 2,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer' },
          },
        ]}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'Deploy' } });
    fireEvent.change(screen.getByLabelText(/^描述/), {
      target: { value: 'Deploy web' },
    });

    fireEvent.click(screen.getByTestId('procedure-add-step'));
    fireEvent.click(screen.getByTestId('procedure-add-step'));
    fireEvent.click(screen.getByTestId('procedure-add-step'));
    const steps = screen.getAllByTestId('procedure-step');
    expect(steps).toHaveLength(3);

    const [first, second, third] = steps as [HTMLElement, HTMLElement, HTMLElement];
    fireEvent.change(within(first).getByTestId('procedure-step-kind'), {
      target: { value: 'operation' },
    });
    fireEvent.change(within(first).getByLabelText(/门/), { target: { value: 'gk-1' } });
    const operationInput = within(first).getByTestId(
      'procedure-step-operation',
    ) as HTMLInputElement;
    await waitFor(() => expect(operationInput.getAttribute('aria-busy')).toBeNull());
    expect(operationInput.disabled).toBe(false);
    // Only the gate's published Operations are offered — never a draft.
    expect(offered(operationInput)).toEqual(['restart']);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /restart/ }));
    expect(operationInput.value).toBe('restart');

    fireEvent.change(within(second).getByTestId('procedure-step-kind'), {
      target: { value: 'worker' },
    });
    fireEvent.change(within(second).getByLabelText(/Worker 定义/), { target: { value: 'wd-1' } });
    expect((within(second).getByLabelText(/版本/) as HTMLInputElement).value).toBe('2');

    fireEvent.change(within(third).getByLabelText(/说明/), {
      target: { value: 'ops signs off' },
    });

    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    const proposeCalls = calls.filter((call) => call.name !== 'list_operations');
    expect(proposeCalls[0]).toEqual({
      name: 'propose_procedure',
      params: {
        procedure: {
          name: 'Deploy',
          description: 'Deploy web',
          steps: [
            { kind: 'operation', gatekeeperId: 'gk-1', operationName: 'restart' },
            { kind: 'worker', definitionId: 'wd-1', version: 2 },
            { kind: 'approval', description: 'ops signs off' },
          ],
        },
      },
    });
    fireEvent.click(screen.getByTestId('draft-publish'));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        name: 'publish_procedure',
        params: { procedureId: 'pr-1' },
      }),
    );
  });

  it('rejects an invalid step with a field error at its path, and the JSON view round-trips into the form', async () => {
    const { caller, calls } = http({});
    render(<ProcedureEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/^描述/), { target: { value: 'Y' } });
    fireEvent.click(screen.getByTestId('procedure-add-step'));
    fireEvent.click(screen.getByTestId('procedure-submit'));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByTestId('procedure-view-json'));
    const json = screen.getByTestId('procedure-json');
    fireEvent.change(within(json).getByRole('textbox'), {
      target: {
        value: JSON.stringify({
          name: 'From JSON',
          description: 'd',
          steps: [{ kind: 'verify', description: 'health ok' }],
        }),
      },
    });
    fireEvent.click(screen.getByTestId('procedure-json-apply'));
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe('From JSON');
    const step = screen.getByTestId('procedure-step');
    expect((within(step).getByTestId('procedure-step-kind') as HTMLSelectElement).value).toBe(
      'verify',
    );
    expect((within(step).getByLabelText(/说明/) as HTMLInputElement).value).toBe('health ok');
  });

  it('copy mode pre-fills the steps from the row and says the result is a new Procedure', () => {
    const { caller } = http({});
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 2,
          status: 'published',
          name: 'Deploy',
          description: 'Deploy web',
          steps: [{ kind: 'approval', description: 'sign off' }],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // One language per string (the zh default) — the old notice glued both halves together.
    const notice = screen.getByTestId('procedure-copy-notice').textContent ?? '';
    expect(notice).toContain('新的');
    expect(notice).not.toContain('Copied from');
    expect(screen.getAllByTestId('procedure-step')).toHaveLength(1);
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe('Deploy');
  });

  it('the Operation list failing to load falls back to a manual name, with a retry', async () => {
    const { caller, calls } = http({
      list_operations: () => {
        throw new Error('boom');
      },
      propose_procedure: () => ({ id: 'pr-2', version: 1, status: 'draft', name: 'X' }),
    });
    render(
      <ProcedureEditor http={caller} gatekeepers={GATES} onProposed={vi.fn()} onDone={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/^描述/), { target: { value: 'Y' } });
    fireEvent.click(screen.getByTestId('procedure-add-step'));
    const step = screen.getByTestId('procedure-step');
    fireEvent.change(within(step).getByTestId('procedure-step-kind'), {
      target: { value: 'operation' },
    });
    // No gate yet: the Operation select waits for one instead of offering free text.
    expect(
      (within(step).getByTestId('procedure-step-operation') as HTMLSelectElement).disabled,
    ).toBe(true);
    fireEvent.change(within(step).getByLabelText(/门/), { target: { value: 'gk-1' } });
    await within(step).findByTestId('procedure-step-operations-error');
    const input = within(step).getByTestId('procedure-step-operation-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' restart ' } });
    fireEvent.blur(input);
    expect(input.value).toBe('restart');
    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls.find((call) => call.name === 'propose_procedure')?.params).toEqual({
      procedure: {
        name: 'X',
        description: 'Y',
        steps: [{ kind: 'operation', gatekeeperId: 'gk-1', operationName: 'restart' }],
      },
    });
  });

  it('a copied step whose Operation the gate no longer publishes stays visible with a warning', async () => {
    const { caller } = http({ list_operations: () => ({ items: OPERATIONS }) });
    render(
      <ProcedureEditor
        http={caller}
        gatekeepers={GATES}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Deploy',
          description: 'Deploy web',
          steps: [{ kind: 'operation', gatekeeperId: 'gk-1', operationName: 'restrat' }],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const warning = await screen.findByTestId('procedure-step-unknown-operation');
    expect(warning.textContent).toContain('restrat');
    expect((screen.getByTestId('procedure-step-operation-input') as HTMLInputElement).value).toBe(
      'restrat',
    );
    // "从列表选择" clears the stale name and offers the gate's list again.
    fireEvent.click(screen.getByTestId('procedure-step-operation-mode'));
    const input = screen.getByTestId('procedure-step-operation') as HTMLInputElement;
    expect(input.value).toBe('');
    // Searchable: typing narrows the gate's list, Enter takes the match.
    fireEvent.change(input, { target: { value: 'rest' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('restart');
    expect(screen.queryByTestId('procedure-step-unknown-operation')).toBeNull();
  });
});
