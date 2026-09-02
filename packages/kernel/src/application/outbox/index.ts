/**
 * application/outbox: the outbox dispatcher — the read side of the transactional-outbox pattern
 * (design doc §7.10; docs/development-tasks.md S1.4 deliverable 3). The write side
 * (`substrate/outbox/enqueue.ts`) lives in substrate, one layer down, so every producer from
 * substrate upward can reach it; this module is application-layer because *consuming* the outbox
 * (subscribing, polling, delivering to in-process handlers) is orchestration, not graph-substrate
 * logic — see dispatcher.ts's own doc comment for the full rationale.
 */
export { OutboxDispatcher } from './dispatcher.js';
export type { OutboxConsumer, OutboxDeliveryMeta, OutboxDispatcherOptions } from './dispatcher.js';
