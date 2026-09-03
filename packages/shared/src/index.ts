/**
 * @nexttime/shared — the domain layer (design doc §7.10): enums, transition tables, the
 * capability registry, the platform event vocabulary, ActionDescription/Operation schemas, and
 * the Handle-token wire primitive (claims schema + local EdDSA verification, S1.7) shared by
 * every verifier — the kernel and `llm-proxy` alike.
 * Depends on nothing else in this monorepo (enforced by .dependency-cruiser.cjs).
 */

export * from './enums.js';
export * from './transitions.js';
export * from './capabilities.js';
export * from './events.js';
export * from './action-description.js';
export * from './http.js';
export * from './handle-token.js';
export * from './agent-host-protocol.js';
export * from './worker-definition.js';
export * from './chat-message-content.js';

export const VERSION = '0.1.0';
