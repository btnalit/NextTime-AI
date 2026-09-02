/**
 * @nexttime/shared — the domain layer (design doc §7.10): enums, transition tables, the
 * capability registry, the platform event vocabulary, and ActionDescription/Operation schemas.
 * Depends on nothing else in this monorepo (enforced by .dependency-cruiser.cjs).
 */

export * from './enums.js';
export * from './transitions.js';
export * from './capabilities.js';
export * from './events.js';
export * from './action-description.js';

export const VERSION = '0.1.0';
