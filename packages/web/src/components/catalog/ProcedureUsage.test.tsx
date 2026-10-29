// @vitest-environment jsdom
import type {
  OutcomeTallyWire,
  ProcedureStatsWire,
  ProcedureUsageWire,
  ProcedureVersionStatsWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { ProcedureUsageSection } from './ProcedureUsage.js';

afterEach(() => {
  cleanup();
});

const PROCEDURE = '11111111-2222-4333-8444-555555555555';
const ENV_A = `v1:${'a'.repeat(64)}`;
const ENV_B = `v1:${'b'.repeat(64)}`;

function workspaceAs(role: string) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 1,
    gatekeeperCount: 0,
    caller: { id: 'p-1', role, displayName: 'Reader', kind: 'human' },
  };
}

const RECENT = new Date(Date.now() - 5 * 60_000).toISOString();

function usage(patch: Partial<ProcedureUsageWire['byStatus']> = {}): ProcedureUsageWire {
  const byStatus = { proposed: 0, inProgress: 0, completed: 0, cancelled: 0, failed: 0, ...patch };
  const goals = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  return { goals, byStatus, lastUsedAt: goals > 0 ? RECENT : null };
}

function tally(
  primary: readonly [number, number],
  proxy: readonly [number, number] = [0, 0],
): OutcomeTallyWire {
  const tier = ([achieved, notAchieved]: readonly [number, number]) => ({
    achieved,
    notAchieved,
    total: achieved + notAchieved,
    attainment: achieved + notAchieved > 0 ? achieved / (achieved + notAchieved) : null,
  });
  return {
    primary: tier(primary),
    proxy: tier(proxy),
    byBasis: [
      { basis: 'verified_by_check', achieved: 0, notAchieved: 0 },
      { basis: 'requester', achieved: primary[0], notAchieved: primary[1] },
      { basis: 'reviewer_assessed', achieved: proxy[0], notAchieved: proxy[1] },
      { basis: 'agent_reported', achieved: 0, notAchieved: 0 },
    ],
  };
}

const NO_CLAIMS = { turns: 0, achieved: 0, notAchieved: 0, lastClaimedAt: null };

function unused(version: number, status: 'draft' | 'published' | 'deprecated') {
  return {
    version,
    status,
    usage: usage(),
    outcomes: tally([0, 0]),
    claims: NO_CLAIMS,
    reviewSuggested: false,
    segments: [],
  } satisfies ProcedureVersionStatsWire;
}

function stats(patch: Partial<ProcedureStatsWire> = {}): ProcedureStatsWire {
  return {
    procedureId: PROCEDURE,
    name: 'restart-verify',
    reviewStreak: 3,
    versions: [
      unused(3, 'draft'),
      {
        version: 2,
        status: 'published',
        usage: usage({ proposed: 1, inProgress: 1, completed: 4, cancelled: 1 }),
        outcomes: tally([1, 3], [1, 0]),
        claims: { turns: 3, achieved: 1, notAchieved: 1, lastClaimedAt: RECENT },
        reviewSuggested: true,
        segments: [
          {
            environmentDigests: null,
            usage: usage({ completed: 1 }),
            outcomes: tally([1, 0]),
            reviewSuggested: false,
          },
          {
            environmentDigests: [ENV_A],
            usage: usage({ completed: 3 }),
            outcomes: tally([0, 3]),
            reviewSuggested: true,
          },
          {
            environmentDigests: [ENV_A, ENV_B],
            usage: usage({ cancelled: 1 }),
            outcomes: tally([0, 0], [1, 0]),
            reviewSuggested: false,
          },
        ],
      },
      unused(1, 'deprecated'),
    ],
    failureGroups: [
      {
        procedureVersion: 2,
        place: 'procedure_step',
        stepKey: 'scan',
        category: 'outcome_unknown',
        goals: 2,
        lastEndedAt: RECENT,
      },
      {
        procedureVersion: 2,
        place: 'revised_step',
        stepKey: null,
        category: 'action_refused',
        goals: 1,
        lastEndedAt: RECENT,
      },
      {
        procedureVersion: 2,
        place: 'requester',
        stepKey: null,
        category: null,
        goals: 1,
        lastEndedAt: RECENT,
      },
    ],
    ...patch,
  };
}

function scriptedHttp(
  role: string,
  getStats: () => unknown,
): CapabilityCaller & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call: vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'get_workspace') return workspaceAs(role);
      if (name === 'get_procedure_stats') return getStats();
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

function show(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <ProcedureUsageSection http={http} procedureId={PROCEDURE} />
    </PermissionsProvider>,
  );
}

describe('ProcedureUsageSection (S11 W1a E2-2)', () => {
  it('per version: goals by status, the attainment rate with its sample, proxy outcomes and claimed turns apart', async () => {
    show(scriptedHttp('builder', () => stats()));
    const v2 = await screen.findByTestId('procedure-usage-version-2');
    expect(v2.textContent).toContain('7 个');
    expect(v2.textContent).toContain('待确认 1 · 进行中 1 · 已结束 4 · 已取消 1');
    expect(within(v2).getAllByTestId('procedure-usage-attainment')[0]?.textContent).toBe(
      '25%（1 / 4）',
    );
    const proxy = within(v2).getAllByTestId('procedure-usage-proxy')[0];
    expect(proxy?.textContent).toContain('达成 1 · 未达成 0');
    expect(proxy?.textContent).toContain('不计入达成率');
    const claims = within(v2).getByTestId('procedure-usage-claims');
    expect(claims.textContent).toContain('请求人判达成 1 · 未达成 1');
    expect(claims.textContent).toContain('agent 自报');
    expect(screen.getByTestId('procedure-usage-attribution').textContent).toContain(
      '记的是目标被判达成，不是这个流程让它达成',
    );
    // Versions never used get no block; the draft is not listed as unused.
    expect(screen.queryByTestId('procedure-usage-version-3')).toBeNull();
    expect(screen.queryByTestId('procedure-usage-version-1')).toBeNull();
    expect(screen.getByTestId('procedure-usage-unused').textContent).toBe('v1 还没有被用过。');
  });

  it('「建议复核」 says why in words, on the version and on the set of environments it comes from; each fingerprint is listed', async () => {
    show(scriptedHttp('builder', () => stats()));
    const v2 = await screen.findByTestId('procedure-usage-version-2');
    expect(screen.getByTestId('procedure-usage-version-2-review').textContent).toContain(
      '某一组运行环境里最近 3 个结果都未达成',
    );

    fireEvent.click(within(v2).getByText(/按运行环境/));
    const onlyA = within(v2).getByTestId(`procedure-usage-version-2-segment-${ENV_A}`);
    expect(onlyA.textContent).toContain('1 个运行环境');
    expect(onlyA.textContent).toContain('v1:aaaaaaaaaaaa');
    expect(within(onlyA).getByLabelText(ENV_A)).toBeTruthy();
    expect(
      within(onlyA).getByTestId(`procedure-usage-version-2-segment-${ENV_A}-review`).textContent,
    ).toContain('这组运行环境里最近 3 个结果都未达成');
    const both = within(v2).getByTestId(`procedure-usage-version-2-segment-${ENV_A}+${ENV_B}`);
    expect(both.textContent).toContain('2 个运行环境');
    const unknown = within(v2).getByTestId('procedure-usage-version-2-segment-unknown');
    expect(unknown.textContent).toContain('环境未知');
    expect(unknown.textContent).toContain('models.json');
  });

  it('goals not achieved grouped by where they went wrong and the step’s failure category', async () => {
    show(scriptedHttp('owner', () => stats()));
    const groups = await screen.findAllByTestId('procedure-usage-failure-group');
    expect(groups).toHaveLength(3);
    expect(groups[0]?.textContent).toMatch(/v2 · 步骤 scan · 2 个目标/);
    expect(groups[0]?.textContent).toContain('结果不明');
    expect(groups[1]?.textContent).toContain('修订计划后加入的步骤');
    expect(groups[1]?.textContent).toContain('动作被拒');
    expect(groups[2]?.textContent).toContain('请求人结束或取消，没有失败的步骤');
  });

  it('published versions not used share one line, listed the Chinese way', async () => {
    const base = stats();
    show(
      scriptedHttp('builder', () =>
        stats({
          versions: [
            unused(4, 'published'),
            ...base.versions.filter((version) => version.version === 2),
            unused(1, 'deprecated'),
          ],
        }),
      ),
    );
    expect((await screen.findByTestId('procedure-usage-unused')).textContent).toBe(
      'v4、v1 还没有被用过。',
    );
  });

  it('says so when no version was used, and when no goal ended unachieved', async () => {
    show(
      scriptedHttp('builder', () =>
        stats({ versions: [unused(1, 'published')], failureGroups: [] }),
      ),
    );
    expect((await screen.findByTestId('procedure-usage-empty')).textContent).toContain(
      '还没有用这个流程生成过目标',
    );
    expect(screen.queryByTestId('procedure-usage-failures')).toBeNull();
  });

  it('a version only an agent said it followed still gets a block', async () => {
    show(
      scriptedHttp('builder', () =>
        stats({
          versions: [
            {
              ...unused(1, 'published'),
              claims: { turns: 2, achieved: 0, notAchieved: 0, lastClaimedAt: RECENT },
            },
          ],
          failureGroups: [],
        }),
      ),
    );
    const v1 = await screen.findByTestId('procedure-usage-version-1');
    expect(v1.textContent).toContain('没有');
    expect(within(v1).getByTestId('procedure-usage-claims').textContent).toContain('2 轮对话');
    expect(screen.getByTestId('procedure-usage-failures').textContent).toContain(
      '没有未达成的目标',
    );
  });

  it('a member sees no section and asks for nothing', async () => {
    const http = scriptedHttp('member', () => stats());
    show(http);
    await waitFor(() => expect(http.calls).toContain('get_workspace'));
    expect(screen.queryByTestId('procedure-usage')).toBeNull();
    expect(http.calls).not.toContain('get_procedure_stats');
  });

  it('a read error says so with a retry; a refusal shows nothing', async () => {
    let fail: unknown = new HttpError('capability_error', 'boom', 'internal');
    const http = scriptedHttp('builder', () => {
      throw fail;
    });
    const view = show(http);
    expect(await screen.findByTestId('procedure-usage-error')).toBeTruthy();
    view.unmount();

    fail = new HttpError('capability_error', 'no', 'forbidden');
    const refusing = scriptedHttp('builder', () => {
      throw fail;
    });
    show(refusing);
    await waitFor(() => expect(refusing.calls).toContain('get_procedure_stats'));
    await waitFor(() => expect(screen.queryByTestId('procedure-usage')).toBeNull());
    expect(screen.queryByTestId('procedure-usage-error')).toBeNull();
  });
});
