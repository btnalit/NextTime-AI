import { describe, expect, it } from 'vitest';
import { PLATFORM_EVENT_NAMES, PlatformEventNameSchema, PlatformEventSchema } from './events.js';
import type { PlatformEvent } from './events.js';

describe('PLATFORM_EVENT_NAMES', () => {
  it('lists the eleven canonical domain events from design doc §7.10 (S2.7 adds WorkerRunUpdated, S2.13 adds ConnectionRequested)', () => {
    expect(PLATFORM_EVENT_NAMES).toEqual([
      'TurnStarted',
      'TurnCompleted',
      'TaskUpdated',
      'WorkerRunUpdated',
      'ActionRequestPending',
      'ActionRequestUpdated',
      'ConnectionRequested',
      'ConnectionCreated',
      'FactAsserted',
      'EgressObserved',
      'BudgetWarning',
    ]);
  });

  it('accepts every listed event name via the Zod schema', () => {
    for (const name of PLATFORM_EVENT_NAMES) {
      expect(PlatformEventNameSchema.parse(name)).toBe(name);
    }
  });

  it('rejects an unknown event name', () => {
    expect(() => PlatformEventNameSchema.parse('NotARealEvent')).toThrow();
  });
});

const SAMPLE_EVENTS: PlatformEvent[] = [
  {
    type: 'TurnStarted',
    workspaceId: 'ws1',
    chatId: 'chat1',
    turnId: 'turn1',
    principalId: 'p1',
    prompt: 'hello',
  },
  {
    type: 'TurnCompleted',
    workspaceId: 'ws1',
    chatId: 'chat1',
    turnId: 'turn1',
    status: 'completed',
  },
  { type: 'TaskUpdated', workspaceId: 'ws1', taskId: 'task1', status: 'running' },
  {
    type: 'WorkerRunUpdated',
    workspaceId: 'ws1',
    workerRunId: 'wr1',
    taskId: 'task1',
    status: 'running',
  },
  {
    type: 'ActionRequestPending',
    workspaceId: 'ws1',
    actionRequestId: 'ar1',
    gatekeeperId: 'gk1',
    actionKind: 'docker.container_restart',
    holderPrincipalIds: ['owner1', 'operator1'],
  },
  { type: 'ActionRequestUpdated', workspaceId: 'ws1', actionRequestId: 'ar1', status: 'executed' },
  {
    type: 'ConnectionRequested',
    workspaceId: 'ws1',
    connectionRequestId: 'cr1',
    kind: 'ssh',
    target: 'example-host',
    requestedBy: 'p1',
  },
  {
    type: 'ConnectionCreated',
    workspaceId: 'ws1',
    gatekeeperId: 'gk1',
    kind: 'ssh',
    target: 'example-host',
  },
  { type: 'FactAsserted', workspaceId: 'ws1', factId: 'fact1', epistemicStatus: 'observed' },
  { type: 'EgressObserved', workspaceId: 'ws1', activityId: 'act1', domain: 'example.com' },
  { type: 'BudgetWarning', workspaceId: 'ws1', scope: 'task', taskId: 'task1', percent: 80 },
  {
    type: 'chat.message',
    chatId: 'chat1',
    message: {
      id: 'm1',
      role: 'assistant',
      text: 'hello',
      createdAt: '2026-09-01T00:00:00Z',
      sequence: 2,
    },
  },
  // S2.11 addition: a role='system' message carrying the optional kind/content pair
  // (application/linkage writes these; chat-message-content.ts's SystemMessageContent is the
  // richer, kind-discriminated shape `content` holds — loosened to a bare record here, see this
  // field's own doc comment).
  {
    type: 'chat.message',
    chatId: 'chat1',
    message: {
      id: 'm2',
      role: 'system',
      text: 'Task task1 completed',
      createdAt: '2026-09-01T00:01:00Z',
      sequence: 3,
      kind: 'system.task_update',
      content: {
        kind: 'system.task_update',
        text: 'Task task1 completed',
        taskId: 'task1',
        status: 'completed',
      },
    },
  },
  {
    type: 'chat.stream',
    chatId: 'chat1',
    turnId: 'turn1',
    payload: { streamKind: 'textDelta', delta: 'hi' },
  },
  {
    type: 'chat.stream',
    chatId: 'chat1',
    turnId: 'turn1',
    payload: { streamKind: 'toolCallStarted', toolCallId: 'tc1', name: 'graph.get_object' },
  },
  {
    type: 'chat.stream',
    chatId: 'chat1',
    turnId: 'turn1',
    payload: { streamKind: 'toolCallEnded', toolCallId: 'tc1', result: { ok: true } },
  },
  {
    type: 'chat.stream',
    chatId: 'chat1',
    turnId: 'turn1',
    payload: {
      streamKind: 'workerSpawned',
      taskId: 'task1',
      workerRunId: 'wr1',
      definitionId: 'ops-runner',
    },
  },
  {
    type: 'chat.stream',
    chatId: 'chat1',
    turnId: 'turn1',
    payload: { streamKind: 'taskUpdated', taskId: 'task1', status: 'completed' },
  },
  { type: 'chat.metadata', chatId: 'chat1', metadata: { pendingActionRequestIds: ['ar1'] } },
  {
    type: 'action.pending',
    actionRequestId: 'ar1',
    gatekeeperId: 'gk1',
    title: 'Restart container',
    description: '**restart** the container',
    actionKind: { tag: 'docker.container_restart', label: 'Restart container' },
    awaitDecision: false,
  },
  { type: 'action.updated', actionRequestId: 'ar1', status: 'approved' },
  { type: 'task.updated', taskId: 'task1', status: 'completed' },
];

describe('PlatformEventSchema', () => {
  it('round-trips every sample event through parse', () => {
    for (const event of SAMPLE_EVENTS) {
      const parsed = PlatformEventSchema.parse(event);
      expect(parsed).toEqual(event);
    }
  });

  it('covers all seventeen variants (11 domain + 6 chat/ws)', () => {
    const seenTypes = new Set(SAMPLE_EVENTS.map((e) => e.type));
    expect(seenTypes.size).toBe(17);
  });

  it('rejects an event with an unknown discriminant', () => {
    expect(() => PlatformEventSchema.parse({ type: 'NotAnEvent' })).toThrow();
  });

  it('rejects a domain event missing a required field', () => {
    expect(() => PlatformEventSchema.parse({ type: 'TurnStarted', workspaceId: 'ws1' })).toThrow();
  });

  it('rejects a chat.stream payload with an unknown streamKind', () => {
    expect(() =>
      PlatformEventSchema.parse({
        type: 'chat.stream',
        chatId: 'chat1',
        turnId: 'turn1',
        payload: { streamKind: 'notAKind' },
      }),
    ).toThrow();
  });

  it('rejects an invalid enum value inside an event (e.g. bad TaskStatus)', () => {
    expect(() =>
      PlatformEventSchema.parse({
        type: 'TaskUpdated',
        workspaceId: 'ws1',
        taskId: 'task1',
        status: 'not_a_status',
      }),
    ).toThrow();
  });
});
