// @vitest-environment jsdom
import type { SkillPublishRecordWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { SkillPublishRecord } from './SkillPublishRecord.js';

afterEach(cleanup);

const EVALUATION_ID = '0b9d6c1e-4a2f-4c3e-9d1a-7f00a1b2c3d4';
const OBSERVATION_ID = '5e6f7a8b-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const CASE_A = 'c0ffee00-0000-4000-8000-00000000000a';
const CASE_B = 'c0ffee00-0000-4000-8000-00000000000b';

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown>,
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

const workspace = {
  id: 'ws-1',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00Z',
  principalCount: 1,
  gatekeeperCount: 0,
  caller: { id: 'p-me', role: 'member', displayName: 'Me', kind: 'human' },
};

function renderRecord(http: CapabilityCaller, record: SkillPublishRecordWire | null) {
  return render(
    <PermissionsProvider>
      <SkillPublishRecord http={http} record={record} />
    </PermissionsProvider>,
  );
}

describe('SkillPublishRecord (legacy 539)', () => {
  it('names the evaluation reviewed, its verdict and why, and its Observation', () => {
    const http = scriptedHttp({ get_workspace: () => workspace });
    renderRecord(http, {
      evaluation: {
        id: EVALUATION_ID,
        verdict: 'non_inferior',
        reason: 'within_margin',
        observationId: OBSERVATION_ID,
      },
      acknowledgedFailures: 0,
      acknowledgements: [],
    });
    const section = screen.getByTestId('skill-publish-record-evaluation');
    expect(section.getAttribute('data-verdict')).toBe('non_inferior');
    expect(within(section).getByTestId('skill-publish-record-verdict')).toBeTruthy();
    expect(within(section).getByTestId('skill-publish-record-reason').textContent).not.toBe('');
    expect(within(section).getByTestId('skill-publish-record-link').getAttribute('href')).toContain(
      EVALUATION_ID,
    );
    expect(within(section).getByTestId('skill-publish-record-observation').textContent).toContain(
      OBSERVATION_ID.slice(0, 8),
    );
    expect(screen.queryByTestId('skill-publish-record-acknowledged')).toBeNull();
    // Nothing acknowledged: no evaluation is read for case titles.
    expect(http.calls.some((call) => call.name === 'get_draft_evaluation')).toBe(false);
  });

  it('a cancelled evaluation says it has no verdict', () => {
    renderRecord(scriptedHttp({ get_workspace: () => workspace }), {
      evaluation: { id: EVALUATION_ID, verdict: null, reason: null, observationId: null },
      acknowledgedFailures: 0,
      acknowledgements: [],
    });
    const section = screen.getByTestId('skill-publish-record-evaluation');
    expect(section.getAttribute('data-verdict')).toBe('');
    expect(within(section).queryByTestId('skill-publish-record-verdict')).toBeNull();
    expect(within(section).getByTestId('skill-publish-record-cancelled').textContent).toBe(
      '已取消，没有结论。',
    );
  });

  it('a content published unevaluated says so', () => {
    renderRecord(scriptedHttp({ get_workspace: () => workspace }), {
      evaluation: null,
      acknowledgedFailures: 0,
      acknowledgements: [],
    });
    expect(screen.getByTestId('skill-publish-record-unevaluated').textContent).toBe(
      '发布时这份内容没有评测过。',
    );
  });

  it('a publish with no recorded evidence says so', () => {
    renderRecord(scriptedHttp({ get_workspace: () => workspace }), null);
    expect(screen.getByTestId('skill-publish-record-none').textContent).toContain(
      '没有记下评测证据',
    );
    expect(screen.queryByTestId('skill-publish-record-evaluation')).toBeNull();
  });

  it('acknowledged failures: the count, each case by its title once read, and the reason as written', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace,
      get_draft_evaluation: () => ({
        stages: [
          {
            cases: [
              { caseId: CASE_A, title: '重启后服务恢复' },
              { caseId: CASE_B, title: '日志轮转' },
            ],
          },
        ],
      }),
    });
    renderRecord(http, {
      evaluation: {
        id: EVALUATION_ID,
        verdict: 'regressed',
        reason: 'regression_case_lost',
        observationId: null,
      },
      acknowledgedFailures: 2,
      acknowledgements: [
        { evaluationId: EVALUATION_ID, caseId: CASE_A, reason: '这个用例的环境已下线\n不再适用' },
        { evaluationId: EVALUATION_ID, caseId: CASE_B, reason: '<b>不</b>影响' },
      ],
    });
    expect(screen.queryByTestId('skill-publish-record-observation')).toBeNull();
    const notice = screen.getByTestId('skill-publish-record-acknowledged');
    expect(notice.textContent).toContain('确认了 2 条失败后发布');
    const rows = within(notice).getAllByTestId('skill-publish-record-acknowledgement');
    expect(rows.map((row) => row.getAttribute('data-case-id'))).toEqual([CASE_A, CASE_B]);
    // Until the evaluation is read, a case is its short id.
    expect(rows[0]?.textContent).toContain(CASE_A.slice(0, 8));
    await waitFor(() => expect(rows[0]?.textContent).toContain('用例「重启后服务恢复」'));
    expect(rows[0]?.textContent).toContain('这个用例的环境已下线\n不再适用');
    // Free text is shown as text, never as markup.
    expect(rows[1]?.textContent).toContain('<b>不</b>影响');
    expect(rows[1]?.querySelector('b')).toBeNull();
    expect(http.calls.filter((call) => call.name === 'get_draft_evaluation')).toEqual([
      { name: 'get_draft_evaluation', params: { evaluationId: EVALUATION_ID } },
    ]);
  });
});
