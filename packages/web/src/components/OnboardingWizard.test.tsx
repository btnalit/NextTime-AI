// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import type { GraphObjectRow } from '../lib/connections.js';
import { HttpError } from '../lib/http-client.js';
import { OnboardingWizard } from './OnboardingWizard.js';
import { governanceFields } from './connect/governance-fixtures.test-helpers.js';

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

const IMPORTED_DRAFTS = ['accept_s2_mcp_echo', 'accept_s2_mcp_note'].map((name) => ({
  gatekeeperId: 'gk-1',
  name,
  mode: 'observe',
  blastRadius: 'low',
  status: 'draft',
  origin: 'import',
  draftDigest: `digest-${name}`,
}));

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
      // Step ③ reads the imported drafts it lists (and publishes, review #493 on #592).
      if (name === 'list_operations' && !handlers[name]) return { items: IMPORTED_DRAFTS };
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
  await within(publishStep).findByTestId('wizard-publish-drafts');
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
  it('step ③ counts only the drafts the manifest publishes, and says which proposals are skipped and why (review #501 on #592)', async () => {
    const http = scriptedHttp({
      ...CONNECTION_HANDLERS,
      list_operations: () => ({
        items: [
          ...IMPORTED_DRAFTS,
          { ...IMPORTED_DRAFTS[0], name: 'accept_s2_mcp_\u202Eproposed', origin: 'agent' },
          {
            ...IMPORTED_DRAFTS[0],
            name: 'accept_s2_mcp_\u200Bowned',
            gateOwnedParams: [{ path: 'tenant', reason: 'gate_sets' }],
          },
          // S11 「门确认不存在」 B-a: declares answers that mean "not there" — a person publishes it.
          {
            ...IMPORTED_DRAFTS[0],
            name: 'accept_s2_mcp_lookup',
            absentAnswers: { statuses: [404] },
          },
        ],
      }),
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
    await within(publishStep).findByTestId('wizard-publish-drafts');
    expect(within(publishStep).getByTestId('wizard-publish-count').textContent).toMatch(
      /会发布这\s*2\s*个草稿/,
    );
    const proposals = within(publishStep).getByTestId('wizard-publish-proposals');
    expect(proposals.textContent).toMatch(/1\s*个提议草稿会被跳过/);
    // Legacy 318: names a reader cannot fully see are shown as \\u{XXXX}, as everywhere else.
    expect(proposals.textContent).toContain('accept_s2_mcp_\\u{202E}proposed');
    expect(within(publishStep).getByTestId('wizard-publish-drafts').textContent).not.toMatch(
      /[\u202E\u200B]/,
    );
    expect(proposals.textContent).toMatch(/逐个审阅/);
    expect(within(publishStep).getByTestId('wizard-publish-gate-owned').textContent).toContain(
      'accept_s2_mcp_\\u{200B}owned',
    );
    const absent = within(publishStep).getByTestId('wizard-publish-absent');
    expect(absent.textContent).toContain('另有 1 个草稿暂不发布');
    expect(absent.textContent).toContain('accept_s2_mcp_lookup');
    expect(absent.textContent).toContain('确认门用的凭据看得到要查的东西');
  });

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
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          drafts: [
            { name: 'accept_s2_mcp_echo', draftDigest: 'digest-accept_s2_mcp_echo' },
            { name: 'accept_s2_mcp_note', draftDigest: 'digest-accept_s2_mcp_note' },
          ],
        });
        return { publishedOperationNames: ['accept_s2_mcp_echo', 'accept_s2_mcp_note'] };
      },
      search: () => [operationObject()],
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={onFinished} />);

    // Step ① kind
    fireEvent.click(screen.getByRole('radio', { name: 'MCP' }));
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
    await within(publishStep).findByTestId('wizard-publish-drafts');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));

    // Step ④ review
    const reviewTable = await screen.findByTestId('wizard-review-table');
    expect(reviewTable.textContent).toContain('accept_s2_mcp_echo');
    expect(screen.getByTestId('wizard-publish-result-published').textContent).toContain(
      '已发布 2 个',
    );
    expect(screen.queryByTestId('wizard-publish-result-held')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));

    // Step ⑤ done
    const doneStep = await screen.findByTestId('wizard-step-done');
    fireEvent.click(within(doneStep).getByRole('button', { name: /查看门详情/ }));
    expect(onFinished).toHaveBeenCalledWith('gk-1');

    expect(http.calls.some((c) => c.name === 'create_connection')).toBe(true);
    expect(http.calls.some((c) => c.name === 'publish_manifest')).toBe(true);
  });

  it('publishes only the drafts it listed; a draft changed since is refused and the list is read again (review #493 on #592)', async () => {
    let reads = 0;
    let publishes = 0;
    const http = scriptedHttp({
      ...CONNECTION_HANDLERS,
      list_operations: () => {
        reads += 1;
        // The gate re-imports after the first read: a third draft appears.
        const items =
          reads === 1
            ? IMPORTED_DRAFTS
            : [...IMPORTED_DRAFTS, { ...IMPORTED_DRAFTS[0], name: 'accept_s2_mcp_third' }];
        return { items };
      },
      publish_manifest: (params) => {
        publishes += 1;
        if (publishes === 1) {
          return Promise.reject(
            new HttpError('capability_error', 'changed after it was read', 'draft_changed'),
          );
        }
        expect((params as { drafts: { name: string }[] }).drafts.map((d) => d.name)).toContain(
          'accept_s2_mcp_third',
        );
        return { publishedOperationNames: ['accept_s2_mcp_echo'] };
      },
      search: () => [operationObject()],
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
    const listed = await within(publishStep).findByTestId('wizard-publish-drafts');
    expect(listed.textContent).toContain('2 个草稿');
    expect(listed.textContent).toContain('accept_s2_mcp_note');

    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));
    await waitFor(() =>
      expect(within(publishStep).getByTestId('wizard-publish-drafts').textContent).toContain(
        'accept_s2_mcp_third',
      ),
    );
    expect(within(publishStep).getByText(/这份草稿在你查看之后被修改过/)).toBeTruthy();
    expect(screen.queryByTestId('wizard-review-table')).toBeNull();

    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));
    await screen.findByTestId('wizard-review-table');
    expect(publishes).toBe(2);
  });

  it('console G4: the publish step says which drafts it held back for a gate-owned param, and that this self-connected system is re-synced from the fixed manifest (legacy 214)', async () => {
    const http = scriptedHttp({
      create_connection: () => ({
        gatekeeperId: 'gk-1',
        importedOperationNames: ['accept_s2_mcp_echo', 'accept_s2_mcp_note'],
        connectionRequestId: null,
      }),
      publish_manifest: () => ({
        gatekeeperId: 'gk-1',
        publishedOperationNames: ['accept_s2_mcp_echo'],
        gateOwnedParamDrafts: [
          { name: 'accept_s2_mcp_note', params: [{ param: 'Authorization', location: 'header' }] },
        ],
      }),
      search: () => [operationObject()],
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'MCP' }));
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
    await within(publishStep).findByTestId('wizard-publish-drafts');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));

    const held = await screen.findByTestId('wizard-publish-result-held');
    expect(screen.getByTestId('wizard-publish-result-published').textContent).toContain(
      '已发布 1 个',
    );
    expect(held.textContent).toContain('accept_s2_mcp_note：Authorization（请求头）');
    expect(held.textContent).toContain('重新读取门的清单');
    expect(held.textContent).not.toContain('重新接入');
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
            before: governanceFields({ mode: 'observe', blastRadius: 'low', autoApprovable: true }),
            after: governanceFields({
              mode: 'execute',
              blastRadius: 'medium',
              autoApprovable: true,
            }),
            direction: 'tightened',
          },
          draftDigest: 'sha256:proposed',
        };
      },
      publish_operation: (params) => {
        // Review #493 on #583: published only if it is still the draft this Submit proposed.
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          name: 'accept_s2_mcp_echo',
          draftDigest: 'sha256:proposed',
        });
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
    await within(publishStep).findByTestId('wizard-publish-drafts');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));

    await screen.findByTestId('wizard-review-table');
    fireEvent.click(screen.getByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.change(within(form).getByLabelText('模式'), { target: { value: 'execute' } });
    fireEvent.change(within(form).getByLabelText('影响范围'), {
      target: { value: 'medium' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    // Proposed, not yet published: the confirm shows the change first.
    const confirm = await screen.findByTestId('wizard-review-reclassify-confirm');
    expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(false);
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('accept_s2_mcp_echo');
    // Legacy 400: the change is shown once, as the old → new list, without the name again.
    expect(within(confirm).queryByTestId('confirm-impact')).toBeNull();
    expect(confirm.textContent?.split('accept_s2_mcp_echo')).toHaveLength(2);
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
    expect(http.calls.find((c) => c.name === 'publish_operation')?.params).toMatchObject({
      draftDigest: 'sha256:proposed',
    });
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
          before: governanceFields({ mode: 'execute', blastRadius: 'high', autoApprovable: false }),
          after: governanceFields({ mode: 'observe', blastRadius: 'high', autoApprovable: false }),
          direction: 'loosened',
        },
      }),
    });
    render(<OnboardingWizard http={http} onCancel={vi.fn()} onFinished={vi.fn()} />);
    await walkToReview();

    fireEvent.click(screen.getByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.change(within(form).getByLabelText('模式'), { target: { value: 'observe' } });
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    const confirm = await screen.findByTestId('wizard-review-reclassify-confirm');
    expect(within(confirm).getByTestId('confirm-button').className).toContain('text-danger');
    const warning = within(confirm).getByTestId('wizard-review-reclassify-loosens');
    expect(warning.textContent).toContain('不再需要授权');
    expect(within(confirm).getByTestId('governance-diff-list-item').dataset.direction).toBe(
      'loosened',
    );
    // Legacy 404: the change first, then what loosening it means.
    expect(
      within(confirm).getByTestId('governance-diff-list').compareDocumentPosition(warning) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

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
          before: governanceFields({ mode: 'observe', blastRadius: 'low', autoApprovable: true }),
          after: governanceFields({ mode: 'observe', blastRadius: 'low', autoApprovable: true }),
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
    await within(publishStep).findByTestId('wizard-publish-drafts');
    fireEvent.click(within(publishStep).getByRole('button', { name: /发布清单/ }));

    await screen.findByTestId('wizard-review-table');
    fireEvent.click(screen.getByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    const banner = await screen.findByRole('alert');
    expect(banner.getAttribute('data-error-code')).toBe('conflict');
  });
});
