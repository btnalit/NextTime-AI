// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionHint } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { entryCeilingCapabilities } from '../../lib/entry-ceiling.js';
import { HttpError } from '../../lib/http-client.js';
import { IssueOwnHandleSection } from './IssueOwnHandleSection.js';

afterEach(cleanup);

describe('IssueOwnHandleSection', () => {
  it('legacy 168 ②⑤: the TTL is a preset (1 day by default) and the intro says it is for clients outside the platform', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'list_gatekeepers') return { items: [], nextCursor: null };
      if (name === 'issue_handle') {
        return {
          handle: 'h_own',
          principalId: 'p-1',
          sessionId: 's-1',
          expiresAt: '2026-09-10T00:00:00.000Z',
          scope: [],
        };
      }
      throw new Error(`unscripted ${name}`);
    });
    render(<IssueOwnHandleSection http={{ call } as unknown as CapabilityCaller} />);
    expect(screen.getByTestId('issue-own-handle-section').textContent).toContain(
      '只供平台外的客户端使用',
    );
    // Legacy 147: what is granted later needs a new Handle.
    expect(screen.getByTestId('ioh-reissue-note').textContent).toContain('重新签发一个');
    const ttl = screen.getByLabelText(/有效期/) as HTMLSelectElement;
    expect(Array.from(ttl.options).map((option) => option.value)).toEqual(['1', '7', '30']);
    expect(ttl.value).toBe('1');
    fireEvent.change(ttl, { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('ioh-submit'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('issue_handle', {
        sessionKind: 'interactive',
        ttlSeconds: 7 * 86400,
      }),
    );
  });

  it('legacy 902: sends the note trimmed, shows the session’s short id and note once issued, and says a credential-looking note on its field', async () => {
    let refuse = true;
    const call = vi.fn(async (name: string) => {
      if (name === 'list_gatekeepers') return { items: [], nextCursor: null };
      if (name === 'issue_handle') {
        if (refuse) {
          refuse = false;
          throw new HttpError(
            'capability_error',
            'the text looks like it carries a credential',
            'credentials_in_text',
          );
        }
        return {
          handle: 'h_own',
          sessionId: '0f3a9c21-7b4e-4d6a-9e10-5c2b8a7d6e4f',
          sessionShortId: '0f3a9c21',
          sessionNote: 'laptop',
          onBehalfOf: 'p-1',
          expiresAt: '2026-09-10T00:00:00.000Z',
          scope: { capabilities: [], resources: {} },
        };
      }
      throw new Error(`unscripted ${name}`);
    });
    render(<IssueOwnHandleSection http={{ call } as unknown as CapabilityCaller} />);
    const note = screen.getByLabelText(/备注（可选）/) as HTMLInputElement;
    expect(note.maxLength).toBe(200);
    fireEvent.change(note, { target: { value: 'token=abc' } });
    fireEvent.click(screen.getByTestId('ioh-submit'));
    await waitFor(() => expect(note.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById('ioh-note-error')?.textContent).toContain('看起来带了凭证');
    // The refusal is on this field, so focus returns to it.
    expect(document.activeElement).toBe(note);
    fireEvent.change(note, { target: { value: '  laptop  ' } });
    fireEvent.click(screen.getByTestId('ioh-submit'));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith('issue_handle', {
        sessionKind: 'interactive',
        ttlSeconds: 86400,
        note: 'laptop',
      }),
    );
    const session = await screen.findByTestId('issue-own-handle-session');
    expect(session.textContent).toContain('0f3a9c21');
    expect(session.textContent).toContain('，备注：');
    expect(session.textContent).toContain('laptop');
  });

  it('legacy 439 / 440: says what the unrestricted scope holds, and lists each capability by its console name and description', () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'list_gatekeepers') return { items: [], nextCursor: null };
      throw new Error(`unscripted ${name}`);
    });
    render(<IssueOwnHandleSection http={{ call } as unknown as CapabilityCaller} />);
    const ceiling = entryCeilingCapabilities();
    const unrestricted = screen.getByLabelText(/^不限（入口智能体能用的全部/) as HTMLInputElement;
    expect(unrestricted.parentElement?.textContent).toContain(`全部 ${ceiling.length} 项能力`);
    expect(unrestricted.parentElement?.textContent).not.toContain('观察类');
    fireEvent.click(unrestricted);
    const list = screen.getByTestId('ioh-capability-list');
    // Grouped by the kinds the unrestricted option names, reads first (#718 UX P3).
    const groups = Array.from(list.querySelectorAll('fieldset legend')).map((l) => l.textContent);
    expect(groups).toHaveLength(4);
    expect(groups[0]).toBe('查询');
    expect(groups[3]).toBe('汇报与记录');
    expect(screen.getByTestId('ioh-capability-group-delegate').textContent).toContain(
      'invoke_worker',
    );
    expect(screen.getByTestId('ioh-capability-group-propose').textContent).toContain(
      'propose_goal',
    );
    // Every capability the Handle can carry has console copy: its name and what it does, in zh.
    for (const capability of ceiling) {
      const hint = actionHint(capability.name, (zh) => zh);
      expect(hint, capability.name).not.toBeNull();
      expect(list.textContent).toContain(hint ?? '');
    }
    expect(list.querySelector('[title]')).toBeNull();
  });
});
