import type { AvailableGateInstanceWire } from '@nexttime/shared';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
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
      if (name !== 'list_available_gate_instances' && name !== 'get_workspace') {
        calls.push({ name, params });
      }
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
          inputSchema: null,
          outputSchema: null,
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

  it('S11 GO13: a Worker’s input and output contracts are edited field by field, survive the JSON view, are sent with the definition, and a broken one is marked on its section', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-c', version: 1, status: 'draft' }),
    });
    render(<WorkerDefinitionEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'P' } });
    // Adding a contract hands focus to its 添加字段.
    fireEvent.click(screen.getByTestId('wd-add-outputSchema'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('wd-outputSchema-add-field')),
    );
    fireEvent.click(screen.getByTestId('wd-outputSchema-add-field'));
    const output = screen.getByTestId('wd-outputSchema');
    fireEvent.change(within(output).getByTestId('wd-outputSchema-field-name'), {
      target: { value: 'summary' },
    });
    fireEvent.click(within(output).getByTestId('wd-outputSchema-field-required'));
    fireEvent.click(screen.getByTestId('wd-add-inputSchema'));
    // The input contract in JSON, the way an author may paste one.
    fireEvent.click(
      within(screen.getByTestId('wd-inputSchema')).getByTestId('wd-inputSchema-as-json'),
    );
    fireEvent.change(screen.getByTestId('wd-inputSchema-json'), {
      target: { value: '{"type": "object", "properties": {"host": {"type": "string"}' },
    });
    fireEvent.click(screen.getByTestId('worker-submit'));
    // JSON that does not parse is the input contract's problem, and nothing is sent.
    expect(screen.getByTestId('wd-inputSchema-errors').textContent).toMatch(/不是合法的 JSON/);
    expect(calls).toEqual([]);
    fireEvent.change(screen.getByTestId('wd-inputSchema-json'), {
      target: { value: '{"type": "object", "properties": {"host": {"type": "string"}}}' },
    });
    // Through the definition's own JSON view and back, nothing is lost.
    fireEvent.click(screen.getByTestId('worker-view-json'));
    fireEvent.click(screen.getByTestId('worker-json-apply'));
    fireEvent.click(screen.getByTestId('worker-view-form'));
    expect(
      (
        within(screen.getByTestId('wd-outputSchema')).getByTestId(
          'wd-outputSchema-field-name',
        ) as HTMLInputElement
      ).value,
    ).toBe('summary');
    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      kind: 'worker',
      definition: {
        systemPrompt: 'P',
        inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
        outputSchema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    });
  });

  it('S11 GO13: dropping a contract leaves it out of the definition and hands focus to the button that adds it back', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => ({ id: 'wd-d', version: 2, status: 'draft' }),
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        newVersionOf={{
          id: 'wd-d',
          version: 1,
          kind: 'worker',
          status: 'published',
          definition: {
            systemPrompt: 'P',
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // The next version starts from the published one's contract, as fields.
    const output = screen.getByTestId('wd-outputSchema');
    expect(
      (within(output).getByTestId('wd-outputSchema-field-name') as HTMLInputElement).value,
    ).toBe('ok');
    fireEvent.click(within(output).getByTestId('wd-outputSchema-remove'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('wd-add-outputSchema')),
    );
    fireEvent.click(screen.getByTestId('worker-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      definitionId: 'wd-d',
      kind: 'worker',
      definition: { systemPrompt: 'P' },
    });
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
    expect(notice).toMatch(/^为 未命名 Worker 定义 提议下一个版本/);
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

  it('legacy 680: a next version refused over the caller’s own pending draft says so and offers to show that draft', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => {
        throw new HttpError('capability_error', 'kernel text', 'draft_pending', {
          familyId: 'wd-d',
          draftVersion: 3,
        });
      },
    });
    const onShowPendingDraft = vi.fn();
    render(
      <WorkerDefinitionEditor
        http={caller}
        newVersionOf={{
          id: 'wd-d',
          version: 2,
          kind: 'worker',
          status: 'published',
          definition: { systemPrompt: 'P' },
        }}
        onShowPendingDraft={onShowPendingDraft}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('worker-submit'));
    const banner = await screen.findByTestId('worker-editor-error');
    expect(banner.textContent).toMatch(/你在这个 Worker 定义下已经有一份草稿 v3/);
    expect(banner.textContent).toMatch(/用这次写的内容替换它/);
    // Not the Skill sentence (a Skill's publish takes the latest version).
    expect(banner.textContent).not.toMatch(/发布总是取最新版本/);
    // A next version of a published one: nothing replaced on the first save.
    expect(calls[0]?.params).not.toHaveProperty('replacesDraft');
    fireEvent.click(within(banner).getByTestId('worker-show-pending-draft'));
    expect(onShowPendingDraft).toHaveBeenCalledWith({ id: 'wd-d', version: 3 });
    // Legacy 743 / 744: a next version is proposed, not saved over a draft; nothing went.
    expect(banner.textContent).toContain('无法创建草稿');
    expect(within(banner).queryByTestId('worker-propose-after-changed')).toBeNull();
  });

  it('legacy 745: the English field labels are words, not schema keys', () => {
    try {
      localStorage.setItem('nexttime.lang', 'en');
      const { caller } = http({});
      render(
        <LangProvider>
          <WorkerDefinitionEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />
        </LangProvider>,
      );
      for (const label of [
        'Kind',
        'Name',
        'Model',
        'Description',
        'System prompt',
        'Egress deny list',
      ]) {
        expect(screen.getByLabelText(new RegExp(`^${label}`))).toBeTruthy();
      }
      expect(screen.getByText('Gates')).toBeTruthy();
      expect(screen.getByText('Skills')).toBeTruthy();
      expect(screen.queryByLabelText(/^(description|systemPrompt|egressDeny)/)).toBeNull();
    } finally {
      localStorage.removeItem('nexttime.lang');
    }
  });

  it('legacy 680 (UX acceptance of #1218): refused over the caller’s own draft, the form replaces that draft on request — what was written is kept', async () => {
    let first = true;
    const { caller, calls } = http({
      propose_worker_definition: () => {
        if (first) {
          first = false;
          throw new HttpError('capability_error', 'kernel text', 'draft_pending', {
            familyId: 'wd-d',
            draftVersion: 3,
          });
        }
        return { id: 'wd-d', version: 4, status: 'draft' };
      },
    });
    const onProposed = vi.fn();
    render(
      <WorkerDefinitionEditor
        http={caller}
        newVersionOf={{
          id: 'wd-d',
          version: 2,
          kind: 'worker',
          status: 'published',
          definition: { systemPrompt: 'P' },
        }}
        onProposed={onProposed}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'Written here' } });
    fireEvent.click(screen.getByTestId('worker-submit'));
    const banner = await screen.findByTestId('worker-editor-error');
    // No way to show it here, but replacing it is the form's own.
    expect(within(banner).queryByTestId('worker-show-pending-draft')).toBeNull();
    const replace = within(banner).getByTestId('worker-replace-pending-draft');
    expect(replace.textContent).toMatch(/替换草稿 v3/);
    fireEvent.click(replace);
    await waitFor(() => expect(onProposed).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.params)).toEqual([
      expect.not.objectContaining({ replacesDraft: expect.anything() }),
      expect.objectContaining({
        definitionId: 'wd-d',
        replacesDraft: 3,
        definition: expect.objectContaining({ systemPrompt: 'Written here' }),
      }),
    ]);
  });

  it('legacy 680: editing the caller’s own draft says it replaces it and sends replacesDraft; gone since, it says so', async () => {
    const { caller, calls } = http({
      propose_worker_definition: () => {
        throw new HttpError('capability_error', 'kernel text', 'draft_changed', {
          familyId: 'wd-d',
          draftVersion: 2,
        });
      },
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        newVersionOf={{
          id: 'wd-d',
          version: 2,
          kind: 'worker',
          status: 'draft',
          definition: { systemPrompt: 'P' },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTestId('worker-edit-draft-notice').textContent).toMatch(
      /的草稿 v2.*替换它（v2 随之丢弃）/,
    );
    expect(screen.queryByTestId('worker-new-version-notice')).toBeNull();
    fireEvent.click(screen.getByTestId('worker-submit'));
    const banner = await screen.findByTestId('worker-editor-error');
    expect(calls[0]?.params).toMatchObject({ definitionId: 'wd-d', replacesDraft: 2 });
    expect(banner.textContent).toMatch(/你在改的草稿 v2 已经不是待审草稿了/);
    expect(within(banner).queryByTestId('worker-replace-pending-draft')).toBeNull();
    // Legacy 743: saving an existing draft is not proposing one.
    expect(banner.textContent).toContain('无法保存草稿');
    expect(banner.textContent).not.toContain('无法创建草稿');
  });

  it('legacy 744: the draft being edited went since — what was written is proposed as a new draft on request, replacing nothing', async () => {
    let first = true;
    const { caller, calls } = http({
      propose_worker_definition: () => {
        if (first) {
          first = false;
          throw new HttpError('capability_error', 'kernel text', 'draft_changed', {
            familyId: 'wd-d',
            draftVersion: 2,
          });
        }
        return { id: 'wd-d', version: 4, status: 'draft' };
      },
    });
    const onProposed = vi.fn();
    render(
      <WorkerDefinitionEditor
        http={caller}
        newVersionOf={{
          id: 'wd-d',
          version: 2,
          kind: 'worker',
          status: 'draft',
          definition: { systemPrompt: 'P' },
        }}
        onProposed={onProposed}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'Written here' } });
    fireEvent.click(screen.getByTestId('worker-submit'));
    const banner = await screen.findByTestId('worker-editor-error');
    expect(banner.textContent).toMatch(/这次写的内容还在编辑器里/);
    // UX acceptance of #1220 (P3): saving would replace the gone draft again — the banner is the way on.
    expect((screen.getByTestId('worker-submit') as HTMLButtonElement).disabled).toBe(true);
    const again = within(banner).getByTestId('worker-propose-after-changed');
    expect(again.textContent).toBe('用这次的内容新建草稿');
    fireEvent.click(again);
    await waitFor(() => expect(onProposed).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.params)).toEqual([
      expect.objectContaining({ definitionId: 'wd-d', replacesDraft: 2 }),
      expect.objectContaining({
        definitionId: 'wd-d',
        definition: expect.objectContaining({ systemPrompt: 'Written here' }),
      }),
    ]);
    expect(calls[1]?.params).not.toHaveProperty('replacesDraft');
  });

  it('legacy 680: without a family (a new draft) no draft is offered', async () => {
    const { caller } = http({
      propose_worker_definition: () => {
        throw new HttpError('capability_error', 'kernel text', 'draft_pending', {
          familyId: 'wd-d',
          draftVersion: 3,
        });
      },
    });
    render(
      <WorkerDefinitionEditor
        http={caller}
        onShowPendingDraft={vi.fn()}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/系统提示词/), { target: { value: 'P' } });
    fireEvent.click(screen.getByTestId('worker-submit'));
    const banner = await screen.findByTestId('worker-editor-error');
    expect(within(banner).queryByTestId('worker-show-pending-draft')).toBeNull();
    expect(within(banner).queryByTestId('worker-replace-pending-draft')).toBeNull();
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
