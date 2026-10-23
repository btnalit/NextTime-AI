// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import type { TaskSummary } from '../lib/tasks.js';
import { TaskDetail } from './TaskDetail.js';

afterEach(cleanup);

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task-1',
    status: 'running',
    onBehalfOf: 'p-1',
    workerDefinitionId: 'wd-1',
    workerDefinitionVersion: 2,
    input: { need: 'restart web' },
    result: null,
    tokenBudget: 1000,
    tokensUsed: 900,
    durationLimitSec: 60,
    failureReason: null,
    createdAt: '2026-09-03T00:00:00.000Z',
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    workerRuns: [
      {
        id: 'run-1',
        status: 'running',
        containerId: null,
        depth: 0,
        attempt: 1,
        startedAt: '2026-09-03T00:00:00.000Z',
        terminatedAt: null,
      },
    ],
    ...overrides,
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller {
  return {
    call: vi.fn(async (name: string, params?: unknown) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function renderDetail(
  overrides: Partial<TaskSummary> = {},
  http: CapabilityCaller = scriptedHttp({ list_action_requests: () => ({ items: [] }) }),
  onCancel = vi.fn(async () => undefined),
) {
  const onOpenApproval = vi.fn();
  render(
    <PermissionsProvider>
      <TaskDetail
        task={task(overrides)}
        definitionName="Restarter"
        http={http}
        pushes={SILENT_PUSH_SOURCE}
        principalNames={new Map([['p-1', 'Alice']])}
        onOpenApproval={onOpenApproval}
        onCancel={onCancel}
        canCancel
      />
    </PermissionsProvider>,
  );
  return { onCancel, onOpenApproval };
}

/** TaskDetail.test.tsx (C22, console-completion-plan §2b; S6-A B3 / B4 / C28 / §5.5). */
describe('TaskDetail', () => {
  it('renders the definition and on-behalf-of as named chips, the budget bar, and the provenance links', () => {
    renderDetail();
    const definition = screen.getByTestId('task-definition');
    expect(definition.textContent).toContain('Restarter v2');
    expect(definition.getAttribute('data-ref-id')).toBe('wd-1');
    expect(screen.getByTestId('task-on-behalf-of').textContent).toContain('Alice');
    expect(document.querySelector('.quota-bar-warn')).toBeTruthy();
    expect(screen.getByTestId('task-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?resourceType=task&resourceId=task-1',
    );
    expect(screen.getByTestId('worker-run-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?resourceType=worker_run&resourceId=run-1',
    );
    expect(screen.getByText('restart web')).toBeTruthy();
  });

  it('offers Cancel only while the transition table allows it; Cancel opens a confirm anchored to itself (S8 W1-A7), which calls onCancel with the task', async () => {
    const { onCancel } = renderDetail();
    fireEvent.click(screen.getByTestId('task-cancel'));
    const confirm = await screen.findByTestId('task-cancel-confirm');
    expect(onCancel).not.toHaveBeenCalled();
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('Restarter');
    // S8 W4 i18n baseline fix: the impact lines now go through `t()` (default zh-CN here), no
    // more always-glued zh/en text. Split into three assertions (rather than one literal
    // CJK-immediately-followed-by-Latin string) so this reads as a rendered-content check, not
    // UI copy the i18n guard would otherwise flag.
    const impactText = within(confirm).getByTestId('confirm-impact').textContent;
    expect(impactText).toContain('运行中的');
    expect(impactText).toContain('WorkerRun');
    expect(impactText).toContain('1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' })),
    );
    cleanup();
    renderDetail({ status: 'completed', completedAt: '2026-09-03T00:02:00.000Z' });
    expect(screen.queryByTestId('task-cancel')).toBeNull();
    expect(screen.getByText(/结束/)).toBeTruthy();
  });

  it('renders the S2.9 result contract summary and counts, raw JSON otherwise', () => {
    renderDetail({
      status: 'completed',
      result: {
        summary: 'Restarted web-1.',
        findings: ['it was slow'],
        factsToAssert: [{ a: 1 }],
        evidence: [],
        artifacts: [],
      },
    });
    expect(screen.getByText('Restarted web-1.')).toBeTruthy();
    expect(screen.getByText('it was slow')).toBeTruthy();
    expect(screen.getByText(/1 条事实/)).toBeTruthy();
    cleanup();
    renderDetail({ status: 'completed', result: { raw: true } });
    expect(document.querySelector('.code-block')?.textContent).toContain('"raw": true');
  });

  it('legacy 420: says what [redacted] stands for in a result the kernel read out masked', () => {
    renderDetail({
      status: 'completed',
      result: {
        summary: 'Restarted web-1 with PGPASSWORD=[redacted].',
        findings: [],
        factsToAssert: [],
        evidence: [],
        artifacts: [],
      },
    });
    expect(screen.getByTestId('task-result-redacted').textContent).toContain(
      '[redacted] 处的内容看起来像密码',
    );
    cleanup();
    renderDetail({
      status: 'completed',
      result: {
        summary: 'Restarted web-1.',
        findings: [],
        factsToAssert: [],
        evidence: [],
        artifacts: [],
      },
    });
    expect(screen.queryByTestId('task-result-redacted')).toBeNull();
  });

  it('renders artifacts: inlined content when present, an explicit "not retrievable" message otherwise (S8 W5-A, leftover 74)', () => {
    renderDetail({
      status: 'completed',
      result: {
        summary: 'ok',
        findings: [],
        factsToAssert: [],
        evidence: [],
        artifacts: [
          { path: '/workspace/report.md', description: 'inventory', content: '# Report\nok' },
          { path: '/workspace/legacy.txt' },
        ],
      },
    });
    const rows = screen.getAllByTestId('task-artifact-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('/workspace/report.md');
    expect(rows[0]?.textContent).toContain('inventory');
    expect(rows[0]?.textContent).toContain('# Report');
    expect(rows[1]?.textContent).toContain('/workspace/legacy.txt');
    expect(rows[1]?.textContent).toMatch(/not retrievable|无法再读取/);
  });

  it('lists linked approvals from list_action_requests{taskId}, opening one via onOpenApproval; shows the failure reason', async () => {
    const http = scriptedHttp({
      list_action_requests: (params) => {
        expect(params).toEqual({ taskId: 'task-1', limit: 20 });
        return {
          items: [
            {
              id: 'ar-1',
              status: 'rejected',
              gatekeeperId: 'gk-1',
              actionKindTag: 'docker.container_restart',
              resourceScope: 'web-1',
              blastRadius: 'high',
              awaitDecision: true,
              params: {},
              requestedAt: '2026-09-03T00:00:00.000Z',
              decidedBy: 'p-1',
              decisionReason: 'not now',
            },
          ],
        };
      },
    });
    const { onOpenApproval } = renderDetail({ failureReason: 'spawn_lost' }, http);
    const row = await screen.findByTestId('linked-approval-row');
    expect(row.textContent).toContain('docker container restart');
    expect(row.textContent).toContain('not now');
    expect(within(row).getByText('Alice')).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenApproval).toHaveBeenCalledWith('ar-1');
    // Legacy 324: the reason reads as a label and a sentence, never the raw code.
    const reason = screen.getByTestId('task-detail-failure-reason');
    expect(reason.textContent).toContain('排队后没有启动');
    expect(reason.textContent).toContain('不会自动重试');
    expect(reason.textContent).not.toContain('spawn_lost');
  });

  it('a thrown onCancel keeps the confirm open with its own inline error (data-error-code)', async () => {
    const onCancel = vi.fn(async () => {
      throw new HttpError('capability_error', 'already finished', 'illegal_transition');
    });
    renderDetail({}, scriptedHttp({ list_action_requests: () => ({ items: [] }) }), onCancel);
    fireEvent.click(screen.getByTestId('task-cancel'));
    const confirm = await screen.findByTestId('task-cancel-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const error = await within(confirm).findByTestId('confirm-error');
    expect(error.getAttribute('data-error-code')).toBe('illegal_transition');
    expect(screen.getByTestId('task-cancel-confirm')).toBeTruthy();
  });

  it('no definition name renders the grey bare-id fallback chip, never a blank', () => {
    render(
      <PermissionsProvider>
        <TaskDetail
          task={task()}
          definitionName={undefined}
          http={scriptedHttp({ list_action_requests: () => ({ items: [] }) })}
          pushes={SILENT_PUSH_SOURCE}
          onOpenApproval={vi.fn()}
          onCancel={vi.fn(async () => undefined)}
        />
      </PermissionsProvider>,
    );
    // console redesign P3-4 part B: `task-definition` is now a `kit/ref-chip`, not the legacy
    // `ui/RefChip` (whose bare state carried a `ref-chip-bare` class) — its own degrade state
    // instead carries a `<testId>-fallback` inner node (kit/ref-chip.tsx).
    const chip = screen.getByTestId('task-definition');
    expect(within(chip).getByTestId('task-definition-fallback')).toBeTruthy();
  });

  describe('attribution (S10 E1 结果归因)', () => {
    it('a Task from before E1 reads 未记录 everywhere, never a guessed value', () => {
      renderDetail();
      const section = screen.getByTestId('task-attribution');
      expect(within(section).getAllByText('未记录')).toHaveLength(4);
      expect(within(screen.getByTestId('worker-run-skills')).getByText('未记录')).toBeTruthy();
    });

    it('shows Skill versions, the Turn, the claimed Procedure and both outcomes with who gave them', () => {
      renderDetail({
        turnId: 'turn-1',
        objectiveOutcome: {
          basis: 'agent_reported',
          outcome: 'achieved',
          givenBy: 'p-1',
          givenAt: '2026-09-03T00:01:00.000Z',
          revision: 2,
          previousOutcome: 'not_achieved',
        },
        turn: {
          id: 'turn-1',
          chatId: 'chat-1',
          startedBy: 'p-1',
          status: 'completed',
          startedAt: '2026-09-03T00:00:00.000Z',
          endedAt: '2026-09-03T00:02:00.000Z',
          procedure: {
            procedureId: 'proc-1',
            version: 3,
            name: 'diagnose-flow',
            basis: 'claimed',
            claimedAt: '2026-09-03T00:00:10.000Z',
          },
          outcome: null,
        },
        workerRuns: [
          {
            id: 'run-1',
            status: 'terminated',
            containerId: null,
            depth: 1,
            attempt: 1,
            startedAt: '2026-09-03T00:00:00.000Z',
            terminatedAt: '2026-09-03T00:01:00.000Z',
            skills: [{ skillId: 'sk-1', version: 2, name: 'diagnose' }],
          },
        ],
      });
      const section = screen.getByTestId('task-attribution');
      expect(within(section).getByText('达成')).toBeTruthy();
      expect(within(section).getByText(/已更正，原为 未达成/)).toBeTruthy();
      // An agent's verify-step report reads as the agent's, acting for Alice — not Alice's own call.
      const taskOutcome = within(section).getByTestId('outcome-value');
      expect(taskOutcome.getAttribute('data-basis')).toBe('agent_reported');
      expect(taskOutcome.textContent).toContain('agent 校验步骤上报（代表 Alice）');
      // S11 W1a: the agent's own report is shown, and said not to count toward attainment.
      const proxyNote = within(taskOutcome).getByTestId('outcome-proxy-note').textContent;
      expect(proxyNote).toContain('代理指标，不计入达成率');
      expect(proxyNote).toContain('达成率只算请求人的确认和平台验收检查');
      expect(within(section).getByText('diagnose-flow v3')).toBeTruthy();
      expect(within(section).getByText('agent 自报')).toBeTruthy();
      expect(screen.getByTestId('task-turn-link').getAttribute('href')).toBe('#/work/chats/chat-1');
      // The Turn's own outcome: nobody marked it yet.
      expect(within(section).getAllByText('未记录')).toHaveLength(1);
      expect(screen.getByTestId('worker-run-skills').textContent).toBe('diagnose v2');
    });

    it("the Turn's outcome reads as the requester's own judgement", () => {
      renderDetail({
        turnId: 'turn-1',
        turn: {
          id: 'turn-1',
          chatId: 'chat-1',
          startedBy: 'p-1',
          status: 'completed',
          startedAt: '2026-09-03T00:00:00.000Z',
          endedAt: '2026-09-03T00:02:00.000Z',
          procedure: null,
          outcome: {
            basis: 'requester',
            outcome: 'not_achieved',
            givenBy: 'p-1',
            givenAt: '2026-09-03T00:03:00.000Z',
            revision: 1,
            previousOutcome: null,
          },
        },
      });
      const values = screen.getAllByTestId('outcome-value');
      expect(values).toHaveLength(1);
      expect(values[0]?.getAttribute('data-basis')).toBe('requester');
      expect(values[0]?.textContent).toContain('请求人 Alice 判定');
      expect(screen.queryByTestId('outcome-proxy-note')).toBeNull();
    });

    it('a run that loaded no Skill reads 无, not 未记录; a Turn in an invisible chat says so', () => {
      renderDetail({
        turnId: 'turn-9',
        turn: null,
        workerRuns: [
          {
            id: 'run-1',
            status: 'running',
            containerId: null,
            depth: 0,
            attempt: 1,
            startedAt: '2026-09-03T00:00:00.000Z',
            terminatedAt: null,
            skills: [],
          },
        ],
      });
      expect(screen.getByTestId('worker-run-skills').textContent).toBe('无');
      expect(screen.getByText(/所在对话对你不可见/)).toBeTruthy();
    });
  });
  describe('运行环境 (S11 W1a)', () => {
    const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
    const PROMPT_DIGEST = 'b'.repeat(64);
    const ENV_DIGEST = `v1:${'c'.repeat(64)}`;
    const environment = {
      definition: { id: 'wd-1', version: 2 },
      model: 'anthropic/model-a',
      image: null,
      systemPromptDigest: PROMPT_DIGEST,
      kernelVersion: 'v0.50.0 (abc1234)',
      runtime: {
        imageRef: 'nexttime-ai-worker-runtime',
        imageId: IMAGE_ID,
        piVersion: '1.2.3',
        platformExtensionVersion: '0.50.0',
        builtFrom: 'v0.50.0 (abc1234)',
        modelsConfigDigest: null,
      },
      environmentDigest: ENV_DIGEST,
    };
    const run = {
      id: 'run-1',
      status: 'terminated',
      containerId: null,
      depth: 1,
      attempt: 1,
      startedAt: '2026-09-03T00:00:00.000Z',
      terminatedAt: '2026-09-03T00:01:00.000Z',
    };

    it('shows what a run ran with: the definition version, model, platform version, image and digests, never the prompt', () => {
      renderDetail({ workerRuns: [{ ...run, environment }] });
      const block = screen.getByTestId('run-environment');
      expect(block.textContent).toContain('Restarter v2');
      expect(block.textContent).toContain('anthropic/model-a');
      expect(block.textContent).toContain('v0.50.0 (abc1234)');
      expect(within(block).getByTestId('run-environment-image').textContent).toBe(
        `sha256:${'a'.repeat(12)}pi 1.2.3`,
      );
      expect(within(block).getByText('b'.repeat(12)).getAttribute('title')).toBe(PROMPT_DIGEST);
      expect(within(block).getByTestId('run-environment-digest').textContent).toBe(
        `v1:${'c'.repeat(12)}`,
      );
      // One run: no per-run heading, nothing to compare.
      expect(block.textContent).not.toContain('次尝试');
      expect(screen.queryByTestId('run-environment-summary')).toBeNull();
    });

    it('a run that named no model reads 运行时默认; a run that never started reads 未上报 and has no fingerprint', () => {
      renderDetail({
        workerRuns: [
          {
            ...run,
            environment: { ...environment, model: null, runtime: null, environmentDigest: null },
          },
        ],
      });
      const block = screen.getByTestId('run-environment');
      expect(within(block).getByText('运行时默认（Worker 定义和请求人都没指定）')).toBeTruthy();
      expect(within(block).getByTestId('run-environment-image').textContent).toMatch(/^未上报/);
      expect(within(block).getByTestId('run-environment-digest').textContent).toMatch(/^无法确定/);
    });

    it('a run from before the platform recorded it reads 未记录; a retry gets its own block', () => {
      renderDetail({
        workerRuns: [
          { ...run, environment: null },
          { ...run, id: 'run-2', attempt: 2, environment },
        ],
      });
      const blocks = screen.getAllByTestId('run-environment');
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.textContent).toContain('运行 run-1 · 第 1 次尝试');
      expect(
        within(blocks[0] as HTMLElement).getByTestId('run-environment-not-recorded'),
      ).toBeTruthy();
      expect(blocks[1]?.textContent).toContain('第 2 次尝试');
      expect(blocks[1]?.textContent).toContain('anthropic/model-a');
      expect(screen.getByTestId('run-environment-summary').textContent).toMatch(
        /^第 1 次尝试没有指纹，无法比较。环境指纹相同，说明/,
      );
    });

    it('several runs say which ran in the same environment', () => {
      const other = { ...environment, environmentDigest: `v1:${'d'.repeat(64)}` };
      renderDetail({
        workerRuns: [
          { ...run, environment },
          { ...run, id: 'run-2', attempt: 2, environment },
          { ...run, id: 'run-3', attempt: 3, environment: other },
        ],
      });
      expect(screen.getByTestId('run-environment-summary').textContent).toMatch(
        /^第 1、2 次尝试的环境指纹相同；第 3 次尝试与其他几次不同。/,
      );
      cleanup();
      renderDetail({
        workerRuns: [
          { ...run, environment },
          { ...run, id: 'run-2', attempt: 2, environment },
        ],
      });
      expect(screen.getByTestId('run-environment-summary').textContent).toMatch(
        /^这 2 次运行的环境指纹相同。/,
      );
    });
  });

  it('an attempt of a goal step shows its output contract, its last refused report and the attempt it redoes (S11 GO5d-1)', async () => {
    renderDetail({
      status: 'running',
      outputSchema: {
        type: 'object',
        properties: { hosts: { type: 'array', items: { type: 'string' } } },
        required: ['hosts'],
      },
      rejectedOutput: {
        output: { hosts: 'web-1', password: 'should-not-show' },
        problems: [{ path: 'output.hosts', message: 'expected array, got string' }],
        problemCount: 1,
        at: '2026-09-03T00:05:00.000Z',
      },
      reworkOf: {
        taskId: 'task-0',
        attempt: 1,
        rejectedOutput: {
          output: null,
          problems: [{ path: 'output', message: 'required, missing' }],
          problemCount: 1,
          at: '2026-09-03T00:01:00.000Z',
        },
      },
    });
    const section = await screen.findByTestId('task-output-contract');
    expect(within(section).getByTestId('output-contract-field').textContent).toBe(
      'hosts列表（每项：文本）必填',
    );
    // What the contract is for comes first, before which attempt this one redoes.
    expect(section.textContent?.indexOf('Worker 交回结果时')).toBeLessThan(
      section.textContent?.indexOf('这次尝试重做') ?? -1,
    );
    const rework = within(section).getByTestId('task-rework-of');
    expect(rework.textContent).toMatch(/这次尝试重做第 1 次尝试/);
    expect(within(rework).getByTestId('task-rework-of-link')).toBeTruthy();
    expect(within(rework).getByTestId('task-rework-of-problems').textContent).toContain(
      'output：必填，但没有',
    );
    const rejected = within(section).getByTestId('task-rejected-output');
    expect(within(rejected).getByTestId('task-rejected-output-problems').textContent).toContain(
      'output.hosts：应为列表，实际是文本',
    );
    expect(rejected.textContent).toMatch(/最后一次被拒的报告在 \S+ \S+/);
    expect(rejected.textContent).not.toMatch(/（.*\(/);
    expect(rejected.textContent).toContain('web-1');
    expect(rejected.textContent).not.toContain('should-not-show');
    expect(within(rejected).getByTestId('task-rejected-output-redacted')).toBeTruthy();
  });

  it('a Task that is not a goal step’s attempt has no output contract section', async () => {
    renderDetail({ outputSchema: null, rejectedOutput: null, reworkOf: null });
    await screen.findByTestId('task-detail');
    expect(screen.queryByTestId('task-output-contract')).toBeNull();
  });
});
