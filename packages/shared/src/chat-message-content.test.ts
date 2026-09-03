import { describe, expect, it } from 'vitest';
import {
  SYSTEM_MESSAGE_KIND_VALUES,
  type SystemMessageContent,
  SystemMessageContentSchema,
} from './chat-message-content.js';

/**
 * chat-message-content.test: round-trip/rejection coverage for the three `SystemMessageContent`
 * variants `application/linkage` (kernel) writes into `chat_messages.content` — docs/development-
 * tasks.md S2.11 deliverable 1.
 */

describe('SYSTEM_MESSAGE_KIND_VALUES', () => {
  it('lists exactly the three S2.11 chat message kinds', () => {
    expect(SYSTEM_MESSAGE_KIND_VALUES).toEqual([
      'system.task_update',
      'system.action_pending',
      'system.action_update',
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
    actionKind: 'docker.container_restart',
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
    actionKind: 'docker.container_restart',
    isHolder: false,
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
        actionKind: 'test.action',
        blastRadius: 'not_a_radius',
        isHolder: true,
      }),
    ).toThrow();
  });

  it('accepts system.action_pending with only the required fields (optional ones omitted)', () => {
    const minimal = {
      kind: 'system.action_pending' as const,
      text: 'x',
      actionRequestId: 'ar1',
      gatekeeperId: 'gk1',
      actionKind: 'test.action',
      isHolder: true,
    };
    expect(SystemMessageContentSchema.parse(minimal)).toEqual(minimal);
  });
});
