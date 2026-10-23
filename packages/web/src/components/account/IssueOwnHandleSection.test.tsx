// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionHint } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { entryCeilingCapabilities } from '../../lib/entry-ceiling.js';
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
    // Every capability the Handle can carry has console copy: its name and what it does, in zh.
    for (const capability of ceiling) {
      const hint = actionHint(capability.name, (zh) => zh);
      expect(hint, capability.name).not.toBeNull();
      expect(list.textContent).toContain(hint ?? '');
    }
    expect(list.querySelector('[title]')).toBeNull();
  });
});
