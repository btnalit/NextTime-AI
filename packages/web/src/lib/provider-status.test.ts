import type { LlmProviderTestResultWire, LlmProviderWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { providerStatus } from './provider-status.js';

function provider(overrides: Partial<LlmProviderWire> = {}): LlmProviderWire {
  return {
    id: 'acme',
    displayName: 'Acme',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://api.example.invalid',
    authHeader: 'authorization',
    authScheme: 'Bearer',
    apiKeyEnv: null,
    credentialPresent: true,
    credentialSource: 'console',
    enabled: true,
    source: 'store',
    overridesFile: false,
    models: [{ id: 'm', displayName: null, cost: null }],
    lastTest: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function test(overrides: Partial<LlmProviderTestResultWire> = {}): LlmProviderTestResultWire {
  return {
    providerId: 'acme',
    model: 'm',
    completion: 'ok',
    toolCall: 'ok',
    latencyMs: 10,
    error: null,
    testedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

/** The 状态 column is never a green 可用 for a provider that fails every call (review of #521), and
 *  never green for one nobody has tested (audit P0-2). */
describe('providerStatus', () => {
  it.each([
    ['disabled', provider({ enabled: false, credentialInvalid: true }), null],
    ['key_invalid', provider({ credentialInvalid: true }), null],
    ['key_missing', provider({ credentialPresent: false, credentialSource: 'none' }), null],
    ['url_unsafe', provider({ upstreamBaseUrl: 'https://user:pw@api.example.invalid' }), null],
    [
      'key_rejected',
      provider(),
      test({ completion: 'error', toolCall: 'skipped', error: 'HTTP 401: bad key' }),
    ],
    [
      'test_failed',
      provider(),
      test({ completion: 'error', toolCall: 'skipped', error: 'HTTP 500' }),
    ],
    ['tools_failed', provider(), test({ toolCall: 'error', error: 'HTTP 400: no tools' })],
    ['ok', provider(), test()],
    ['untested', provider(), null],
  ] as const)('%s', (kind, p, lastTest) => {
    const status = providerStatus(p, lastTest);
    expect(status.kind).toBe(kind);
    expect(status.tone === 'ok').toBe(kind === 'ok');
    expect(status.usability === 'blocked').toBe(!['ok', 'untested', 'tools_failed'].includes(kind));
    // The pinned column is 140 px: the short labels stay short in both languages.
    expect(status.zh.length).toBeLessThanOrEqual(6);
    expect(status.en.length).toBeLessThanOrEqual(12);
  });

  it('ignores a test the provider has changed since, or for a model no longer listed', () => {
    const failed = test({ completion: 'error', toolCall: 'skipped', error: 'HTTP 401' });
    expect(providerStatus(provider({ updatedAt: '2026-10-03T00:00:00.000Z' }), failed).kind).toBe(
      'untested',
    );
    expect(providerStatus(provider(), { ...failed, model: 'gone' }).kind).toBe('untested');
  });
});
