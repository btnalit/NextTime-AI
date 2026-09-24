// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { SkillEditor } from './SkillEditor.js';

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

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
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
    fill(/适用的门类型/, 'http, ssh');
    fill(/适用的对象类型/, 'Container');
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

  it('blocks submission with field errors from the schema and warns about the pi name rule', async () => {
    const { caller, calls } = http({});
    render(<SkillEditor http={caller} onProposed={vi.fn()} onDone={vi.fn()} />);
    fill(/^名称/, 'Restart Web');
    expect(screen.getByText(/pi Skill 命名规则/)).toBeTruthy();
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
});
