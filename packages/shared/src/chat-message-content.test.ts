import { describe, expect, it } from 'vitest';
import {
  SYSTEM_MESSAGE_KIND_VALUES,
  type SystemMessageContent,
  SystemMessageContentSchema,
} from './chat-message-content.js';

/**
 * chat-message-content.test: round-trip/rejection coverage for the `SystemMessageContent`
 * variants `application/linkage` (kernel) writes into `chat_messages.content` — docs/development-
 * tasks.md S2.11 deliverable 1, S11 GO5e-2's `system.goal_update`, legacy 589's
 * `system.model_refused`, legacy 515's `system.turn_not_started` and legacy 168's
 * `system.agent_reconnecting`.
 */

describe('SYSTEM_MESSAGE_KIND_VALUES', () => {
  it('lists the three S2.11 chat message kinds, S11 GO5e-2 system.goal_update, legacy 589 system.model_refused, legacy 515 system.turn_not_started and legacy 168 system.agent_reconnecting', () => {
    expect(SYSTEM_MESSAGE_KIND_VALUES).toEqual([
      'system.task_update',
      'system.action_pending',
      'system.action_update',
      'system.goal_update',
      'system.model_refused',
      'system.turn_not_started',
      'system.agent_reconnecting',
    ]);
  });
});

const SAMPLE_CONTENTS: SystemMessageContent[] = [
  {
    kind: 'system.task_update',
    text: 'Task task1 completed',
    taskId: 'task1',
    status: 'completed',
    failureReason: null,
    summary: 'did the thing',
  },
  {
    kind: 'system.action_pending',
    text: 'Approval needed: restart container',
    actionRequestId: 'ar1',
    gatekeeperId: 'gk1',
    actionKindTag: 'docker.container_restart',
    resourceScope: 'host-1',
    blastRadius: 'medium',
    awaitDecision: false,
    isHolder: true,
  },
  {
    kind: 'system.action_update',
    text: 'restart container: was approved',
    actionRequestId: 'ar1',
    status: 'approved',
    actionKindTag: 'docker.container_restart',
    isHolder: false,
  },
  // S11 GO5e-2: a goal step's Task names its goal and step.
  {
    kind: 'system.task_update',
    text: 'Goal step "collect": task task2 completed',
    taskId: 'task2',
    status: 'completed',
    failureReason: null,
    summary: null,
    goalRunId: 'goal1',
    stepKey: 'collect',
  },
  {
    kind: 'system.goal_update',
    text: 'Goal goal1 is held by a workspace owner',
    goalRunId: 'goal1',
    change: 'hold',
    status: 'paused',
    pauseReason: 'requested',
    heldByOwner: true,
  },
  {
    kind: 'system.goal_update',
    text: 'Goal goal1 completed: achieved',
    goalRunId: 'goal1',
    change: 'complete',
    status: 'completed',
    outcome: 'achieved',
    outcomeBasis: 'verified_by_check',
  },
  // An event written before `change` existed.
  {
    kind: 'system.goal_update',
    text: 'Goal goal1 is now "running"',
    goalRunId: 'goal1',
    status: 'running',
  },
  // Legacy 589: an entry Turn whose every model call the platform refused.
  {
    kind: 'system.model_refused',
    text: 'The model was not called: the workspace daily token budget is used up',
    turnId: 'turn1',
    scope: 'workspace_daily_tokens',
    resetsAt: '2026-11-02T00:00:00.000Z',
  },
  // Legacy 515: an entry Turn the evaluation seal kept from starting, for each reason.
  {
    kind: 'system.turn_not_started',
    text: 'The agent was not started: what it starts with carries content reserved for evaluation',
    turnId: 'turn2',
    reason: 'evaluation_withheld',
  },
  {
    kind: 'system.turn_not_started',
    text: 'The agent was not started: the evaluation seal paused the agents acting for you',
    turnId: 'turn3',
    reason: 'evaluation_paused',
  },
  // Legacy 168: an entry Turn whose last model call was refused while the platform reconnects the
  // agent (no Handle bound to its container's address yet).
  {
    kind: 'system.agent_reconnecting',
    text: 'The agent is reconnecting to the platform: send the message again shortly',
    turnId: 'turn4',
  },
];

describe('SystemMessageContentSchema', () => {
  it('round-trips every sample content through parse', () => {
    for (const content of SAMPLE_CONTENTS) {
      expect(SystemMessageContentSchema.parse(content)).toEqual(content);
    }
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      SystemMessageContentSchema.parse({ kind: 'system.not_a_kind', text: 'x' }),
    ).toThrow();
  });

  it('rejects system.task_update missing a required field (taskId)', () => {
    expect(() =>
      SystemMessageContentSchema.parse({
        kind: 'system.task_update',
        text: 'x',
        status: 'completed',
      }),
    ).toThrow();
  });

  it('rejects system.action_pending with an invalid blastRadius enum value', () => {
    expect(() =>
      SystemMessageContentSchema.parse({
        kind: 'system.action_pending',
        text: 'x',
        actionRequestId: 'ar1',
        gatekeeperId: 'gk1',
        actionKindTag: 'test.action',
        blastRadius: 'not_a_radius',
        isHolder: true,
      }),
    ).toThrow();
  });

  it('rejects system.model_refused whose scope is not an LlmRefusalScope', () => {
    expect(() =>
      SystemMessageContentSchema.parse({
        kind: 'system.model_refused',
        text: 'x',
        turnId: 'turn1',
        scope: 'task_budget',
        resetsAt: '2026-11-02T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects system.turn_not_started whose reason is not an EvaluationStartRefusal', () => {
    expect(() =>
      SystemMessageContentSchema.parse({
        kind: 'system.turn_not_started',
        text: 'x',
        turnId: 'turn1',
        reason: 'spawn_failed',
      }),
    ).toThrow();
  });

  it('rejects system.agent_reconnecting without the Turn it ended (turnId)', () => {
    expect(() =>
      SystemMessageContentSchema.parse({ kind: 'system.agent_reconnecting', text: 'x' }),
    ).toThrow();
  });

  it('rejects system.goal_update with a change that is not a GoalRunChange', () => {
    expect(() =>
      SystemMessageContentSchema.parse({
        kind: 'system.goal_update',
        text: 'x',
        goalRunId: 'goal1',
        change: 'not_a_change',
        status: 'running',
      }),
    ).toThrow();
  });

  it('accepts system.action_pending with only the required fields (optional ones omitted)', () => {
    const minimal = {
      kind: 'system.action_pending' as const,
      text: 'x',
      actionRequestId: 'ar1',
      gatekeeperId: 'gk1',
      actionKindTag: 'test.action',
      isHolder: true,
    };
    expect(SystemMessageContentSchema.parse(minimal)).toEqual(minimal);
  });
});
