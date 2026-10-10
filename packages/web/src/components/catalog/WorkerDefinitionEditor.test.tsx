import type { AvailableGateInstanceWire } from '@nexttime/shared';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { WorkerDefinitionEditor } from './WorkerDefinitionEditor.js';

/** A capability checkbox's accessible name is its label then its registry name (audit P1-8). */
function capabilityName(name: string): RegExp {
  return new RegExp(`(^|\\s)${name}$`);
}

afterEach(cleanup);

/** Scripted caller; `list_available_gate_instances` (the egress-host suggestions) answers empty
 *  unless overridden and is left out of `calls`. */
function http(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: { name: string; params: unknown }[] = [];
  const all: Record<string, (params: unknown) => unknown> = {
    list_available_gate_instances: () => ({ items: [] }),
    ...handlers,
  };
  const caller: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      if (name !== 'list_available_gate_instances') calls.push({ name, params });
      const handler = all[name];
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
    fireEvent.click(screen.getByLabelText(capabilityName('search')));
    fireEvent.click(screen.getByLabelText(capabilityName('traverse')));
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
    const searchCheckbox = screen.getByLabelText(capabilityName('search')) as HTMLInputElement;
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

  it('reduces pasted URLs, ports and wildcard prefixes in the egress deny list to the bare host the proxy matches', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-x', version: 1, status: 'draft' }),
    });
    render(<WorkerDefinitionEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'P' } });
    const deny = screen.getByLabelText(/出网拒绝/) as HTMLTextAreaElement;
    fireEvent.change(deny, {
      target: {
        value:
          'https://Admin.Internal.Example:8443/login?x=1\n*.corp.example\n.lan.example\nnas.local',
      },
    });
    fireEvent.blur(deny);
    expect(deny.value).toBe('admin.internal.example\ncorp.example\nlan.example\nnas.local');
    expect(screen.getByTestId('wd-egress-deny-normalized').textContent).toContain(
      '*.corp.example → corp.example',
    );
    // Typing again hides the stale conversion note.
    fireEvent.change(deny, { target: { value: `${deny.value}\nhttp://x.example/` } });
    expect(screen.queryByTestId('wd-egress-deny-normalized')).toBeNull();
    // Submit normalizes too, without a blur in between.
    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      kind: 'worker',
      definition: {
        systemPrompt: 'P',
        egressDeny: [
          'admin.internal.example',
          'corp.example',
          'lan.example',
          'nas.local',
          'x.example',
        ],
      },
    });
  });

  it('the next-version notice is one language and the success screen names the kind in Chinese', async () => {
    const { caller } = http({
      propose_worker_definition: () => ({ id: 'wd-e', version: 2, status: 'draft' }),
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        newVersionOf={{
          id: 'wd-e',
          version: 1,
          kind: 'worker',
          status: 'published',
          // No name: the success screen then titles the draft by its kind label.
          definition: { systemPrompt: 'Fix.' },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const notice = screen.getByTestId('worker-new-version-notice').textContent ?? '';
    expect(notice).toMatch(/^为 wd-e 提议下一个版本/);
    expect(notice).not.toContain('Proposing');
    fireEvent.click(screen.getByTestId('worker-submit'));
    const done = await screen.findByTestId('draft-proposed');
    expect(done.textContent).toContain('Worker 定义');
    expect(done.textContent).not.toContain('Worker definition');
  });

  it('capabilities are grouped by mode, filterable, and a group can be selected at once', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-g', version: 1, status: 'draft' }),
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        capabilityNames={[
          { name: 'search', mode: 'observe' },
          { name: 'traverse', mode: 'observe' },
          { name: 'get_object', mode: 'observe' },
          { name: 'assert_fact', mode: 'write' },
          { name: 'request_action', mode: 'execute' },
        ]}
        newVersionOf={{
          id: 'wd-g',
          version: 1,
          kind: 'worker',
          status: 'published',
          definition: { systemPrompt: 'P', capabilities: ['legacy_cap'] },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const field = screen.getByTestId('wd-capabilities');
    const groupOrder = Array.from(field.querySelectorAll('fieldset')).map((group) =>
      group.getAttribute('aria-label'),
    );
    // Registry mode order, then the selected name the directory does not list.
    expect(groupOrder).toEqual(['观察（只读）', '写入', '执行', '目录外（已选）']);
    expect(
      (within(field).getByLabelText(capabilityName('legacy_cap')) as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.click(screen.getByTestId('wd-capabilities-group-toggle-observe'));
    for (const name of ['search', 'traverse', 'get_object']) {
      expect((within(field).getByLabelText(capabilityName(name)) as HTMLInputElement).checked).toBe(
        true,
      );
    }
    expect(screen.getByTestId('wd-capabilities-group-toggle-observe').textContent).toBe('取消本组');
    expect(screen.getByTestId('wd-capabilities-count').textContent).toContain('4');

    // The filter narrows every group; "select" then acts on the visible rows only.
    fireEvent.change(screen.getByTestId('wd-capabilities-filter'), { target: { value: 'act' } });
    expect(within(field).queryByLabelText(capabilityName('search'))).toBeNull();
    expect(within(field).getByLabelText(capabilityName('request_action'))).toBeTruthy();
    expect(within(field).getByLabelText(capabilityName('assert_fact'))).toBeTruthy();
    fireEvent.click(screen.getByTestId('wd-capabilities-group-toggle-execute'));
    fireEvent.change(screen.getByTestId('wd-capabilities-filter'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('wd-capabilities-no-match')).toBeTruthy();
    fireEvent.change(screen.getByTestId('wd-capabilities-filter'), { target: { value: '' } });

    // A group can be folded away.
    fireEvent.click(within(field).getByRole('button', { name: /写入/ }));
    expect(within(field).queryByLabelText(capabilityName('assert_fact'))).toBeNull();

    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      definitionId: 'wd-g',
      kind: 'worker',
      definition: {
        systemPrompt: 'P',
        capabilities: ['legacy_cap', 'get_object', 'search', 'traverse', 'request_action'],
      },
    });
  });

  it('offers the hosts of this workspace’s enabled systems as one-click egress-deny entries', async () => {
    const { caller } = http({
      list_available_gate_instances: () => ({
        items: [
          instance({
            gateId: 'billing',
            displayName: 'Billing',
            target: 'https://billing.example.com:8443/api',
            gatekeeperId: 'gk-1',
          }),
          instance({
            gateId: 'erp',
            displayName: 'ERP',
            target: 'erp.example.com',
            gatekeeperId: 'gk-2',
          }),
          // Not enabled in this workspace: not offered.
          instance({
            gateId: 'crm',
            displayName: 'CRM',
            target: 'https://crm.example.com',
            gatekeeperId: null,
          }),
          // No host to deny.
          instance({
            gateId: 'docker',
            displayName: 'Docker',
            target: 'unix:///var/run/docker.sock',
            gatekeeperId: 'gk-3',
          }),
        ],
      }),
    });
    render(<WorkerDefinitionEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    const deny = screen.getByLabelText(/出网拒绝/) as HTMLTextAreaElement;
    fireEvent.change(deny, { target: { value: 'erp.example.com' } });
    const suggestions = await screen.findAllByTestId('wd-egress-suggestion');
    // erp is already on the list; crm is not enabled here; the docker socket has no host.
    expect(suggestions.map((button) => button.textContent)).toEqual(['+ billing.example.com']);
    expect(suggestions[0]?.getAttribute('title')).toBe('Billing');
    fireEvent.click(suggestions[0] as HTMLElement);
    expect(deny.value).toBe('erp.example.com\nbilling.example.com');
    expect(screen.getByTestId('wd-egress-suggestions-empty').textContent).toContain('都已在列表中');
  });

  it('a refused system list degrades to typed hosts with a one-line note; a failed one offers a retry', async () => {
    const refused = http({
      list_available_gate_instances: () => {
        throw new HttpError('capability_error', 'nope', 'forbidden');
      },
    });
    render(<WorkerDefinitionEditor http={refused.caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByTestId('wd-egress-suggestions-refused')).toBeTruthy();
    expect(screen.queryByTestId('wd-egress-suggestions-error')).toBeNull();
    cleanup();

    let attempts = 0;
    const failing = http({
      list_available_gate_instances: () => {
        attempts += 1;
        if (attempts === 1) throw new HttpError('capability_error', 'boom', 'internal_error');
        return {
          items: [
            instance({
              gateId: 'billing',
              displayName: 'Billing',
              target: 'https://billing.example.com',
              gatekeeperId: 'gk-1',
            }),
          ],
        };
      },
    });
    render(<WorkerDefinitionEditor http={failing.caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    const banner = await screen.findByTestId('wd-egress-suggestions-error');
    fireEvent.click(within(banner).getByRole('button', { name: '重试' }));
    expect((await screen.findAllByTestId('wd-egress-suggestion')).length).toBe(1);
  });
});

function instance(
  overrides: Pick<AvailableGateInstanceWire, 'gateId' | 'displayName' | 'target' | 'gatekeeperId'>,
): AvailableGateInstanceWire {
  return {
    connector: 'openapi',
    transportKind: 'http',
    status: 'enabled',
    trust: 'vetted',
    health: 'ok',
    operationCount: 1,
    ...overrides,
  };
}
