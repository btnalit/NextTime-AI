import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetChatPushEventsForTests,
  publishChatPushEvent,
  subscribeToChatPushEvents,
} from './push.js';
import type { ChatPushEvent } from './push.js';

/** Unit tests (pure in-memory, no IO) for the chat push bus — application/chat/push.ts. */

afterEach(() => {
  _resetChatPushEventsForTests();
});

const METADATA_EVENT: ChatPushEvent = {
  type: 'chat.metadata',
  chatId: 'chat1',
  metadata: { turnId: 'turn1' },
};

describe('subscribeToChatPushEvents / publishChatPushEvent', () => {
  it('delivers a published event only to listeners subscribed to that chatId', () => {
    const receivedByChat1: ChatPushEvent[] = [];
    const receivedByChat2: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => receivedByChat1.push(e));
    subscribeToChatPushEvents('chat2', (e) => receivedByChat2.push(e));

    publishChatPushEvent(METADATA_EVENT);

    expect(receivedByChat1).toEqual([METADATA_EVENT]);
    expect(receivedByChat2).toEqual([]);
  });

  it('publishing with no subscribers is a harmless no-op', () => {
    expect(() => publishChatPushEvent(METADATA_EVENT)).not.toThrow();
  });

  it('supports multiple listeners on the same chat, called in registration order', () => {
    const order: string[] = [];
    subscribeToChatPushEvents('chat1', () => order.push('first'));
    subscribeToChatPushEvents('chat1', () => order.push('second'));

    publishChatPushEvent(METADATA_EVENT);

    expect(order).toEqual(['first', 'second']);
  });

  it('unsubscribe stops delivery to that listener only', () => {
    const receivedA: ChatPushEvent[] = [];
    const receivedB: ChatPushEvent[] = [];
    const unsubscribeA = subscribeToChatPushEvents('chat1', (e) => receivedA.push(e));
    subscribeToChatPushEvents('chat1', (e) => receivedB.push(e));

    unsubscribeA();
    publishChatPushEvent(METADATA_EVENT);

    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual([METADATA_EVENT]);
  });

  it('unsubscribing twice is a harmless no-op', () => {
    const unsubscribe = subscribeToChatPushEvents('chat1', () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });
});
