// @vitest-environment jsdom
import type { OutcomeTallyWire, SkillStatsWire, SkillUsageWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { SkillUsageSection } from './SkillUsage.js';

afterEach(() => {
  cleanup();
});

const SKILL = '11111111-2222-4333-8444-555555555555';
const WORKER = '66666666-7777-4888-8999-000000000000';
const ENV_A = `v1:${'a'.repeat(64)}`;

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

function usage(patch: Partial<SkillUsageWire> = {}): SkillUsageWire {
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

function stats(patch: Partial<SkillStatsWire> = {}): SkillStatsWire {
  return {
    skillId: SKILL,
    name: 'restart-web',
    reviewStreak: 3,
    versions: [
      {
        version: 3,
        status: 'draft',
        usage: usage(),
        outcomes: tally([0, 0]),
        reviewSuggested: false,
        segments: [],
      },
      {
        version: 2,
        status: 'published',
        usage: usage({
          runs: 8,
          tasks: { completed: 1, failed: 4, cancelled: 1, inProgress: 1 },
          lastUsedAt: RECENT,
        }),
        outcomes: tally([1, 2], [0, 1]),
        reviewSuggested: true,
        segments: [
          {
            environmentDigest: null,
            usage: usage({ runs: 1, lastUsedAt: RECENT }),
            outcomes: tally([0, 0]),
            reviewSuggested: false,
          },
          {
            environmentDigest: ENV_A,
            usage: usage({ runs: 7, lastUsedAt: RECENT }),
            outcomes: tally([1, 3]),
            reviewSuggested: true,
          },
        ],
      },
      {
        version: 1,
        status: 'deprecated',
        usage: usage({ runs: 2, tasks: { ...usage().tasks, completed: 1 }, lastUsedAt: RECENT }),
        outcomes: tally([1, 0], [1, 0]),
        reviewSuggested: false,
        segments: [
          {
            environmentDigest: ENV_A,
            usage: usage({ runs: 2, lastUsedAt: RECENT }),
            outcomes: tally([1, 0], [1, 0]),
            reviewSuggested: false,
          },
        ],
      },
    ],
    failureGroups: [
      {
        skillVersion: 2,
        workerDefinition: { id: WORKER, version: 1, name: 'fixer' },
        category: 'limit_reached',
        refusal: 'none',
        tasks: 2,
        lastFailedAt: RECENT,
      },
      {
        skillVersion: 2,
        workerDefinition: { id: WORKER, version: 1, name: null },
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
      if (name === 'get_skill_stats') return getStats();
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

function show(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <SkillUsageSection http={http} skillId={SKILL} />
    </PermissionsProvider>,
  );
}

describe('SkillUsageSection (S11 W1a E2-1)', () => {
  it('per version: runs, Task results, the attainment rate with its sample, proxy outcomes apart', async () => {
    const http = scriptedHttp('builder', () => stats());
    show(http);
    const v2 = await screen.findByTestId('skill-usage-version-2');
    expect(v2.textContent).toContain('8 次');
    expect(v2.textContent).toContain('完成 1 · 失败 4 · 取消 1 · 进行中 1');
    expect(within(v2).getAllByTestId('skill-usage-attainment')[0]?.textContent).toBe(
      '33%（1 / 3）',
    );
    // The agent's report is shown apart, never in the rate.
    expect(within(v2).getAllByTestId('skill-usage-proxy')[0]?.textContent).toContain(
      '达成 0 · 未达成 1',
    );
    expect(within(v2).getAllByTestId('skill-usage-proxy')[0]?.textContent).toContain(
      '不计入达成率',
    );
    // The joint-attribution wording (coordinator decision, fork 4).
    expect(screen.getByTestId('skill-usage-attribution').textContent).toContain(
      '所在的对话轮、目标步骤或目标被判达成，不是这个 Skill 让它达成',
    );
    // A version no run loaded gets no block; a draft (never mounted) is not listed as unused.
    expect(screen.queryByTestId('skill-usage-version-3')).toBeNull();
    expect(screen.queryByTestId('skill-usage-never-loaded')).toBeNull();
    expect(screen.getByTestId('skill-usage-version-1')).toBeTruthy();
  });

  it('published versions no run loaded share one line, listed the Chinese way', async () => {
    const unused = (version: number, status: 'published' | 'deprecated') => ({
      version,
      status,
      usage: usage(),
      outcomes: tally([0, 0]),
      reviewSuggested: false,
      segments: [],
    });
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
    expect((await screen.findByTestId('skill-usage-never-loaded')).textContent).toBe(
      'v4、v1 还没有被运行加载过。',
    );
  });

  it('「建议复核」 shows on the version and on the environment it comes from; unknown is its own segment', async () => {
    show(scriptedHttp('builder', () => stats()));
    const v2 = await screen.findByTestId('skill-usage-version-2');
    expect(screen.getByTestId('skill-usage-version-2-review').textContent).toBe('建议复核');
    expect(screen.queryByTestId('skill-usage-version-1-review')).toBeNull();

    const segments = screen.getByTestId('skill-usage-version-2-segments');
    fireEvent.click(within(segments).getByText(/按运行环境/));
    const known = within(v2).getByTestId(`skill-usage-version-2-segment-${ENV_A}`);
    expect(known.textContent).toContain('v1:aaaaaaaaaaaa');
    expect(known.textContent).not.toContain('a'.repeat(13));
    expect(within(known).getByTestId(`skill-usage-version-2-segment-${ENV_A}-review`)).toBeTruthy();
    const unknown = within(v2).getByTestId('skill-usage-version-2-segment-unknown');
    expect(unknown.textContent).toContain('环境未知');
    expect(
      within(unknown).queryByTestId('skill-usage-version-2-segment-unknown-review'),
    ).toBeNull();
    expect(unknown.textContent).toContain('还没有结果');
  });

  it('failed Tasks grouped by version, Worker definition, category and what refused them', async () => {
    show(scriptedHttp('owner', () => stats()));
    const groups = await screen.findAllByTestId('skill-usage-failure-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toMatch(/v2 · Worker fixer v1 · 2 个 Task/);
    expect(groups[0]?.textContent).toContain('超出时长或 token 预算');
    expect(groups[0]?.textContent).toContain('没有被拒绝的操作');
    expect(groups[1]?.textContent).toContain('未命名的定义');
    expect(groups[1]?.textContent).toContain('有操作被策略拒绝');
  });

  it('says so when no run has loaded any version, and when nothing failed', async () => {
    show(
      scriptedHttp('builder', () =>
        stats({
          versions: [
            {
              version: 1,
              status: 'published',
              usage: usage(),
              outcomes: tally([0, 0]),
              reviewSuggested: false,
              segments: [],
            },
          ],
          failureGroups: [],
        }),
      ),
    );
    expect((await screen.findByTestId('skill-usage-empty')).textContent).toContain(
      '还没有运行加载过',
    );
    expect(screen.queryByTestId('skill-usage-failures')).toBeNull();
  });

  it('a member sees no section and asks for nothing', async () => {
    const http = scriptedHttp('member', () => stats());
    show(http);
    await waitFor(() => expect(http.calls).toContain('get_workspace'));
    expect(screen.queryByTestId('skill-usage')).toBeNull();
    expect(http.calls).not.toContain('get_skill_stats');
  });

  it('a read error says so with a retry; a refusal shows nothing', async () => {
    let fail: unknown = new HttpError('capability_error', 'boom', 'internal');
    const http = scriptedHttp('builder', () => {
      throw fail;
    });
    const view = show(http);
    expect(await screen.findByTestId('skill-usage-error')).toBeTruthy();
    view.unmount();

    fail = new HttpError('capability_error', 'no', 'forbidden');
    const refusing = scriptedHttp('builder', () => {
      throw fail;
    });
    show(refusing);
    await waitFor(() => expect(refusing.calls).toContain('get_skill_stats'));
    await waitFor(() => expect(screen.queryByTestId('skill-usage')).toBeNull());
    expect(screen.queryByTestId('skill-usage-error')).toBeNull();
  });
});
