// @vitest-environment jsdom
import type {
  OutcomeTallyWire,
  WorkerDefinitionStatsWire,
  WorkerDefinitionUsageWire,
  WorkerDefinitionVersionStatsWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { WorkerDefinitionUsageSection } from './WorkerDefinitionUsage.js';

afterEach(() => {
  cleanup();
});

const WORKER = '66666666-7777-4888-8999-000000000000';
const ENV_A = `v1:${'a'.repeat(64)}`;
const SPEC_A = 'c'.repeat(64);
const REF_A = 'c'.repeat(12);
/** Adjustments that ran only in goals the reader cannot see: no digest, the page's own number. */
const REF_B = '#1';

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

function usage(patch: Partial<WorkerDefinitionUsageWire> = {}): WorkerDefinitionUsageWire {
  return {
    runs: 0,
    tasks: { completed: 0, failed: 0, cancelled: 0, inProgress: 0 },
    lastUsedAt: null,
    ...patch,
  };
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
      { basis: 'reviewer_assessed', achieved: 0, notAchieved: 0 },
      { basis: 'agent_reported', achieved: proxy[0], notAchieved: proxy[1] },
    ],
  };
}

const RECENT = new Date(Date.now() - 5 * 60_000).toISOString();

function unusedVersion(
  version: number,
  status: 'published' | 'deprecated',
): WorkerDefinitionVersionStatsWire {
  return {
    version,
    status,
    usage: usage(),
    outcomes: tally([0, 0]),
    reviewSuggested: false,
    segments: [],
    combinations: [],
  };
}

function stats(patch: Partial<WorkerDefinitionStatsWire> = {}): WorkerDefinitionStatsWire {
  return {
    definitionId: WORKER,
    name: 'fixer',
    reviewStreak: 3,
    versions: [
      {
        version: 2,
        status: 'published',
        usage: usage({
          runs: 7,
          tasks: { completed: 4, failed: 2, cancelled: 0, inProgress: 1 },
          lastUsedAt: RECENT,
        }),
        outcomes: tally([3, 2], [1, 0]),
        reviewSuggested: true,
        segments: [
          {
            environmentDigest: ENV_A,
            usage: usage({ runs: 6, lastUsedAt: RECENT }),
            outcomes: tally([3, 2], [1, 0]),
            reviewSuggested: false,
          },
          {
            environmentDigest: null,
            usage: usage({ runs: 1, lastUsedAt: RECENT }),
            outcomes: tally([0, 0]),
            reviewSuggested: false,
          },
        ],
        combinations: [
          {
            specRef: REF_A,
            specDigest: SPEC_A,
            fields: ['instructions', 'skills'],
            usage: usage({ runs: 3, lastUsedAt: RECENT }),
            outcomes: tally([0, 3]),
            reviewSuggested: true,
          },
          {
            specRef: REF_B,
            specDigest: null,
            fields: null,
            usage: usage({ runs: 1, lastUsedAt: RECENT }),
            outcomes: tally([0, 0]),
            reviewSuggested: false,
          },
          {
            specRef: null,
            specDigest: null,
            fields: [],
            usage: usage({ runs: 3, lastUsedAt: RECENT }),
            outcomes: tally([3, 0]),
            reviewSuggested: false,
          },
        ],
      },
      unusedVersion(1, 'deprecated'),
    ],
    failureGroups: [
      {
        definitionVersion: 2,
        specRef: REF_A,
        specDigest: SPEC_A,
        category: 'limit_reached',
        refusal: 'output_rejected',
        tasks: 2,
        lastFailedAt: RECENT,
      },
      {
        definitionVersion: 2,
        specRef: null,
        specDigest: null,
        category: 'worker_error',
        refusal: 'denied',
        tasks: 1,
        lastFailedAt: RECENT,
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
      if (name === 'get_worker_definition_stats') return getStats();
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

function show(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <WorkerDefinitionUsageSection http={http} definitionId={WORKER} />
    </PermissionsProvider>,
  );
}

describe('WorkerDefinitionUsageSection (S11 GO16a)', () => {
  it('per version: runs, Task results, the attainment rate with its sample, proxy outcomes apart', async () => {
    const http = scriptedHttp('builder', () => stats());
    show(http);
    const v2 = await screen.findByTestId('worker-usage-version-2');
    expect(v2.textContent).toContain('7 次');
    expect(v2.textContent).toContain('完成 4 · 失败 2 · 取消 0 · 进行中 1');
    expect(within(v2).getAllByTestId('worker-usage-attainment')[0]?.textContent).toBe(
      '60%（3 / 5）',
    );
    expect(within(v2).getAllByTestId('worker-usage-proxy')[0]?.textContent).toContain(
      '不计入达成率',
    );
    // Joint attribution, and which Tasks are counted.
    const attribution = screen.getByTestId('worker-usage-attribution').textContent;
    expect(attribution).toContain('不是这个 Worker 让它达成');
    expect(attribution).toContain('评测和规划的不算');
    // A version no Task used has no block, only a line.
    expect(screen.queryByTestId('worker-usage-version-1')).toBeNull();
    expect(screen.getByTestId('worker-usage-unused').textContent).toBe('v1 还没有接过 Task。');
    expect(http.calls.filter((name) => name === 'get_worker_definition_stats')).toHaveLength(1);
  });

  it('by combination: as defined, or a step’s adjustments named by the fields they set and then a number, never by what they say; a note that the two lists are not added', async () => {
    show(scriptedHttp('builder', () => stats()));
    const combinations = await screen.findByTestId('worker-usage-version-2-combinations');
    fireEvent.click(within(combinations).getByText('按组合（3 种）'));
    expect(screen.getByTestId('worker-usage-version-2-combinations-note').textContent).toContain(
      '数字不要相加',
    );

    const a = screen.getByTestId(`worker-usage-version-2-combination-${REF_A}`);
    const aLabel = within(a).getByTestId(`worker-usage-version-2-combination-${REF_A}-label`);
    expect(aLabel.textContent).toBe(`调整了职责说明、Skill · 编号 ${REF_A}`);
    expect(aLabel.getAttribute('title')).toBe(
      '编号只用来区分不同的调整：编号相同就是同一份调整，不论来自哪个目标。',
    );
    // Its review comes from its own outcomes, and says so.
    const review = within(a).getByTestId(`worker-usage-version-2-combination-${REF_A}-review`);
    expect(review.getAttribute('title')).toBe('这个组合最近 3 个结果都未达成');

    // Ran only in goals the reader cannot see: the number is the page's own, and says so.
    const b = screen.getByTestId(`worker-usage-version-2-combination-${REF_B}-label`);
    expect(b.textContent).toBe('步骤调整（调整了什么读不到） · 编号 #1');
    expect(b.getAttribute('title')).toContain('编号只在这一页有效');
    expect(b.getAttribute('title')).toContain('平台不猜');
    expect(aLabel.getAttribute('title')).not.toContain('这一页');

    const asDefined = screen.getByTestId('worker-usage-version-2-combination-as-defined');
    expect(
      within(asDefined).getByTestId('worker-usage-version-2-combination-as-defined-label')
        .textContent,
    ).toBe('原样（没有步骤调整）');
    expect(
      within(asDefined).queryByTestId('worker-usage-version-2-combination-as-defined-review'),
    ).toBeNull();
    expect(within(asDefined).getByTestId('worker-usage-attainment').textContent).toBe(
      '100%（3 / 3）',
    );
  });

  it('「建议复核」 on the version points at the two lists; by run environment works as the Skill’s', async () => {
    show(scriptedHttp('builder', () => stats()));
    const review = await screen.findByTestId('worker-usage-version-2-review');
    expect(review.textContent).toBe('建议复核');
    expect(review.getAttribute('title')).toContain('某个运行环境或组合');

    const segments = screen.getByTestId('worker-usage-version-2-segments');
    fireEvent.click(within(segments).getByText('按运行环境（2 段）'));
    const known = screen.getByTestId(`worker-usage-version-2-segment-${ENV_A}`);
    expect(known.textContent).toContain('v1:aaaaaaaaaaaa');
    expect(
      within(known).queryByTestId(`worker-usage-version-2-segment-${ENV_A}-review`),
    ).toBeNull();
    expect(screen.getByTestId('worker-usage-version-2-segment-unknown').textContent).toContain(
      '环境未知',
    );
  });

  it('failed Tasks grouped by version, combination, category and what refused them', async () => {
    show(scriptedHttp('owner', () => stats()));
    const groups = await screen.findAllByTestId('worker-usage-failure-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toMatch(
      new RegExp(`v2 · 步骤调整（编号 ${REF_A}） · 2 个 Task`),
    );
    expect(groups[0]?.textContent).toContain('超出时长或 token 预算');
    expect(groups[1]?.textContent).toMatch(/v2 · 原样 · 1 个 Task/);
    expect(groups[1]?.textContent).toContain('有操作被策略拒绝');
  });

  it('says so when no version has taken a Task', async () => {
    show(
      scriptedHttp('builder', () =>
        stats({ versions: [unusedVersion(1, 'published')], failureGroups: [] }),
      ),
    );
    expect((await screen.findByTestId('worker-usage-empty')).textContent).toContain(
      '还没有接过 Task（评测和规划的 Task 不算）',
    );
    expect(screen.queryByTestId('worker-usage-failures')).toBeNull();
  });

  it('a version whose Tasks have not run yet still has its block', async () => {
    show(
      scriptedHttp('builder', () =>
        stats({
          versions: [
            {
              ...unusedVersion(1, 'published'),
              usage: usage({ tasks: { completed: 0, failed: 0, cancelled: 0, inProgress: 1 } }),
              combinations: [
                {
                  specRef: null,
                  specDigest: null,
                  fields: [],
                  usage: usage({ tasks: { completed: 0, failed: 0, cancelled: 0, inProgress: 1 } }),
                  outcomes: tally([0, 0]),
                  reviewSuggested: false,
                },
              ],
            },
          ],
          failureGroups: [],
        }),
      ),
    );
    const v1 = await screen.findByTestId('worker-usage-version-1');
    expect(v1.textContent).toContain('进行中 1');
    expect(screen.queryByTestId('worker-usage-version-1-segments')).toBeNull();
    expect(screen.queryByTestId('worker-usage-empty')).toBeNull();
  });

  it('a member sees no section and asks for nothing', async () => {
    const http = scriptedHttp('member', () => stats());
    show(http);
    await waitFor(() => expect(http.calls).toContain('get_workspace'));
    expect(screen.queryByTestId('worker-usage')).toBeNull();
    expect(http.calls).not.toContain('get_worker_definition_stats');
  });

  it('a read error says so with a retry; a refusal shows nothing', async () => {
    let fail: unknown = new HttpError('capability_error', 'boom', 'internal');
    const http = scriptedHttp('builder', () => {
      throw fail;
    });
    const view = show(http);
    expect(await screen.findByTestId('worker-usage-error')).toBeTruthy();
    view.unmount();

    fail = new HttpError('capability_error', 'no', 'forbidden');
    const refusing = scriptedHttp('builder', () => {
      throw fail;
    });
    show(refusing);
    await waitFor(() => expect(refusing.calls).toContain('get_worker_definition_stats'));
    await waitFor(() => expect(screen.queryByTestId('worker-usage')).toBeNull());
    expect(screen.queryByTestId('worker-usage-error')).toBeNull();
  });
});
