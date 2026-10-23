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
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer' },
          },
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
    const gateSelect = within(first).getByLabelText(/门/) as HTMLSelectElement;
    // Legacy sweep (console batch, 2026-10-16): the gate option names its kind as HTTP, not http.
    await waitFor(() =>
      expect([...gateSelect.options].map((option) => option.textContent)).toContain(
        'docker-prod · HTTP',
      ),
    );
    fireEvent.change(gateSelect, { target: { value: 'gk-1' } });
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
    // field-inventory #26: one option per definition, the version picked from its own list
    // (newest first, newest preselected) — never typed.
    const definitionSelect = within(second).getByLabelText(/Worker 定义/) as HTMLSelectElement;
    expect([...definitionSelect.options].filter((o) => o.value === 'wd-1')).toHaveLength(1);
    const versionSelect = within(second).getByLabelText(/版本/) as HTMLSelectElement;
    expect(versionSelect.tagName).toBe('SELECT');
    expect([...versionSelect.options].map((o) => o.textContent)).toEqual(['v2', 'v1']);
    expect(versionSelect.value).toBe('2');

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
        params: { procedureId: 'pr-1', version: 1 },
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

  it('a copy keeps what its steps say of a goal’s plan, and its parameters, through edits, the JSON view and the save (S11 GO5d-2)', async () => {
    const { caller, calls } = http({
      propose_procedure: () => ({ id: 'pr-9', version: 1, status: 'draft', name: 'Renew' }),
    });
    const parameters = {
      type: 'object',
      properties: { site: { type: 'string' } },
      required: ['site'],
    };
    const fetch = {
      kind: 'worker',
      definitionId: 'wd-1',
      version: 2,
      key: 'fetch',
      dependsOn: [],
      input: { mode: 'safe' },
      bindings: [{ to: 'target.site', from: '$params', path: 'site' }],
      outputSchema: { type: 'object', properties: { hosts: { type: 'array' } } },
      maxAttempts: 2,
    };
    const apply = {
      kind: 'worker',
      definitionId: 'wd-1',
      version: 2,
      dependsOn: ['fetch'],
      bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }],
    };
    const check = {
      kind: 'observe_predicate',
      key: 'valid',
      check: {
        gatekeeperId: '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10',
        operation: 'cert.status',
        expect: { path: 'state', op: 'eq', value: 'valid' },
      },
    };
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 3,
          status: 'published',
          name: 'Renew',
          description: 'Renew the certificates',
          steps: [
            fetch,
            apply,
            { kind: 'verify', description: 'The certificate is valid.', check },
            { kind: 'approval', description: 'The owner agrees.' },
          ],
          parameters,
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // Legacy 453: the form shows what each step says of the plan, field by field.
    const steps = screen.getAllByTestId('procedure-step');
    const [first, second, third] = steps as [HTMLElement, HTMLElement, HTMLElement];
    expect((within(first).getByTestId('procedure-step-plan-key') as HTMLInputElement).value).toBe(
      'fetch',
    );
    expect(
      (within(first).getByTestId('procedure-step-depends-own') as HTMLInputElement).checked,
    ).toBe(true);
    expect(within(first).queryAllByTestId('procedure-step-depends-on')).toHaveLength(1);
    expect((within(first).getByTestId('procedure-step-attempts') as HTMLSelectElement).value).toBe(
      '2',
    );
    expect(
      JSON.parse((within(first).getByTestId('procedure-step-input') as HTMLTextAreaElement).value),
    ).toEqual({ mode: 'safe' });
    expect(
      (within(first).getByTestId('procedure-step-binding-from') as HTMLSelectElement).value,
    ).toBe('$params');
    expect(
      within(first)
        .getAllByTestId('procedure-step-output-field-name')
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(['hosts']);
    // A binding the page can already tell is fine says nothing; the step it waits for is chosen.
    expect(within(second).queryByTestId('procedure-step-binding-issue')).toBeNull();
    expect(
      (within(second).getByTestId('procedure-step-depends-on') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(third).getByTestId('procedure-step-check-kind') as HTMLSelectElement).value,
    ).toBe('observe_predicate');
    expect(within(third).getByTestId('procedure-step-check-sentence').textContent).toMatch(
      /^平台会检查：/,
    );
    const parameterRows = screen.getAllByTestId('procedure-parameters-field');
    expect(parameterRows).toHaveLength(1);
    expect(
      (
        within(parameterRows[0] as HTMLElement).getByTestId(
          'procedure-parameters-field-required',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);

    // Editing what the form edits leaves the rest as it was — in the JSON view too.
    fireEvent.change(within(second).getByLabelText(/^说明/), {
      target: { value: 'apply the new certificates' },
    });
    fireEvent.click(screen.getByTestId('procedure-view-json'));
    fireEvent.click(screen.getByTestId('procedure-json-apply'));
    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls.find((call) => call.name === 'propose_procedure')?.params).toEqual({
      procedure: {
        name: 'Renew',
        description: 'Renew the certificates',
        steps: [
          fetch,
          { ...apply, description: 'apply the new certificates' },
          { kind: 'verify', description: 'The certificate is valid.', check },
          { kind: 'approval', description: 'The owner agrees.' },
        ],
        parameters,
      },
    });
  });

  it('what is refused shows on the field it is about (legacy 453)', async () => {
    const { caller, calls } = http({});
    render(<ProcedureEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByTestId('procedure-view-json'));
    fireEvent.change(within(screen.getByTestId('procedure-json')).getByRole('textbox'), {
      target: {
        value: JSON.stringify({
          name: 'Bad',
          description: 'd',
          steps: [
            { kind: 'worker', definitionId: 'wd-1', version: 1, maxAttempts: 0 },
            { kind: 'verify', description: 'ok', check: { kind: 'observe_predicate' } },
          ],
          parameters: { type: 'string' },
        }),
      },
    });
    fireEvent.click(screen.getByTestId('procedure-json-apply'));
    fireEvent.click(screen.getByTestId('procedure-submit'));
    const [worker, verify] = screen.getAllByTestId('procedure-step') as [HTMLElement, HTMLElement];
    // The attempts the platform does not allow are kept, named, and refused at their field.
    const attempts = within(worker).getByTestId('procedure-step-attempts') as HTMLSelectElement;
    expect(attempts.value).toBe('0');
    expect(attempts.getAttribute('aria-invalid')).toBe('true');
    // The check's missing key, gate and expectation, each at its own field.
    await within(verify).findByTestId('procedure-step-check-key');
    expect(
      within(verify).getByTestId('procedure-step-check-key').getAttribute('aria-invalid'),
    ).toBe('true');
    expect(
      within(verify).getByTestId('procedure-step-check-expect').getAttribute('aria-invalid'),
    ).toBe('true');
    // Parameters the field list cannot say stay JSON, with the schema's complaint under them.
    expect(screen.getByTestId('procedure-parameters-json-only')).toBeTruthy();
    expect(screen.getByTestId('procedure-parameters-errors').textContent).not.toBe('');
    expect(screen.queryByTestId('procedure-step-errors')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('builds a template from the form: keys, bindings from the parameters and a step’s output, contracts, a platform check (legacy 453)', async () => {
    const { caller, calls } = http({
      propose_procedure: () => ({ id: 'pr-5', version: 1, status: 'draft', name: 'Renew' }),
    });
    render(
      <ProcedureEditor
        http={caller}
        workerDefinitions={[
          {
            id: 'wd-1',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer' },
          },
        ]}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'Renew' } });
    fireEvent.change(screen.getByLabelText(/^描述/), { target: { value: 'Renew certs' } });
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByTestId('procedure-add-step'));
    const [fetch, apply, verify] = screen.getAllByTestId('procedure-step') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    for (const step of [fetch, apply]) {
      fireEvent.change(within(step).getByTestId('procedure-step-kind'), {
        target: { value: 'worker' },
      });
      fireEvent.change(within(step).getByLabelText(/Worker 定义/), { target: { value: 'wd-1' } });
    }

    // The parameters, as a field list.
    fireEvent.click(screen.getByTestId('procedure-add-parameters'));
    fireEvent.click(screen.getByTestId('procedure-parameters-add-field'));
    fireEvent.change(screen.getByTestId('procedure-parameters-field-name'), {
      target: { value: 'site' },
    });
    fireEvent.click(screen.getByTestId('procedure-parameters-field-required'));

    // The first step: its key, an output contract, and its input bound to a parameter.
    const key = within(fetch).getByTestId('procedure-step-plan-key');
    expect((key as HTMLInputElement).placeholder).toBe('step-1');
    fireEvent.focus(key);
    fireEvent.change(key, { target: { value: 'fetch' } });
    fireEvent.blur(key);
    fireEvent.click(within(fetch).getByTestId('procedure-step-add-output'));
    fireEvent.click(within(fetch).getByTestId('procedure-step-output-add-field'));
    fireEvent.change(within(fetch).getByTestId('procedure-step-output-field-name'), {
      target: { value: 'hosts' },
    });
    fireEvent.change(within(fetch).getByTestId('procedure-step-output-field-kind'), {
      target: { value: 'array' },
    });
    fireEvent.click(within(fetch).getByTestId('procedure-step-add-binding'));
    fireEvent.change(within(fetch).getByTestId('procedure-step-binding-to'), {
      target: { value: 'target.site' },
    });
    fireEvent.change(within(fetch).getByTestId('procedure-step-binding-from'), {
      target: { value: '$params' },
    });
    // The path is offered from the fields the source declares.
    const paramPath = within(fetch).getByTestId('procedure-step-binding-path') as HTMLInputElement;
    expect(offered(paramPath)).toEqual(['site']);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'site' }));

    // The second waits for the first by default; its input takes the first's output.
    expect(
      within(apply).getByTestId('procedure-step-depends-default').parentElement?.textContent,
    ).toMatch(/fetch/);
    fireEvent.click(within(apply).getByTestId('procedure-step-add-binding'));
    fireEvent.change(within(apply).getByTestId('procedure-step-binding-to'), {
      target: { value: 'hosts' },
    });
    const sources = within(apply).getByTestId('procedure-step-binding-from') as HTMLSelectElement;
    expect([...sources.options].map((option) => option.value)).toEqual(['', '$params', 'fetch']);
    fireEvent.change(sources, { target: { value: 'fetch' } });
    const stepPath = within(apply).getByTestId('procedure-step-binding-path') as HTMLInputElement;
    expect(offered(stepPath)).toEqual(['hosts']);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'hosts' }));
    fireEvent.change(within(apply).getByTestId('procedure-step-attempts'), {
      target: { value: '4' },
    });

    // The last: a check the platform makes.
    fireEvent.change(within(verify).getByTestId('procedure-step-kind'), {
      target: { value: 'verify' },
    });
    fireEvent.change(within(verify).getByLabelText(/^说明/), { target: { value: 'Valid.' } });
    fireEvent.change(within(verify).getByTestId('procedure-step-check-kind'), {
      target: { value: 'observe_predicate' },
    });
    expect((within(verify).getByTestId('procedure-step-check-key') as HTMLInputElement).value).toBe(
      'check-3',
    );
    fireEvent.change(within(verify).getByLabelText(/观察哪个门/), {
      target: { value: '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10' },
    });
    fireEvent.change(within(verify).getByTestId('procedure-step-check-operation-input'), {
      target: { value: 'cert.status' },
    });
    fireEvent.change(within(verify).getByTestId('procedure-step-check-expect'), {
      target: { value: '{"path": "state", "op": "eq", "value": "valid"}' },
    });
    expect(within(verify).getByTestId('procedure-step-check-sentence')).toBeTruthy();

    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls.find((call) => call.name === 'propose_procedure')?.params).toEqual({
      procedure: {
        name: 'Renew',
        description: 'Renew certs',
        steps: [
          {
            kind: 'worker',
            definitionId: 'wd-1',
            version: 1,
            key: 'fetch',
            bindings: [{ to: 'target.site', from: '$params', path: 'site' }],
            outputSchema: { type: 'object', properties: { hosts: { type: 'array' } } },
          },
          {
            kind: 'worker',
            definitionId: 'wd-1',
            version: 1,
            bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }],
            maxAttempts: 4,
          },
          {
            kind: 'verify',
            description: 'Valid.',
            check: {
              kind: 'observe_predicate',
              key: 'check-3',
              check: {
                gatekeeperId: '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10',
                operation: 'cert.status',
                expect: { path: 'state', op: 'eq', value: 'valid' },
              },
            },
          },
        ],
        parameters: {
          type: 'object',
          properties: { site: { type: 'string' } },
          required: ['site'],
        },
      },
    });
  });

  it('a renamed key is followed by what named it, and a removal keeps a named step’s key (legacy 453)', async () => {
    const { caller, calls } = http({
      propose_procedure: () => ({ id: 'pr-6', version: 1, status: 'draft', name: 'Two' }),
    });
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Two',
          description: 'Two steps',
          steps: [
            { kind: 'approval', description: 'go' },
            { kind: 'worker', definitionId: 'wd-1', version: 1, outputSchema: { type: 'object' } },
            {
              kind: 'worker',
              definitionId: 'wd-1',
              version: 1,
              dependsOn: ['step-2'],
              bindings: [{ to: 'h', from: 'step-2', path: 'h' }],
            },
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const [, fetch] = screen.getAllByTestId('procedure-step') as [HTMLElement, HTMLElement];
    fireEvent.click(within(fetch).getByText(/用流程生成目标时/));
    const key = within(fetch).getByTestId('procedure-step-plan-key');
    fireEvent.focus(key);
    fireEvent.change(key, { target: { value: 'fetch' } });
    fireEvent.blur(key);
    // Taking the approval step out moves both Workers up: the named one keeps its key.
    fireEvent.click(screen.getByRole('button', { name: '移除第 1 步' }));
    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    const sent = calls.find((call) => call.name === 'propose_procedure')?.params as {
      procedure: { steps: unknown[] };
    };
    expect(sent.procedure.steps).toEqual([
      {
        kind: 'worker',
        definitionId: 'wd-1',
        version: 1,
        key: 'fetch',
        outputSchema: { type: 'object' },
      },
      {
        kind: 'worker',
        definitionId: 'wd-1',
        version: 1,
        dependsOn: ['fetch'],
        bindings: [{ to: 'h', from: 'fetch', path: 'h' }],
      },
    ]);
  });

  it('input that is not JSON is refused at its field, and nothing is sent (legacy 453)', async () => {
    const { caller, calls } = http({});
    render(<ProcedureEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/^描述/), { target: { value: 'Y' } });
    fireEvent.click(screen.getByTestId('procedure-add-step'));
    const step = screen.getByTestId('procedure-step');
    fireEvent.change(within(step).getByTestId('procedure-step-kind'), {
      target: { value: 'worker' },
    });
    fireEvent.change(within(step).getByLabelText(/Worker 定义/), { target: { value: 'wd-1' } });
    fireEvent.click(within(step).getByText(/用流程生成目标时/));
    fireEvent.change(within(step).getByTestId('procedure-step-input'), {
      target: { value: '{mode: safe}' },
    });
    fireEvent.click(screen.getByTestId('procedure-submit'));
    const input = within(step).getByTestId('procedure-step-input');
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(within(step).getByText(/不是合法的 JSON/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('a contract the field list cannot say stays JSON; one it can goes back and forth (legacy 453)', () => {
    const { caller } = http({});
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'One',
          description: 'One step',
          steps: [
            {
              kind: 'worker',
              definitionId: 'wd-1',
              version: 1,
              outputSchema: {
                type: 'object',
                properties: { host: { type: 'object', properties: { name: { type: 'string' } } } },
              },
            },
          ],
          parameters: { type: 'object', properties: { site: { type: 'string' } } },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTestId('procedure-step-output-json-only')).toBeTruthy();
    expect(screen.queryByTestId('procedure-step-output-as-fields')).toBeNull();
    fireEvent.click(screen.getByTestId('procedure-parameters-as-json'));
    const json = screen.getByTestId('procedure-parameters-json') as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual({
      type: 'object',
      properties: { site: { type: 'string' } },
    });
    fireEvent.change(json, {
      target: { value: '{"type": "object", "properties": {"zone": {"type": "integer"}}}' },
    });
    fireEvent.click(screen.getByTestId('procedure-parameters-as-fields'));
    expect((screen.getByTestId('procedure-parameters-field-name') as HTMLInputElement).value).toBe(
      'zone',
    );
    expect((screen.getByTestId('procedure-parameters-field-kind') as HTMLSelectElement).value).toBe(
      'integer',
    );
  });

  it('a step changed to another kind sends only what that kind carries', async () => {
    const { caller, calls } = http({
      propose_procedure: () => ({ id: 'pr-8', version: 1, status: 'draft', name: 'One' }),
    });
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'One',
          description: 'One step',
          steps: [{ kind: 'worker', definitionId: 'wd-1', version: 1, key: 'only', input: {} }],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const step = screen.getByTestId('procedure-step');
    fireEvent.change(within(step).getByTestId('procedure-step-kind'), {
      target: { value: 'verify' },
    });
    fireEvent.change(within(step).getByLabelText(/说明/), { target: { value: 'done' } });
    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls.find((call) => call.name === 'propose_procedure')?.params).toEqual({
      procedure: {
        name: 'One',
        description: 'One step',
        steps: [{ kind: 'verify', description: 'done' }],
      },
    });
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
