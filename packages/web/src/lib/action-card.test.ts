import { describe, expect, it } from 'vitest';
import {
  actionCardFromPendingContent,
  actionCardFromPush,
  actionCardFromRow,
  enrichActionCard,
  humanizeActionKind,
  isPendingCardMessage,
} from './action-card.js';
import type { ChatMessage } from './ws-client.js';

/** action-card.test.ts: the three normalization paths (`lib/action-card.ts`'s own module doc
 *  comment) converge on one `ActionCardData` shape. */

describe('humanizeActionKind', () => {
  it('replaces dot-segments with spaces', () => {
    expect(humanizeActionKind('docker.container_restart')).toBe('docker container_restart');
  });
});

describe('actionCardFromPush', () => {
  it('uses the push verbatim for title/description/actionKind/simulated', () => {
    const card = actionCardFromPush(
      {
        actionRequestId: 'ar-1',
        gatekeeperId: 'gk-1',
        title: 'Restart container',
        description: 'Restarts web-1',
        actionKind: { tag: 'docker.container_restart', label: 'docker container restart' },
        awaitDecision: true,
        simulated: { wouldRestart: 'web-1' },
      },
      { resourceScope: 'web-1', isHolder: true },
    );

    expect(card).toMatchObject({
      actionRequestId: 'ar-1',
      title: 'Restart container',
      description: 'Restarts web-1',
      actionKindTag: 'docker.container_restart',
      actionKindLabel: 'docker container restart',
      resourceScope: 'web-1',
      awaitDecision: true,
      simulated: { wouldRestart: 'web-1' },
      status: 'pending_approval',
      isHolder: true,
    });
  });
});

describe('actionCardFromPendingContent', () => {
  function content(overrides: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
    return {
      kind: 'system.action_pending',
      text: 'docker container restart requested',
      actionRequestId: 'ar-1',
      gatekeeperId: 'gk-1',
      actionKind: 'docker.container_restart',
      resourceScope: 'web-1',
      blastRadius: 'medium',
      awaitDecision: true,
      isHolder: true,
      ...overrides,
    };
  }

  it('synthesizes title/actionKindLabel from actionKind and uses text as description', () => {
    const card = actionCardFromPendingContent(content());
    expect(card).toMatchObject({
      actionRequestId: 'ar-1',
      title: 'docker container_restart',
      description: 'docker container restart requested',
      actionKindTag: 'docker.container_restart',
      resourceScope: 'web-1',
      blastRadius: 'medium',
      awaitDecision: true,
      status: 'pending_approval',
      isHolder: true,
    });
  });

  it('returns undefined for a different kind', () => {
    expect(actionCardFromPendingContent(content({ kind: 'system.action_update' }))).toBeUndefined();
  });

  it('returns undefined when a required field is missing', () => {
    expect(actionCardFromPendingContent(content({ actionRequestId: undefined }))).toBeUndefined();
  });
});

describe('actionCardFromRow', () => {
  it('synthesizes title/description from actionKind, resourceScope, and params', () => {
    const card = actionCardFromRow({
      id: 'ar-1',
      status: 'pending_approval',
      gatekeeperId: 'gk-1',
      actionKind: 'docker.container_restart',
      resourceScope: 'web-1',
      blastRadius: 'medium',
      awaitDecision: true,
      params: { container: 'web-1' },
    });

    expect(card.title).toBe('docker container_restart');
    expect(card.description).toContain('docker container_restart on web-1');
    expect(card.description).toContain('"container": "web-1"');
    expect(card.status).toBe('pending_approval');
    expect(card.isHolder).toBe(true);
  });

  it('omits the params block when params is empty', () => {
    const card = actionCardFromRow({
      id: 'ar-1',
      status: 'pending_approval',
      gatekeeperId: 'gk-1',
      actionKind: 'docker.container_restart',
      resourceScope: null,
      blastRadius: 'low',
      awaitDecision: false,
      params: {},
    });
    expect(card.description).not.toContain('```');
  });
});

describe('enrichActionCard', () => {
  it('overlays push title/description/actionKind/simulated onto a base card, keeping the rest', () => {
    const base = actionCardFromRow({
      id: 'ar-1',
      status: 'pending_approval',
      gatekeeperId: 'gk-1',
      actionKind: 'docker.container_restart',
      resourceScope: 'web-1',
      blastRadius: 'medium',
      awaitDecision: true,
      params: {},
    });
    const enriched = enrichActionCard(base, {
      actionRequestId: 'ar-1',
      gatekeeperId: 'gk-1',
      title: 'Restart container web-1',
      description: 'Would restart the web-1 container.',
      actionKind: { tag: 'docker.container_restart', label: 'docker container restart' },
      awaitDecision: true,
      simulated: { dryRun: true },
    });

    expect(enriched.title).toBe('Restart container web-1');
    expect(enriched.description).toBe('Would restart the web-1 container.');
    expect(enriched.simulated).toEqual({ dryRun: true });
    expect(enriched.resourceScope).toBe('web-1');
    expect(enriched.blastRadius).toBe('medium');
  });
});

describe('isPendingCardMessage', () => {
  function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'm1',
      role: 'system',
      text: 'text',
      createdAt: '2026-01-01T00:00:00.000Z',
      sequence: 1,
      ...overrides,
    };
  }

  it('is true only for kind === system.action_pending', () => {
    expect(isPendingCardMessage(chatMessage({ kind: 'system.action_pending' }))).toBe(true);
    expect(isPendingCardMessage(chatMessage({ kind: 'system.action_update' }))).toBe(false);
    expect(isPendingCardMessage(chatMessage({ kind: 'system.task_update' }))).toBe(false);
    expect(isPendingCardMessage(chatMessage({ kind: undefined }))).toBe(false);
  });
});
