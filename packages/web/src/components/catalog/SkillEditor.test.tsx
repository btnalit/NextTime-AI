// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { SkillEditor } from './SkillEditor.js';

afterEach(cleanup);

const OBJECT_TYPES = [
  { kind: 'object', name: 'Host', description: 'A machine' },
  { kind: 'object', name: 'Container', description: 'A running container' },
];

/** Scripted caller; `list_types` answers with `OBJECT_TYPES` unless overridden, and is left out of
 *  `calls` (the editor's directory read, not what these tests assert on). */
function http(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: { name: string; params: unknown }[] = [];
  const all: Record<string, (params: unknown) => unknown> = {
    list_types: () => ({ items: OBJECT_TYPES }),
    ...handlers,
  };
  const caller: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      if (name !== 'list_types' && name !== 'get_workspace') calls.push({ name, params });
      const handler = all[name];
      if (!handler) throw new Error(`unscripted ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
  return { caller, calls };
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Types into the object-type combobox and clicks the matching option. */
async function pickObjectType(name: string) {
  const input = screen.getByTestId('skill-object-types') as HTMLInputElement;
  await waitFor(() => expect(input.getAttribute('aria-busy')).toBeNull());
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(
    within(screen.getByRole('listbox')).getByRole('option', { name: new RegExp(`^${name}`) }),
  );
}

describe('SkillEditor (S6-A A2)', () => {
  it('submits propose_skill{skill} in the ProposeSkillContentSchema shape, then publishes via publish_skill{skillId}', async () => {
    const { caller, calls } = http({
      propose_skill: () => ({ id: 'sk-1', version: 1, status: 'draft', name: 'restart-web' }),
      publish_skill: () => ({ id: 'sk-1', version: 1, status: 'published' }),
    });
    const onProposed = vi.fn();
    render(<SkillEditor http={caller} onProposed={onProposed} onDone={vi.fn()} />);
    fill(/^名称/, 'restart-web');
    fill(/^描述/, 'Restart the web tier');
    fireEvent.click(screen.getByLabelText('HTTP'));
    fireEvent.click(screen.getByLabelText('SSH'));
    await screen.findByTestId('skill-object-types');
    await pickObjectType('Container');
    // Picked names become chips and leave the list.
    expect(screen.getByTestId('skill-object-types-chosen').textContent).toContain('Container');
    fill(/SKILL.md 正文/, '# Steps\n\n1. restart');
    fireEvent.click(screen.getByTestId('skill-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]).toEqual({
      name: 'propose_skill',
      params: {
        skill: {
          name: 'restart-web',
          description: 'Restart the web tier',
          markdown: '# Steps\n\n1. restart',
          applicable: { gateKinds: ['http', 'ssh'], objectTypes: ['Container'] },
        },
      },
    });
    expect(onProposed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sk-1', status: 'draft' }),
    );
    expect(screen.getByTestId('draft-private-notice').textContent).toContain('只有你');
    fireEvent.click(screen.getByTestId('draft-publish'));
    await waitFor(() =>
      expect(calls[1]).toEqual({ name: 'publish_skill', params: { skillId: 'sk-1' } }),
    );
    await waitFor(() => expect(screen.queryByTestId('draft-publish')).toBeNull());
  });

  it('normalizes the name to the publish rule as typed, and blocks submission with field errors from the schema', async () => {
    const { caller, calls } = http({});
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fill(/^名称/, 'Restart Web');
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe('restart-web');
    expect(screen.getByText(/已自动改为发布要求的格式/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('skill-submit'));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(calls).toHaveLength(0);
    expect(screen.getByLabelText(/^描述/).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(/SKILL.md 正文/).getAttribute('aria-invalid')).toBe('true');
  });

  it('previews the Markdown body as blocks without HTML', () => {
    const { caller } = http({});
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fill(/SKILL.md 正文/, '# Title\n\n- one\n- <b>two</b>\n\n```sh\nls\n```');
    fireEvent.click(screen.getByTestId('skill-body-preview'));
    const preview = screen.getByTestId('skill-markdown-preview');
    expect(preview.querySelector('h3')?.textContent).toBe('Title');
    expect(preview.querySelectorAll('li')).toHaveLength(2);
    expect(preview.querySelector('b')).toBeNull();
    expect(preview.textContent).toContain('<b>two</b>');
    expect(preview.querySelector('pre')?.textContent).toBe('ls');
    fireEvent.click(screen.getByTestId('skill-body-edit'));
    expect((screen.getByLabelText(/SKILL.md 正文/) as HTMLTextAreaElement).value).toContain(
      '# Title',
    );
  });

  it('keeps a trailing hyphen while typing, drops it on blur and before submit', async () => {
    const { caller, calls } = http({
      propose_skill: () => ({ id: 'sk-2', version: 1, status: 'draft', name: 'restart' }),
    });
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    const name = screen.getByLabelText(/^名称/) as HTMLInputElement;
    fill(/^名称/, 'Restart_');
    expect(name.value).toBe('restart-');
    expect(screen.getByText(/保存时将改为 restart/)).toBeTruthy();
    fireEvent.blur(name);
    expect(name.value).toBe('restart');
    fill(/^名称/, 'restart ');
    fill(/^描述/, 'd');
    fill(/SKILL.md 正文/, 'body');
    fireEvent.click(screen.getByTestId('skill-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls[0]?.params).toEqual({
      skill: { name: 'restart', description: 'd', markdown: 'body' },
    });
  });

  it('a name with no usable characters says what a valid name looks like', async () => {
    const { caller, calls } = http({});
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    // Simulate an IME commit: the composed Chinese text is only normalized on composition end.
    const name = screen.getByLabelText(/^名称/) as HTMLInputElement;
    fireEvent.compositionStart(name);
    fireEvent.change(name, { target: { value: '重启' } });
    fireEvent.compositionEnd(name);
    expect(name.value).toBe('');
    fill(/^描述/, 'd');
    fill(/SKILL.md 正文/, 'body');
    fireEvent.click(screen.getByTestId('skill-submit'));
    expect(await screen.findByText(/例如 restart-web（中文会被去掉/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('gate kinds are checkboxes over the four transport kinds; a copied unknown kind is kept', async () => {
    const { caller, calls } = http({
      get_skill: () => ({ markdown: 'body' }),
      propose_skill: () => ({ id: 'sk-3', version: 1, status: 'draft', name: 'x' }),
    });
    render(
      <SkillEditor
        http={caller}
        copyOf={{
          id: 'sk-1',
          version: 1,
          status: 'published',
          name: 'restart-web',
          description: 'Restart',
          applicable: { gateKinds: ['legacy-kind', 'mcp'] },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const group = screen.getByTestId('skill-gate-kinds');
    const labels = Array.from(group.querySelectorAll('label')).map((l) => l.textContent);
    expect(labels).toEqual(['HTTP', 'MCP', 'CLI', 'SSH', 'legacy-kind']);
    expect((screen.getByLabelText('MCP') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('legacy-kind') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('MCP'));
    fireEvent.click(screen.getByLabelText('CLI'));
    await waitFor(() =>
      expect((screen.getByLabelText(/SKILL.md 正文/) as HTMLTextAreaElement).value).toBe('body'),
    );
    fireEvent.click(screen.getByTestId('skill-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls.find((c) => c.name === 'propose_skill')?.params).toEqual({
      skill: {
        name: 'restart-web',
        description: 'Restart',
        markdown: 'body',
        applicable: { gateKinds: ['legacy-kind', 'cli'] },
      },
    });
  });

  it('object types are picked from list_types{kind:object}; a copied name outside the ontology is kept', async () => {
    const { caller, calls } = http({
      get_skill: () => ({ markdown: 'body' }),
      propose_skill: () => ({ id: 'sk-4', version: 1, status: 'draft', name: 'x' }),
    });
    render(
      <SkillEditor
        http={caller}
        copyOf={{
          id: 'sk-1',
          version: 1,
          status: 'published',
          name: 'restart-web',
          description: 'Restart',
          applicable: { objectTypes: ['Legacy', 'Host'] },
        }}
        onProposed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(caller.call).toHaveBeenCalledWith('list_types', { kind: 'object' });
    const unknown = await screen.findByTestId('skill-object-types-unknown');
    expect(unknown.textContent).toContain('Legacy');
    const chosen = screen.getByTestId('skill-object-types-chosen');
    expect(chosen.querySelector('.pick-chip-unknown')?.textContent).toContain('Legacy');
    // Already-chosen names are not offered again.
    fireEvent.click(screen.getByTestId('skill-object-types'));
    const offered = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((option) => option.querySelector('.combobox-option-label')?.textContent);
    expect(offered).toEqual(['Container']);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /Container/ }));
    fireEvent.click(screen.getByRole('button', { name: /^移除 Host$/ }));
    await waitFor(() =>
      expect((screen.getByLabelText(/SKILL.md 正文/) as HTMLTextAreaElement).value).toBe('body'),
    );
    fireEvent.click(screen.getByTestId('skill-submit'));
    await screen.findByTestId('draft-proposed');
    expect(calls.find((c) => c.name === 'propose_skill')?.params).toEqual({
      skill: {
        name: 'restart-web',
        description: 'Restart',
        markdown: 'body',
        applicable: { objectTypes: ['Legacy', 'Container'] },
      },
    });
  });

  it('a refused type list degrades to the typed comma list with a one-line note', async () => {
    const { caller } = http({
      list_types: () => {
        throw new HttpError('capability_error', 'nope', 'forbidden');
      },
    });
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    await screen.findByTestId('skill-object-types-refused');
    expect(screen.queryByTestId('skill-object-types-error')).toBeNull();
    fill(/适用的对象类型/, 'Container, Host');
    expect((screen.getByTestId('skill-object-types-input') as HTMLInputElement).value).toBe(
      'Container, Host',
    );
  });

  it('a failed type list shows the error with a retry and keeps typed entry meanwhile', async () => {
    let attempts = 0;
    const { caller } = http({
      list_types: () => {
        attempts += 1;
        if (attempts === 1) throw new HttpError('capability_error', 'boom', 'internal_error');
        return { items: OBJECT_TYPES };
      },
    });
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    const banner = await screen.findByTestId('skill-object-types-error');
    expect(screen.getByTestId('skill-object-types-input')).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: '重试' }));
    await waitFor(() =>
      expect(screen.getByTestId('skill-object-types').getAttribute('role')).toBe('combobox'),
    );
  });

  it('an ontology without object types says so and keeps typed entry', async () => {
    const { caller } = http({ list_types: () => ({ items: [] }) });
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    await screen.findByTestId('skill-object-types-empty');
    expect(screen.getByTestId('skill-object-types-input')).toBeTruthy();
  });
});
