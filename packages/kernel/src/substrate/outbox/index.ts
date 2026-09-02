/**
 * substrate/outbox: transactional-outbox write side (design doc §7.10). The single sanctioned
 * way to append a domain event to the `outbox` table — see enqueue.ts.
 */
export { enqueue } from './enqueue.js';
export type { DomainEvent } from './enqueue.js';
