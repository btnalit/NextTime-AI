import { IllegalTransition } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalDrainer, DrainResult } from '../../governance/approval/index.js';
import { SYSTEM_ACTOR_PLACEHOLDER } from '../../governance/gatekeepers/index.js';
import type { WithTransactionFn } from './action-executor.js';
import {
  type ActionRequestUpdatedSource,
  registerActionRequestDrainConsumer,
} from './action-request-drain-consumer.js';

/**
 * application/gateway/action-request-drain-consumer (unit, no Postgres). R-52 (2026-10-02 review):
 * the consumer starts the drain and returns — it never holds the outbox dispatcher's serial
 * delivery loop for the length of a gate `apply`.
 */

type Consumer = Parameters<ActionRequestUpdatedSource['subscribe']>[1];

function setup(drainGatekeeper: ApprovalDrainer['drainGatekeeper']) {
  let consumer: Consumer | undefined;
  const source: ActionRequestUpdatedSource = {
    subscribe(_eventType, registered) {
      consumer = registered;
      return () => {};
    },
  };
  const drainer = { drainGatekeeper: vi.fn(drainGatekeeper) };
  // Stands in for the admin transaction that reads the row back: every row is on gatekeeper gk-1.
  const withTransaction = (async () => ({ gatekeeperId: 'gk-1' })) as unknown as WithTransactionFn;
  const onError = vi.fn();
  registerActionRequestDrainConsumer(
    source,
    drainer as unknown as ApprovalDrainer,
    withTransaction,
    onError,
  );
  if (!consumer) throw new Error('consumer was not registered');
  return { consumer, drainer, onError };
}

function approved(status: 'approved' | 'auto_approved' | 'rejected' = 'approved') {
  return {
    type: 'ActionRequestUpdated' as const,
    workspaceId: 'ws-1',
    actionRequestId: 'ar-1',
    status,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('registerActionRequestDrainConsumer', () => {
  it('starts the drain and returns without waiting for it to finish', async () => {
    const { consumer, drainer } = setup(() => new Promise<DrainResult>(() => {})); // never settles

    await consumer(approved());

    expect(drainer.drainGatekeeper).toHaveBeenCalledWith('ws-1', SYSTEM_ACTOR_PLACEHOLDER, 'gk-1');
  });

  it('reports a drain failure to onError, but not a benign IllegalTransition race', async () => {
    const failing = setup(async () => {
      throw new Error('gate down');
    });
    await failing.consumer(approved('auto_approved'));
    await flushMicrotasks();
    expect(failing.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'gate down' }));

    const racing = setup(async () => {
      throw new IllegalTransition('ActionRequest', 'executing', 'start_execution');
    });
    await racing.consumer(approved());
    await flushMicrotasks();
    expect(racing.drainer.drainGatekeeper).toHaveBeenCalledTimes(1);
    expect(racing.onError).not.toHaveBeenCalled();
  });

  it('ignores an update that does not make the row executable', async () => {
    const { consumer, drainer } = setup(() => new Promise<DrainResult>(() => {}));
    await consumer(approved('rejected'));
    expect(drainer.drainGatekeeper).not.toHaveBeenCalled();
  });
});
