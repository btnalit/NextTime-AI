// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import type { GraphObjectRow } from '../lib/connections.js';
import { HttpError } from '../lib/http-client.js';
import { OnboardingWizard } from './OnboardingWizard.js';

afterEach(cleanup);

function operationObject(overrides: Partial<GraphObjectRow['properties']> = {}): GraphObjectRow {
  return {
    id: 'obj-echo',
    objectType: 'Operation',
    identityKey: { gatekeeperId: 'gk-1', name: 'accept_s2_mcp_echo' },
    properties: {
      name: 'accept_s2_mcp_echo',
      binding: { kind: 'mcp', tool_name: 'accept_s2_mcp_echo' },
      params_schema: { type: 'object', properties: { text: { type: 'string' } } },
      mode: 'observe',
      blast_radius: 'low',
      reversibility: false,
      auto_approvable: true,
      await_decision: false,
      reads: [],
      writes: [],
      status: 'published',
      origin: 'import',
      ...overrides,
    },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

describe('OnboardingWizard', () => {
  it('walks kind → connect → publish → review → done, calling create_connection/publish_manifest', async () => {
    const onFinished = vi.fn();
    const http = scriptedHttp({
      create_connection: (params) => {
        expect((params as { kind: string }).kind).toBe('mcp');
        return {
          gatekeeperId: 'gk-1',
          importedOperationNames: ['accept_s2_mcp_echo', 'accept_s2_mcp_note'],
          connectionRequestId: null,
        };
      },
      publish_manifest: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1' });
        return { publishedOperationNames: ['accept_s2_mcp_echo', 'accept_s2_mcp_note'] };
      },
      search: () => [operationObject()],
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={onFinished} />);

    // Step ① kind
    fireEvent.click(screen.getByRole('radio', { name: 'mcp' }));
    fireEvent.click(screen.getByRole('button', { name: /下一步 Next/ }));

    // Step ② connect (CompleteConnectionForm, kind hidden and pre-set to mcp)
    const connectStep = await screen.findByTestId('wizard-step-connect');
    expect(within(connectStep).queryByLabelText(/^Kind/)).toBeNull();
    fireEvent.change(within(connectStep).getByLabelText(/Target system/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(within(connectStep).getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(within(connectStep).getByRole('button', { name: 'Register Gatekeeper' }));

    // Step ③ publish
    const publishStep = await screen.findByTestId('wizard-step-publish');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单 Publish manifest/ }));

    // Step ④ review
    const reviewTable = await screen.findByTestId('wizard-review-table');
    expect(reviewTable.textContent).toContain('accept_s2_mcp_echo');
    fireEvent.click(screen.getByRole('button', { name: /下一步 Next/ }));

    // Step ⑤ done
    const doneStep = await screen.findByTestId('wizard-step-done');
    fireEvent.click(within(doneStep).getByRole('button', { name: /查看门详情 View gate detail/ }));
    expect(onFinished).toHaveBeenCalledWith('gk-1');

    expect(http.calls.some((c) => c.name === 'create_connection')).toBe(true);
    expect(http.calls.some((c) => c.name === 'publish_manifest')).toBe(true);
  });

  it('review step: "propose reclassification" calls propose_operation then publish_operation with the overridden fields', async () => {
    const http = scriptedHttp({
      create_connection: () => ({
        gatekeeperId: 'gk-1',
        importedOperationNames: ['accept_s2_mcp_echo'],
        connectionRequestId: null,
      }),
      publish_manifest: () => ({ publishedOperationNames: ['accept_s2_mcp_echo'] }),
      search: () => [operationObject()],
      propose_operation: (params) => {
        const p = params as { gatekeeperId: string; operation: Record<string, unknown> };
        expect(p.gatekeeperId).toBe('gk-1');
        expect(p.operation.name).toBe('accept_s2_mcp_echo');
        expect(p.operation.blast_radius).toBe('medium');
        expect(p.operation.mode).toBe('execute');
        // Untouched fields pass through verbatim.
        expect(p.operation.binding).toEqual({ kind: 'mcp', tool_name: 'accept_s2_mcp_echo' });
        return { gatekeeperId: 'gk-1', name: 'accept_s2_mcp_echo', status: 'draft' };
      },
      publish_operation: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1', name: 'accept_s2_mcp_echo' });
        return { gatekeeperId: 'gk-1', name: 'accept_s2_mcp_echo', status: 'published' };
      },
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /下一步 Next/ }));
    const connectStep = await screen.findByTestId('wizard-step-connect');
    fireEvent.change(within(connectStep).getByLabelText(/Target system/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(within(connectStep).getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(within(connectStep).getByRole('button', { name: 'Register Gatekeeper' }));
    const publishStep = await screen.findByTestId('wizard-step-publish');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单 Publish manifest/ }));

    await screen.findByTestId('wizard-review-table');
    fireEvent.click(screen.getByRole('button', { name: /提议重分类 Propose reclassification/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.change(within(form).getByLabelText('Mode'), { target: { value: 'execute' } });
    fireEvent.change(within(form).getByLabelText('Blast radius'), {
      target: { value: 'medium' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /提交 Submit/ }));

    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(true));
    const names = http.calls.map((c) => c.name);
    expect(names.indexOf('propose_operation')).toBeLessThan(names.indexOf('publish_operation'));
  });

  it('review step: a 409 conflict on an imported operation surfaces via ErrorBanner, not a crash', async () => {
    const http = scriptedHttp({
      create_connection: () => ({
        gatekeeperId: 'gk-1',
        importedOperationNames: ['accept_s2_mcp_echo'],
        connectionRequestId: null,
      }),
      publish_manifest: () => ({ publishedOperationNames: ['accept_s2_mcp_echo'] }),
      search: () => [operationObject()],
      propose_operation: () =>
        Promise.reject(
          new HttpError(
            'capability_error',
            'Operation "accept_s2_mcp_echo" on gatekeeper gk-1 already exists (status: published)',
            'conflict',
          ),
        ),
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /下一步 Next/ }));
    const connectStep = await screen.findByTestId('wizard-step-connect');
    fireEvent.change(within(connectStep).getByLabelText(/Target system/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(within(connectStep).getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(within(connectStep).getByRole('button', { name: 'Register Gatekeeper' }));
    const publishStep = await screen.findByTestId('wizard-step-publish');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单 Publish manifest/ }));

    await screen.findByTestId('wizard-review-table');
    fireEvent.click(screen.getByRole('button', { name: /提议重分类 Propose reclassification/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.click(within(form).getByRole('button', { name: /提交 Submit/ }));

    const banner = await screen.findByRole('alert');
    expect(banner.getAttribute('data-error-code')).toBe('conflict');
  });
});
