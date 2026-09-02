import { describe, expect, it } from 'vitest';
import {
  ACTION_REQUEST_STATUS_VALUES,
  ActionDescriptionSchema,
  CAPABILITY_REGISTRY,
  PLATFORM_EVENT_NAMES,
  PlatformEventSchema,
  VERSION,
  assertRegistryConsistent,
  transition,
} from './index.js';

/** Smoke test: every module's public surface is reachable through the package's single entry point. */
describe('index re-exports', () => {
  it('exposes enums', () => {
    expect(ACTION_REQUEST_STATUS_VALUES).toContain('proposed');
  });

  it('exposes transitions', () => {
    expect(typeof transition).toBe('function');
  });

  it('exposes the capability registry', () => {
    expect(CAPABILITY_REGISTRY.length).toBeGreaterThan(0);
    expect(() => assertRegistryConsistent()).not.toThrow();
  });

  it('exposes the event vocabulary', () => {
    expect(PLATFORM_EVENT_NAMES).toContain('TurnStarted');
    expect(typeof PlatformEventSchema.parse).toBe('function');
  });

  it('exposes ActionDescription', () => {
    expect(typeof ActionDescriptionSchema.parse).toBe('function');
  });

  it('exports a package VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
