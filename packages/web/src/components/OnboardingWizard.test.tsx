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
      // R-01: the connect step's form mints the gate's connection secret when it opens.
      if (name === 'mint_connection_secret' && !handlers[name]) {
        return { connectionSecret: `ntgc1_${'a'.repeat(32)}_${'b'.repeat(64)}` };
      }
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

/** Steps ① – ③ with the scripted connection, ending on the review table. */
async function walkToReview(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
  const connectStep = await screen.findByTestId('wizard-step-connect');
  await within(connectStep).findByTestId('cc-connection-secret-reveal');
  fireEvent.change(within(connectStep).getByLabelText(/目标系统/), {
    target: { value: 'accept_s2_mcp' },
  });
  fireEvent.change(within(connectStep).getByLabelText(/门端点/), {
    target: { value: 'http://accept-s2-mcp:8080' },
  });
  fireEvent.click(within(connectStep).getByRole('button', { name: '注册门' }));
  const publishStep = await screen.findByTestId('wizard-step-publish');
  fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));
  await screen.findByTestId('wizard-review-table');
}

const CONNECTION_HANDLERS = {
  create_connection: () => ({
    gatekeeperId: 'gk-1',
    importedOperationNames: ['accept_s2_mcp_echo'],
    connectionRequestId: null,
  }),
  publish_manifest: () => ({ publishedOperationNames: ['accept_s2_mcp_echo'] }),
};

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
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));

    // Step ② connect (CompleteConnectionForm, kind hidden and pre-set to mcp)
    const connectStep = await screen.findByTestId('wizard-step-connect');
    await within(connectStep).findByTestId('cc-connection-secret-reveal');
    expect(within(connectStep).queryByLabelText(/^Kind/)).toBeNull();
    fireEvent.change(within(connectStep).getByLabelText(/目标系统/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(within(connectStep).getByLabelText(/门端点/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(within(connectStep).getByRole('button', { name: '注册门' }));

    // Step ③ publish
    const publishStep = await screen.findByTestId('wizard-step-publish');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));

    // Step ④ review
    const reviewTable = await screen.findByTestId('wizard-review-table');
    expect(reviewTable.textContent).toContain('accept_s2_mcp_echo');
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));

    // Step ⑤ done
    const doneStep = await screen.findByTestId('wizard-step-done');
    fireEvent.click(within(doneStep).getByRole('button', { name: /查看门详情/ }));
    expect(onFinished).toHaveBeenCalledWith('gk-1');

    expect(http.calls.some((c) => c.name === 'create_connection')).toBe(true);
    expect(http.calls.some((c) => c.name === 'publish_manifest')).toBe(true);
  });

  it('review step: "propose reclassification" proposes, shows old → new behind a confirm, and publishes only on confirm (R-19, D-17)', async () => {
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
        return {
          gatekeeperId: 'gk-1',
          name: 'accept_s2_mcp_echo',
          version: 2,
          status: 'draft',
          draftOf: 'obj-echo',
          governanceChange: {
            before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
            after: { mode: 'execute', blastRadius: 'medium', autoApprovable: true },
            direction: 'tightened',
          },
        };
      },
      publish_operation: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1', name: 'accept_s2_mcp_echo' });
        return { gatekeeperId: 'gk-1', name: 'accept_s2_mcp_echo', status: 'published' };
      },
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    const connectStep = await screen.findByTestId('wizard-step-connect');
    await within(connectStep).findByTestId('cc-connection-secret-reveal');
    fireEvent.change(within(connectStep).getByLabelText(/目标系统/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(within(connectStep).getByLabelText(/门端点/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(within(connectStep).getByRole('button', { name: '注册门' }));
    const publishStep = await screen.findByTestId('wizard-step-publish');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));

    await screen.findByTestId('wizard-review-table');
    fireEvent.click(screen.getByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.change(within(form).getByLabelText('Mode'), { target: { value: 'execute' } });
    fireEvent.change(within(form).getByLabelText('Blast radius'), {
      target: { value: 'medium' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    // Proposed, not yet published: the confirm shows the change first.
    const confirm = await screen.findByTestId('wizard-review-reclassify-confirm');
    expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(false);
    expect(confirm.textContent).toContain('accept_s2_mcp_echo: 模式');
    expect(within(confirm).getByTestId('governance-diff-list-item').dataset.direction).toBe(
      'tightened',
    );
    // A tightening: no loosening warning, no danger styling.
    expect(within(confirm).queryByTestId('wizard-review-reclassify-loosens')).toBeNull();
    expect(within(confirm).getByTestId('confirm-button').className).not.toContain('text-danger');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(true));
    const names = http.calls.map((c) => c.name);
    expect(names.indexOf('propose_operation')).toBeLessThan(names.indexOf('publish_operation'));
  });

  it('review step: a loosening reclassification is danger-styled with what it means; cancelling keeps the draft unpublished', async () => {
    const http = scriptedHttp({
      ...CONNECTION_HANDLERS,
      search: () => [
        operationObject({ mode: 'execute', blast_radius: 'high', auto_approvable: false }),
      ],
      propose_operation: () => ({
        gatekeeperId: 'gk-1',
        name: 'accept_s2_mcp_echo',
        version: 2,
        status: 'draft',
        draftOf: 'obj-echo',
        governanceChange: {
          before: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
          after: { mode: 'observe', blastRadius: 'high', autoApprovable: false },
          direction: 'loosened',
        },
      }),
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={vi.fn()} />);
    await walkToReview();

    fireEvent.click(screen.getByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.change(within(form).getByLabelText('Mode'), { target: { value: 'observe' } });
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    const confirm = await screen.findByTestId('wizard-review-reclassify-confirm');
    expect(within(confirm).getByTestId('confirm-button').className).toContain('text-danger');
    const warning = within(confirm).getByTestId('wizard-review-reclassify-loosens');
    expect(warning.textContent).toContain('不再需要授权');
    expect(within(confirm).getByTestId('governance-diff-list-item').dataset.direction).toBe(
      'loosened',
    );

    fireEvent.click(within(confirm).getByTestId('confirm-cancel'));
    await screen.findByTestId('wizard-review-draft-kept');
    expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(false);
  });

  it('review step: a proposal with no classification change publishes without a confirm', async () => {
    const http = scriptedHttp({
      ...CONNECTION_HANDLERS,
      search: () => [operationObject()],
      propose_operation: () => ({
        gatekeeperId: 'gk-1',
        name: 'accept_s2_mcp_echo',
        version: 2,
        status: 'draft',
        draftOf: 'obj-echo',
        governanceChange: {
          before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
          after: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
          direction: 'neutral',
        },
      }),
      publish_operation: () => ({
        gatekeeperId: 'gk-1',
        name: 'accept_s2_mcp_echo',
        status: 'published',
      }),
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={vi.fn()} />);
    await walkToReview();

    fireEvent.click(screen.getByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(true));
    expect(screen.queryByTestId('wizard-review-reclassify-confirm')).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    const connectStep = await screen.findByTestId('wizard-step-connect');
    await within(connectStep).findByTestId('cc-connection-secret-reveal');
    fireEvent.change(within(connectStep).getByLabelText(/目标系统/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(within(connectStep).getByLabelText(/门端点/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(within(connectStep).getByRole('button', { name: '注册门' }));
    const publishStep = await screen.findByTestId('wizard-step-publish');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));

    await screen.findByTestId('wizard-review-table');
    fireEvent.click(screen.getByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    const banner = await screen.findByRole('alert');
    expect(banner.getAttribute('data-error-code')).toBe('conflict');
  });
});
