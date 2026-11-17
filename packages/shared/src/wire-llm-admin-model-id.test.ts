import { describe, expect, it } from 'vitest';
import {
  LLM_PROVIDER_MODEL_ID_MAX_CHARS,
  LlmProviderInputWireSchema,
  LlmProviderModelIdInputWireSchema,
  LlmProviderModelProbeInputWireSchema,
  LlmProviderTestInputWireSchema,
  LlmProviderUpstreamBaseUrlWireSchema,
  LlmProviderWireSchema,
} from './wire/llm-admin.js';

/** Legacy 151 (#1409 review by #501): Postgres `jsonb` refuses U+0000 and an unpaired surrogate,
 *  so a model id or base URL carrying one lost the kernel's platform audit row that names it (the
 *  kernel answered 500). Every write, probe and test takes such names out at the door. */
const REFUSED: Array<[string, string]> = [
  ['NUL', 'model\u0000x'],
  ['another C0 control', 'model\u0001x'],
  ['a tab', 'model\tx'],
  ['DEL', 'model\u007fx'],
  ['a lone high surrogate', 'model\ud800x'],
  ['a lone high surrogate at the end', 'model\ud83d'],
  ['a lone low surrogate', 'model\udc00x'],
  ['two high surrogates', 'model\ud800\ud800'],
];

describe('LlmProviderModelIdInputWireSchema', () => {
  it('accepts ordinary ids, non-ASCII text and paired surrogates, up to 200 characters', () => {
    for (const ok of [
      'gpt-4o',
      'anthropic/claude-x:beta',
      '通义千问-max',
      'model-😀',
      'm'.repeat(LLM_PROVIDER_MODEL_ID_MAX_CHARS),
    ]) {
      expect(LlmProviderModelIdInputWireSchema.safeParse(ok).success, ok).toBe(true);
    }
    expect(LlmProviderModelIdInputWireSchema.safeParse('').success).toBe(false);
    expect(
      LlmProviderModelIdInputWireSchema.safeParse('m'.repeat(LLM_PROVIDER_MODEL_ID_MAX_CHARS + 1))
        .success,
    ).toBe(false);
  });

  it.each(REFUSED)('refuses %s', (_, id) => {
    expect(LlmProviderModelIdInputWireSchema.safeParse(id).success).toBe(false);
  });

  it.each(REFUSED)('a create, a probe and a test refuse %s in a model id', (_, id) => {
    const provider = {
      id: 'acme',
      api: 'openai-completions',
      upstreamBaseUrl: 'https://acme.example.invalid',
      authHeader: 'authorization',
      models: [{ id: 'ok', displayName: null, cost: null }],
    };
    expect(LlmProviderInputWireSchema.safeParse(provider).success).toBe(true);
    expect(
      LlmProviderInputWireSchema.safeParse({
        ...provider,
        models: [...provider.models, { id, displayName: null, cost: null }],
      }).success,
    ).toBe(false);
    const probe = { ...provider, key: 'sk-probe', models: ['ok'] };
    expect(LlmProviderModelProbeInputWireSchema.safeParse(probe).success).toBe(true);
    expect(
      LlmProviderModelProbeInputWireSchema.safeParse({ ...probe, models: ['ok', id] }).success,
    ).toBe(false);
    expect(LlmProviderTestInputWireSchema.safeParse({ model: 'ok' }).success).toBe(true);
    expect(LlmProviderTestInputWireSchema.safeParse({ model: id }).success).toBe(false);
  });

  it('a test still takes a model id of any length (an operator file sets no cap)', () => {
    expect(LlmProviderTestInputWireSchema.safeParse({ model: 'm'.repeat(500) }).success).toBe(true);
  });

  it('a probe still trims each id before checking it', () => {
    const parsed = LlmProviderModelProbeInputWireSchema.parse({
      id: 'acme',
      api: 'openai-completions',
      upstreamBaseUrl: 'https://acme.example.invalid',
      authHeader: 'authorization',
      key: 'sk-probe',
      models: ['  gpt-4o \n'],
    });
    expect(parsed.models).toEqual(['gpt-4o']);
  });

  it('a stored provider whose model id predates the rule still reads', () => {
    const row = {
      id: 'acme',
      displayName: 'Acme',
      api: 'openai-completions',
      upstreamBaseUrl: 'https://acme.example.invalid/\u0000',
      authHeader: 'authorization',
      authScheme: 'Bearer',
      apiKeyEnv: null,
      credentialPresent: false,
      credentialSource: 'none',
      enabled: true,
      source: 'store',
      overridesFile: false,
      models: [{ id: 'old\u0000id', displayName: null, cost: null }],
      lastTest: null,
      createdAt: null,
      updatedAt: null,
    };
    const parsed = LlmProviderWireSchema.safeParse(row);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});

describe('LlmProviderUpstreamBaseUrlWireSchema characters', () => {
  it.each(REFUSED.filter(([name]) => name !== 'a tab'))(
    'refuses %s in the base, which `new URL` would encode and pass',
    (_, text) => {
      const raw = `https://acme.example.invalid/${text}`;
      expect(() => new URL(raw)).not.toThrow();
      expect(LlmProviderUpstreamBaseUrlWireSchema.safeParse(raw).success).toBe(false);
    },
  );

  it('drops a tab or newline as `new URL` does, so none is stored', () => {
    expect(
      LlmProviderUpstreamBaseUrlWireSchema.parse('https://acme.example.invalid/v\t1\r\n'),
    ).toBe('https://acme.example.invalid/v1');
  });

  it('accepts a path with non-ASCII text', () => {
    expect(
      LlmProviderUpstreamBaseUrlWireSchema.safeParse('https://acme.example.invalid/模型/😀')
        .success,
    ).toBe(true);
  });
});
