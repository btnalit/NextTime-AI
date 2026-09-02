import { z } from 'zod';

/**
 * Domain event vocabulary (design doc §7.10). These are the only events that cross module and
 * package boundaries inside the kernel — application modules publish them to the outbox in the
 * same transaction as the state transition that caused them, and other modules subscribe instead
 * of importing each other's internals or querying each other's tables.
 */
export const PLATFORM_EVENT_NAMES = [
  'TurnStarted',
  'TurnCompleted',
  'TaskUpdated',
  'ActionRequestPending',
  'ActionRequestUpdated',
  'ConnectionCreated',
  'FactAsserted',
  'EgressObserved',
  'BudgetWarning',
] as const;

export type PlatformEventName = (typeof PLATFORM_EVENT_NAMES)[number];

export const PlatformEventNameSchema = z.enum(PLATFORM_EVENT_NAMES);

export const VERSION = '0.1.0';
