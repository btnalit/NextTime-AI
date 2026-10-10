import { describe, expect, it } from 'vitest';
import {
  ProviderHealthFileSchema,
  type ProviderHealthInput,
  type ProviderHealthTest,
  providerHealth,
  providerHealthUsability,
  providerTestStillApplies,
} from './provider-health.js';

const PROVIDER: ProviderHealthInput = {
  enabled: true,
  credentialPresent: true,
  credentialInvalid: false,
  upstreamBaseUrl: 'https://api.example.invalid',
  models: [{ id: 'chat', displayName: null, cost: null }],
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function test(overrides: Partial<ProviderHealthTest> = {}): ProviderHealthTest {
  return {
    model: 'chat',
    completion: 'ok',
    toolCall: 'ok',
    error: null,
    testedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('providerHealth', () => {
  it.each<[string, Partial<ProviderHealthInput>, ProviderHealthTest | null, string]>([
    [
      'disabled wins over everything',
      { enabled: false, credentialPresent: false },
      test(),
      'disabled',
    ],
    ['a key a header cannot carry', { credentialInvalid: true }, test(), 'key_invalid'],
    ['no key', { credentialPresent: false }, test(), 'key_missing'],
    [
      'a Base URL with a query string',
      { upstreamBaseUrl: 'https://a.example.invalid/?x' },
      test(),
      'url_unsafe',
    ],
    ['never tested', {}, null, 'untested'],
    ['passed both', {}, test(), 'ok'],
    [
      'the provider refused the key (401)',
      {},
      test({ completion: 'error', toolCall: 'skipped', error: 'HTTP 401 Unauthorized' }),
      'key_rejected',
    ],
    [
      'the provider refused the key (403)',
      {},
      test({ completion: 'error', toolCall: 'skipped', error: 'HTTP 403' }),
      'key_rejected',
    ],
    [
      'another completion failure',
      {},
      test({ completion: 'error', toolCall: 'skipped', error: 'HTTP 500' }),
      'test_failed',
    ],
    [
      'a 4010-ish status is not a 401',
      {},
      test({ completion: 'error', toolCall: 'skipped', error: 'HTTP 4010' }),
      'test_failed',
    ],
    ['completion ok, tool call failed', {}, test({ toolCall: 'error' }), 'tools_failed'],
    ['completion ok, tool call skipped', {}, test({ toolCall: 'skipped' }), 'untested'],
  ])('%s', (_label, overrides, lastTest, expected) => {
    expect(providerHealth({ ...PROVIDER, ...overrides }, lastTest).status).toBe(expected);
  });

  it('carries the applicable test time, and none without an applicable test', () => {
    expect(providerHealth(PROVIDER, test())).toEqual({
      status: 'ok',
      testedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(providerHealth({ ...PROVIDER, credentialPresent: false }, test()).testedAt).toBeNull();
  });

  it('a test stops applying once the provider is edited after it, or its model is unlisted', () => {
    expect(providerTestStillApplies(PROVIDER, test())).toBe(true);
    expect(
      providerHealth({ ...PROVIDER, updatedAt: '2026-10-03T00:00:00.000Z' }, test()).status,
    ).toBe('untested');
    expect(providerHealth(PROVIDER, test({ model: 'gone' })).status).toBe('untested');
    expect(providerTestStillApplies({ ...PROVIDER, updatedAt: null }, test())).toBe(true);
  });
});

describe('providerHealthUsability', () => {
  it('only ok is offered plainly; untested and tools_failed are offered marked; the rest are blocked', () => {
    expect(providerHealthUsability('ok')).toBe('ok');
    expect(providerHealthUsability('untested')).toBe('unverified');
    expect(providerHealthUsability('tools_failed')).toBe('warn');
    for (const status of [
      'disabled',
      'key_invalid',
      'key_missing',
      'url_unsafe',
      'key_rejected',
      'test_failed',
    ] as const) {
      expect(providerHealthUsability(status)).toBe('blocked');
    }
  });
});

describe('ProviderHealthFileSchema', () => {
  it('accepts a status and a time per provider, nothing more', () => {
    expect(
      ProviderHealthFileSchema.safeParse({
        version: 1,
        writtenAt: 'x',
        providers: { a: { status: 'ok', testedAt: null } },
      }).success,
    ).toBe(true);
    expect(
      ProviderHealthFileSchema.safeParse({
        version: 1,
        writtenAt: 'x',
        providers: { a: { status: 'ok', testedAt: null, error: 'HTTP 401' } },
      }).success,
    ).toBe(false);
  });
});
