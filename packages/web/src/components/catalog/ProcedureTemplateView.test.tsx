// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ProcedureTemplateView } from './ProcedureTemplateView.js';

afterEach(cleanup);

const GATE = '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10';

function http(): CapabilityCaller {
  return {
    call: vi.fn(async (name: string) => {
      if (name === 'list_gatekeepers') return { items: [{ id: GATE, name: 'cert-gate' }] };
      if (name === 'resolve_refs') return { items: [] };
      throw new Error(`unscripted ${name}`);
    }) as CapabilityCaller['call'],
  };
}

const worker = { kind: 'worker', definitionId: 'wd-1', version: 2 };

describe('ProcedureTemplateView (S11 GO5d-2)', () => {
  it('reads each step as the goal plan made from it does: its place, what it waits for, where its inputs come from, who checks it', async () => {
    render(
      <ProcedureTemplateView
        http={http()}
        status="published"
        steps={[
          {
            ...worker,
            key: 'fetch',
            input: { mode: 'safe' },
            bindings: [{ to: 'target.site', from: '$params', path: 'site' }],
            outputSchema: { type: 'object', properties: { hosts: { type: 'array' } } },
            maxAttempts: 2,
          },
          { kind: 'verify', description: 'Every host answers.' },
          {
            ...worker,
            description: 'apply the certificates',
            bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }],
          },
          { ...worker, key: 'notify', dependsOn: [] },
          {
            kind: 'verify',
            description: 'The certificate is valid.',
            check: {
              kind: 'observe_predicate',
              key: 'valid',
              check: {
                gatekeeperId: GATE,
                operation: 'cert.status',
                expect: { path: 'state', op: 'eq', value: 'valid' },
              },
            },
          },
        ]}
        parameters={{
          type: 'object',
          // jsonb's own key order: the required field is listed first all the same.
          properties: {
            threshold: { type: 'integer' },
            site: { type: 'string', description: 'which site' },
          },
          required: ['site'],
        }}
      />,
    );
    expect(screen.getByTestId('procedure-template-summary').textContent).toMatch(
      /可以用这个流程生成目标/,
    );
    const steps = screen.getAllByTestId('procedure-template-step');
    expect(steps).toHaveLength(5);
    const [fetch, confirm, apply, notify, check] = steps as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(within(fetch).getByTestId('procedure-template-step-key').textContent).toMatch(
      /^计划里的步骤名 fetch$/,
    );
    expect(within(fetch).getByTestId('procedure-template-step-lines').textContent).toContain(
      '最先开始',
    );
    expect(within(fetch).getByTestId('procedure-template-binding').textContent).toMatch(
      /^输入 target\.site 来自启动参数的 site$/,
    );
    expect(fetch.textContent).toContain('最多尝试 2 次');
    expect(within(fetch).getByTestId('procedure-template-output-contract')).toBeTruthy();
    expect(within(confirm).getByTestId('procedure-template-confirm').textContent).toMatch(
      /由请求人确认/,
    );
    // No key of its own: step-<its place>; waits for the Worker step before it.
    expect(within(apply).getByTestId('procedure-template-step-key').textContent).toMatch(
      /^计划里的步骤名 step-3$/,
    );
    expect(apply.textContent).toContain('等上一个 Worker 步骤 fetch 完成后开始');
    expect(within(apply).getByTestId('procedure-template-binding').textContent).toMatch(
      /^输入 hosts 来自步骤 fetch 输出的 hosts$/,
    );
    expect(notify.textContent).toContain('不等其他步骤，一开始就运行');
    await waitFor(() =>
      expect(within(check).getByTestId('procedure-template-check').textContent).toMatch(
        /在目标里由平台检查：在门「cert-gate」上观察 cert\.status/,
      ),
    );
    const parameters = screen.getByTestId('procedure-template-parameters');
    const fields = within(parameters).getAllByTestId('output-contract-field');
    expect(fields.map((field) => field.textContent)).toEqual([
      expect.stringMatching(/^site.*文本.*必填.*which site$/),
      expect.stringMatching(/^threshold/),
    ]);
    expect(screen.queryByTestId('procedure-template-issues')).toBeNull();
    expect(screen.queryByTestId('procedure-template-binding-issue')).toBeNull();
    expect(screen.getByTestId('procedure-detail-steps').textContent).toContain('"$params"');
  });

  it('a Procedure with an approval or Operation step, or no Worker step, says it makes no goal plan', () => {
    const { unmount } = render(
      <ProcedureTemplateView
        http={http()}
        status="published"
        steps={[
          { ...worker, bindings: [{ to: 'site', from: '$params', path: 'site' }] },
          { kind: 'approval', description: 'The owner agrees.' },
        ]}
        parameters={null}
      />,
    );
    expect(screen.getByTestId('procedure-template-manual').textContent).toMatch(/只能照着手动执行/);
    expect(screen.queryByTestId('procedure-template-parameters')).toBeNull();
    // UX acceptance of #722 (P3-3): it makes no plan, so no step has a place in one.
    expect(screen.queryByTestId('procedure-template-step-key')).toBeNull();
    expect(screen.queryByTestId('procedure-template-step-lines')).toBeNull();
    expect(screen.queryByTestId('procedure-template-binding-issue')).toBeNull();
    unmount();
    render(
      <ProcedureTemplateView
        http={http()}
        status="published"
        steps={[{ kind: 'verify', description: 'ok' }]}
        parameters={null}
      />,
    );
    expect(screen.getByTestId('procedure-template-manual').textContent).toMatch(/没有 Worker 步骤/);
  });

  it('a draft is a template once published, and a binding the page can tell is wrong is marked where it is read', () => {
    render(
      <ProcedureTemplateView
        http={http()}
        status="draft"
        steps={[
          {
            ...worker,
            key: 'scan',
            outputSchema: { type: 'object' },
            bindings: [
              { to: 'site', from: '$params', path: 'site' },
              { to: 'zone', from: '$params', path: 'zone' },
            ],
          },
          { ...worker, bindings: [{ to: 'skus', from: 'missing', path: 'skus' }] },
        ]}
        parameters={{
          type: 'object',
          properties: { site: { type: 'string' } },
          additionalProperties: false,
        }}
      />,
    );
    expect(screen.getByTestId('procedure-template-summary').textContent).toMatch(/^发布后可以/);
    expect(screen.getByTestId('procedure-template-issues').textContent).toMatch(/发布时会被拒/);
    expect(
      screen.getAllByTestId('procedure-template-binding-issue').map((line) => line.textContent),
    ).toEqual([
      expect.stringMatching(/启动参数里没有声明 zone/),
      expect.stringMatching(/没有叫 missing 的 Worker 步骤/),
    ]);
  });

  it('a step it cannot read is shown as it is', () => {
    render(
      <ProcedureTemplateView
        http={http()}
        status="published"
        steps={[{ kind: 'mystery', x: 1 }]}
        parameters={null}
      />,
    );
    expect(screen.getByTestId('procedure-template-step').textContent).toContain('"mystery"');
  });
});
