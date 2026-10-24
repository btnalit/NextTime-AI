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

/** The listbox a combobox's input controls. */
function listOf(input: HTMLElement): HTMLElement {
  return document.getElementById(input.getAttribute('aria-controls') ?? '') as HTMLElement;
}

/** Opens a combobox and returns the names it offers. */
function offered(input: HTMLInputElement): string[] {
  if (input.getAttribute('aria-expanded') !== 'true') fireEvent.click(input);
  return within(listOf(input))
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
      within(verify).getByTestId('procedure-step-check-expect-path').getAttribute('aria-invalid'),
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
    // What the result must satisfy, as a condition: where, how it compares, the value.
    fireEvent.change(within(verify).getByTestId('procedure-step-check-expect-path'), {
      target: { value: 'state' },
    });
    fireEvent.change(within(verify).getByTestId('procedure-step-check-expect-value'), {
      target: { value: 'valid' },
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

  it('never leads into a cycle: a step waiting for this one cannot be waited for or taken from (UX P2-2 on #738)', () => {
    const { caller } = http({});
    const worker = (key: string, extra: Record<string, unknown> = {}) => ({
      kind: 'worker',
      definitionId: 'wd-1',
      version: 1,
      key,
      outputSchema: { type: 'object', properties: { n: { type: 'integer' } } },
      ...extra,
    });
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Three',
          description: 'Three steps',
          steps: [
            worker('scan', { bindings: [{ to: 'n', from: 'recount', path: 'n' }] }),
            worker('recount'),
            worker('report', { bindings: [{ to: 'n', from: 'scan', path: 'n' }] }),
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const [scan, , report] = screen.getAllByTestId('procedure-step') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    // recount waits for scan: scan's sources offer it disabled, and say why.
    const sources = within(scan).getByTestId('procedure-step-binding-from') as HTMLSelectElement;
    const recountOption = [...sources.options].find((option) => option.value === 'recount');
    expect(recountOption?.textContent).toMatch(/它在等这一步/);
    // It is the source already (from the copy): said in the form's words, with no way to wait.
    expect(within(scan).getByTestId('procedure-step-binding-issue').textContent).toMatch(
      /^步骤 recount 在等这一步/,
    );
    expect(within(scan).queryByTestId('procedure-step-binding-wait')).toBeNull();
    fireEvent.click(within(scan).getByTestId('procedure-step-depends-own'));
    const waits = within(scan).getAllByTestId('procedure-step-depends-on') as HTMLInputElement[];
    expect(waits.map((box) => box.disabled)).toEqual([true, true]);
    expect(within(scan).getAllByTestId('procedure-step-depends-loops')).toHaveLength(2);

    // report waits for recount only: taking from scan says so, and one click adds the wait.
    expect(within(report).getByTestId('procedure-step-binding-issue').textContent).toMatch(
      /^这一步不等步骤 scan 完成.*「什么时候开始」/,
    );
    fireEvent.click(within(report).getByTestId('procedure-step-binding-wait'));
    expect(
      (within(report).getByTestId('procedure-step-depends-own') as HTMLInputElement).checked,
    ).toBe(true);
    const reportWaits = within(report).getAllByTestId(
      'procedure-step-depends-on',
    ) as HTMLInputElement[];
    expect(reportWaits.map((box) => box.checked)).toEqual([true, true]);
    expect(within(report).queryByTestId('procedure-step-binding-issue')).toBeNull();
  });

  it('a cycle that came with the Procedure is said where it is (UX P2-2 on #738)', () => {
    const { caller } = http({});
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Loop',
          description: 'Two steps waiting for each other',
          steps: [
            { kind: 'worker', definitionId: 'wd-1', version: 1, key: 'a', dependsOn: ['b'] },
            { kind: 'worker', definitionId: 'wd-1', version: 1, key: 'b' },
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const [a, b] = screen.getAllByTestId('procedure-step') as [HTMLElement, HTMLElement];
    expect(within(a).getByTestId('procedure-step-depends-cycle').textContent).toMatch(
      /^这一步在等 b/,
    );
    expect(within(b).getByTestId('procedure-step-depends-cycle').textContent).toMatch(
      /^这一步在等 a/,
    );
    // Taking the wait out is still possible, and ends it.
    const [toB] = within(a).getAllByTestId('procedure-step-depends-on') as [HTMLInputElement];
    expect(toB.disabled).toBe(false);
    fireEvent.click(toB);
    expect(screen.queryByTestId('procedure-step-depends-cycle')).toBeNull();
  });

  it('a control its own change takes away hands focus on, not to <body> (UX P3-5 on #738)', () => {
    const { caller } = http({});
    const worker = (key: string, extra: Record<string, unknown> = {}) => ({
      kind: 'worker',
      definitionId: 'wd-1',
      version: 1,
      key,
      outputSchema: {
        type: 'object',
        properties: { n: { type: 'integer' }, m: { type: 'integer' } },
      },
      ...extra,
    });
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Three',
          description: 'Three steps',
          steps: [
            worker('scan'),
            worker('recount'),
            worker('report', { bindings: [{ to: 'n', from: 'scan', path: 'n' }] }),
          ],
          parameters: { type: 'object', properties: { site: { type: 'string' } } },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const step = (n: number) => screen.getAllByTestId('procedure-step')[n] as HTMLElement;
    const focused = () => document.activeElement as HTMLElement;

    // 也等 scan goes once report waits for it: focus is on the box now ticked.
    fireEvent.click(within(step(2)).getByTestId('procedure-step-binding-wait'));
    expect(focused().dataset.depKey).toBe('scan');
    expect((focused() as HTMLInputElement).checked).toBe(true);

    // The last binding removed: 添加绑定.
    fireEvent.click(within(step(2)).getByRole('button', { name: '移除第 1 个绑定' }));
    expect(focused().dataset.testid).toBe('procedure-step-add-binding');

    // A field removed: the next field's name; the last one: 添加字段.
    fireEvent.click(within(step(0)).getByRole('button', { name: '移除第 1 个字段' }));
    expect((focused() as HTMLInputElement).value).toBe('m');
    fireEvent.click(within(step(0)).getByRole('button', { name: '移除第 1 个字段' }));
    expect(focused().dataset.testid).toBe('procedure-step-output-add-field');

    // The contract dropped: 添加输出约定; added again: its 添加字段.
    fireEvent.click(within(step(0)).getByTestId('procedure-step-output-remove'));
    expect(focused().dataset.testid).toBe('procedure-step-add-output');
    fireEvent.click(within(step(0)).getByTestId('procedure-step-add-output'));
    expect(focused().dataset.testid).toBe('procedure-step-output-add-field');

    // The parameters dropped and added again, the same way.
    fireEvent.click(screen.getByTestId('procedure-parameters-remove'));
    expect(focused().dataset.testid).toBe('procedure-add-parameters');
    fireEvent.click(screen.getByTestId('procedure-add-parameters'));
    expect(focused().dataset.testid).toBe('procedure-parameters-add-field');

    // recount moved to the top, where 上移 is disabled: its 下移.
    fireEvent.click(within(step(1)).getByRole('button', { name: '上移第 2 步' }));
    expect(focused().getAttribute('aria-label')).toBe('下移第 1 步');
    expect(within(step(0)).getByTestId('procedure-step-plan').textContent).toMatch(/recount/);
    // It moves down again, not to an end: still 下移.
    fireEvent.click(focused());
    expect(focused().getAttribute('aria-label')).toBe('下移第 2 步');

    // A step removed: the next step's kind; the last one: 添加步骤.
    fireEvent.click(within(step(0)).getByRole('button', { name: '移除第 1 步' }));
    expect(focused()).toBe(within(step(0)).getByTestId('procedure-step-kind'));
    fireEvent.click(within(step(1)).getByRole('button', { name: '移除第 2 步' }));
    expect(focused().dataset.testid).toBe('procedure-add-step');
  });

  it('what the observed result must satisfy is built in the form: conditions, a group, a negation (legacy 464)', async () => {
    const { caller, calls } = http({
      propose_procedure: () => ({ id: 'pr-7', version: 1, status: 'draft', name: 'Check' }),
    });
    const gate = '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10';
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Check',
          description: 'Check a cert',
          steps: [
            {
              kind: 'verify',
              description: 'Valid.',
              check: {
                kind: 'observe_predicate',
                key: 'valid',
                check: {
                  gatekeeperId: gate,
                  operation: 'cert.status',
                  expect: { path: 'state', op: 'eq', value: 'valid' },
                },
              },
            },
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const expectBox = screen.getByTestId('procedure-step-check-expect');
    // A lone condition: no 全部 / 任一 to choose yet.
    expect(within(expectBox).getAllByTestId('procedure-step-check-expect-condition')).toHaveLength(
      1,
    );
    expect(within(expectBox).queryByTestId('procedure-step-check-expect-mode')).toBeNull();

    // A second condition: focus on its path; an ordering comparison offers numbers or text only.
    fireEvent.click(
      within(expectBox).getAllByTestId(
        'procedure-step-check-expect-add-condition',
      )[0] as HTMLElement,
    );
    const [, second] = within(expectBox).getAllByTestId(
      'procedure-step-check-expect-condition',
    ) as [HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(
      within(second).getByTestId('procedure-step-check-expect-path'),
    );
    fireEvent.change(within(second).getByTestId('procedure-step-check-expect-path'), {
      target: { value: 'daysLeft' },
    });
    fireEvent.change(within(second).getByTestId('procedure-step-check-expect-op'), {
      target: { value: 'gt' },
    });
    const kind = within(second).getByTestId(
      'procedure-step-check-expect-value-kind',
    ) as HTMLSelectElement;
    expect([...kind.options].map((option) => option.value)).toEqual(['number', 'string']);
    // An empty value turns to a number with the ordering comparison (UX #743 P2-1).
    expect(kind.value).toBe('number');
    expect(within(second).queryByTestId('procedure-step-check-expect-text-order')).toBeNull();
    fireEvent.change(within(second).getByTestId('procedure-step-check-expect-value'), {
      target: { value: '7' },
    });
    expect(within(expectBox).getByTestId('procedure-step-check-expect-mode')).toBeTruthy();

    // A group of which any holds, negated.
    fireEvent.click(
      within(expectBox).getAllByTestId('procedure-step-check-expect-add-group')[0] as HTMLElement,
    );
    const group = within(expectBox).getByTestId('procedure-step-check-expect-group');
    fireEvent.change(within(group).getByTestId('procedure-step-check-expect-path'), {
      target: { value: 'issuer' },
    });
    fireEvent.change(within(group).getByTestId('procedure-step-check-expect-value'), {
      target: { value: 'self' },
    });
    fireEvent.click(within(group).getByTestId('procedure-step-check-expect-group-negate'));

    // A number that is not one is said on its row.
    fireEvent.change(within(second).getByTestId('procedure-step-check-expect-value'), {
      target: { value: 'seven' },
    });
    fireEvent.click(screen.getByTestId('procedure-submit'));
    expect(await within(second).findByText('要填一个数字')).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.change(within(second).getByTestId('procedure-step-check-expect-value'), {
      target: { value: '7' },
    });
    expect(screen.getByTestId('procedure-step-check-sentence').textContent).toMatch(
      /daysLeft 大于 7/,
    );

    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    const sent = calls.find((call) => call.name === 'propose_procedure')?.params as {
      procedure: { steps: { check: { check: { expect: unknown } } }[] };
    };
    expect(sent.procedure.steps[0]?.check.check.expect).toEqual({
      all: [
        { path: 'state', op: 'eq', value: 'valid' },
        { path: 'daysLeft', op: 'gt', value: 7 },
        { not: { any: [{ path: 'issuer', op: 'eq', value: 'self' }] } },
      ],
    });
  });

  it('a predicate the form cannot say stays JSON, and says where (legacy 464)', () => {
    const { caller } = http({});
    const expectValue = { not: { not: { path: 'a', op: 'exists' } } };
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Odd',
          description: 'A double negation',
          steps: [
            {
              kind: 'verify',
              description: 'Odd.',
              check: {
                kind: 'observe_predicate',
                key: 'odd',
                check: {
                  gatekeeperId: '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10',
                  operation: 'x',
                  expect: expectValue,
                },
              },
            },
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(
      JSON.parse(
        (screen.getByTestId('procedure-step-check-expect-json') as HTMLTextAreaElement).value,
      ),
    ).toEqual(expectValue);
    expect(screen.getByTestId('procedure-step-check-expect-json-only').textContent).toMatch(
      /整个条件是「不满足」套「不满足」/,
    );
    expect(screen.queryByTestId('procedure-step-check-expect-as-form')).toBeNull();
  });

  it('the Fact a check judges is built from the ontology and the graph, identity as stored (legacy 464)', async () => {
    const host = '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10';
    const { caller, calls } = http({
      list_types: (params) =>
        (params as { kind?: string }).kind === 'link'
          ? {
              items: [
                {
                  kind: 'link',
                  name: 'runs_on',
                  signatures: [{ domain: 'Service', range: 'Host', description: '' }],
                },
              ],
            }
          : {
              items: [
                { kind: 'object', name: 'Service', description: '', identityKey: ['name', 'env'] },
                { kind: 'object', name: 'Host', description: '', identityKey: ['hostId'] },
                { kind: 'object', name: 'Disk', description: '' },
              ],
            },
      search: () => ({
        items: [
          {
            id: host,
            objectType: 'Host',
            identityKey: { hostId: 3 },
            properties: { name: 'h3' },
            createdAt: '',
            updatedAt: '',
            lastObservedAt: null,
          },
        ],
      }),
      list_facts: () => ({ items: [], nodeDetails: [] }),
      propose_procedure: () => ({ id: 'pr-8', version: 1, status: 'draft', name: 'On host' }),
    });
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'On host',
          description: 'Runs on its host',
          steps: [
            {
              kind: 'verify',
              description: 'Placed.',
              check: { kind: 'fact_predicate', key: 'on-host' },
            },
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const fact = screen.getByTestId('procedure-step-check-fact');
    fireEvent.change(within(fact).getByTestId('procedure-step-check-fact-link'), {
      target: { value: 'runs_on' },
    });

    // From: the type's own identity fields, named and fixed; the value typed.
    const source = within(fact).getByTestId('procedure-step-check-fact-source');
    fireEvent.change(within(source).getByTestId('procedure-step-check-fact-source-type'), {
      target: { value: 'Service' },
    });
    const keys = (await within(source).findAllByTestId(
      'procedure-step-check-fact-source-identity-key',
    )) as HTMLInputElement[];
    expect(keys.map((key) => [key.value, key.readOnly])).toEqual([
      ['name', true],
      ['env', true],
    ]);
    const [name, env] = within(source).getAllByTestId(
      'procedure-step-check-fact-source-identity-value',
    ) as [HTMLInputElement, HTMLInputElement];
    fireEvent.change(name, { target: { value: 'web' } });
    // A number typed as text is called out: identities match exactly.
    fireEvent.change(env, { target: { value: '42' } });
    expect(
      within(source).getByTestId('procedure-step-check-fact-source-identity-numeric-text'),
    ).toBeTruthy();
    fireEvent.change(env, { target: { value: 'prod' } });
    expect(
      within(source).queryByTestId('procedure-step-check-fact-source-identity-numeric-text'),
    ).toBeNull();

    // To: only the type the Link type allows there; the identity filled from a picked Object.
    const target = within(fact).getByTestId('procedure-step-check-fact-target');
    const targetType = within(target).getByTestId(
      'procedure-step-check-fact-target-type',
    ) as HTMLInputElement;
    await waitFor(() => expect(offered(targetType)).toEqual(['Host']));
    fireEvent.change(targetType, { target: { value: 'Host' } });
    const fill = within(target).getByTestId('procedure-step-check-fact-target-fill');
    fireEvent.change(fill, { target: { value: 'h3' } });
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.name === 'search' &&
            (call.params as { objectType?: string }).objectType === 'Host',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(offered(fill as HTMLInputElement)).toEqual(['h3 · Host']));
    fireEvent.click(within(listOf(fill)).getByRole('option'));
    const [hostId] = within(target).getAllByTestId(
      'procedure-step-check-fact-target-identity-value',
    ) as [HTMLInputElement];
    expect(hostId.value).toBe('3');
    expect(
      (
        within(target).getByTestId(
          'procedure-step-check-fact-target-identity-kind',
        ) as HTMLSelectElement
      ).value,
    ).toBe('number');

    // And its properties: one condition.
    fireEvent.click(within(fact).getByTestId('procedure-step-check-fact-add-expect'));
    fireEvent.change(within(fact).getByTestId('procedure-step-check-fact-expect-path'), {
      target: { value: 'port' },
    });
    fireEvent.change(within(fact).getByTestId('procedure-step-check-fact-expect-value-kind'), {
      target: { value: 'number' },
    });
    fireEvent.change(within(fact).getByTestId('procedure-step-check-fact-expect-value'), {
      target: { value: '443' },
    });

    fireEvent.click(screen.getByTestId('procedure-submit'));
    await screen.findByTestId('draft-proposed');
    const sent = calls.find((call) => call.name === 'propose_procedure')?.params as {
      procedure: { steps: { check: { fact: unknown } }[] };
    };
    expect(sent.procedure.steps[0]?.check.fact).toEqual({
      linkType: 'runs_on',
      source: { objectType: 'Service', identity: { name: 'web', env: 'prod' } },
      target: { objectType: 'Host', identity: { hostId: 3 } },
      expect: { path: 'port', op: 'eq', value: 443 },
    });
  });

  it('an identity that lacks a field of its type, or has one it does not, is said (legacy 464)', () => {
    const { caller } = http({
      list_types: (params) =>
        (params as { kind?: string }).kind === 'link'
          ? { items: [] }
          : {
              items: [
                { kind: 'object', name: 'Service', description: '', identityKey: ['name', 'env'] },
              ],
            },
    });
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'Odd',
          description: 'A partial identity',
          steps: [
            {
              kind: 'verify',
              description: 'Placed.',
              check: {
                kind: 'fact_predicate',
                key: 'placed',
                fact: {
                  linkType: 'runs_on',
                  source: { objectType: 'Service', identity: { name: 'web', zone: 'a' } },
                  target: { objectId: '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10' },
                },
              },
            },
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    return waitFor(() => {
      const source = screen.getByTestId('procedure-step-check-fact-source');
      expect(
        within(source).getByTestId('procedure-step-check-fact-source-identity-missing').textContent,
      ).toMatch(/还差身份字段 env/);
      expect(
        within(source).getByTestId('procedure-step-check-fact-source-identity-extra'),
      ).toBeTruthy();
    });
  });

  it('an Object chosen by id is one this end takes, named by name and type, also when reopened (legacy 464)', async () => {
    const host = '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10';
    const service = '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f11';
    const object = (id: string, objectType: string, name: string) => ({
      id,
      objectType,
      identityKey: { name },
      properties: { name },
      createdAt: '',
      updatedAt: '',
      lastObservedAt: null,
    });
    const { caller } = http({
      list_types: (params) =>
        (params as { kind?: string }).kind === 'link'
          ? {
              items: [
                {
                  kind: 'link',
                  name: 'runs_on',
                  signatures: [
                    { domain: 'Service', range: 'Host', description: '' },
                    { domain: 'Job', range: 'Host', description: '' },
                  ],
                },
              ],
            }
          : { items: [] },
      search: () => ({ items: [object(host, 'Host', 'h3'), object(service, 'Service', 'web')] }),
      get_object: (params) => {
        const { objectId } = params as { objectId: string };
        if (objectId === host) return object(host, 'Host', 'h3');
        return objectId === service ? object(service, 'Service', 'web') : null;
      },
    });
    render(
      <ProcedureEditor
        http={caller}
        copyOf={{
          id: 'pr-1',
          version: 1,
          status: 'published',
          name: 'On host',
          description: 'Reopened',
          steps: [
            {
              kind: 'verify',
              description: 'Placed.',
              check: {
                kind: 'fact_predicate',
                key: 'placed',
                fact: { linkType: 'runs_on', source: { objectId: host }, target: {} },
              },
            },
          ],
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const source = screen.getByTestId('procedure-step-check-fact-source');
    const picked = within(source).getByTestId(
      'procedure-step-check-fact-source-object',
    ) as HTMLInputElement;
    // Reopened: named by name and type, not its id; and a Host is not what this end takes.
    await waitFor(() => expect(picked.value).toBe('h3 · Host'));
    expect(
      within(source).getByTestId('procedure-step-check-fact-source-object-warning').textContent,
    ).toMatch(/关系类型的这一端不接 Host/);
    // Offered: only the Objects of a type this end takes (Service or Job here).
    fireEvent.change(picked, { target: { value: 'e' } });
    await waitFor(() => expect(offered(picked)).toEqual(['web · Service']));
    // An id typed whole is taken; Enter takes that Object, not the first row offered before
    // (UX P2-3 on #746), and the field names it; this end takes a Service.
    fireEvent.change(picked, { target: { value: service } });
    await waitFor(() => expect(offered(picked)).toEqual(['web · Service']));
    fireEvent.keyDown(picked, { key: 'Enter' });
    await waitFor(() => expect(picked.value).toBe('web · Service'));
    expect(
      within(source).queryByTestId('procedure-step-check-fact-source-object-warning'),
    ).toBeNull();

    // An end with no type chosen yet asks for the type first, and offers no identity field.
    const target = screen.getByTestId('procedure-step-check-fact-target');
    expect(
      within(target).getByTestId('procedure-step-check-fact-target-identity-pick-type'),
    ).toBeTruthy();
    expect(
      within(target).queryByTestId('procedure-step-check-fact-target-identity-add'),
    ).toBeNull();
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
    // UX P3-4 on #738: the reason names the field and what of it the list cannot say.
    expect(screen.getByTestId('procedure-step-output-json-only').textContent).toMatch(
      /字段 host 写了 properties/,
    );
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
