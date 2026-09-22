// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ProcedureEditor } from './ProcedureEditor.js';

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

describe('ProcedureEditor (S6-A A2)', () => {
  it('builds typed steps and submits propose_procedure{procedure} in the ProposeProcedureContentSchema shape', async () => {
    const { caller, calls } = http({
      propose_procedure: () => ({ id: 'pr-1', version: 1, status: 'draft', name: 'Deploy' }),
      publish_procedure: () => ({ id: 'pr-1', version: 1, status: 'published' }),
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
    fireEvent.change(screen.getByLabelText(/^名称 name/), { target: { value: 'Deploy' } });
    fireEvent.change(screen.getByLabelText(/^描述 description/), {
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
    fireEvent.change(within(first).getByLabelText(/gatekeeperId/), { target: { value: 'gk-1' } });
    fireEvent.change(within(first).getByLabelText(/operationName/), {
      target: { value: 'restart' },
    });

    fireEvent.change(within(second).getByTestId('procedure-step-kind'), {
      target: { value: 'worker' },
    });
    fireEvent.change(within(second).getByLabelText(/definitionId/), { target: { value: 'wd-1' } });
    expect((within(second).getByLabelText(/version/) as HTMLInputElement).value).toBe('2');

    fireEvent.change(within(third).getByLabelText(/description/), {
      target: { value: 'ops signs off' },
    });

    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]).toEqual({
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
      expect(calls[1]).toEqual({ name: 'publish_procedure', params: { procedureId: 'pr-1' } }),
    );
  });

  it('rejects an invalid step with a field error at its path, and the JSON view round-trips into the form', async () => {
    const { caller, calls } = http({});
    render(<ProcedureEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^名称 name/), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/^描述 description/), { target: { value: 'Y' } });
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
    expect((screen.getByLabelText(/^名称 name/) as HTMLInputElement).value).toBe('From JSON');
    const step = screen.getByTestId('procedure-step');
    expect((within(step).getByTestId('procedure-step-kind') as HTMLSelectElement).value).toBe(
      'verify',
    );
    expect((within(step).getByLabelText(/description/) as HTMLInputElement).value).toBe(
      'health ok',
    );
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
    expect(screen.getByTestId('procedure-copy-notice').textContent).toContain('new');
    expect(screen.getAllByTestId('procedure-step')).toHaveLength(1);
    expect((screen.getByLabelText(/^名称 name/) as HTMLInputElement).value).toBe('Deploy');
  });
});
