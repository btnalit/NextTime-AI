import { readFileSync } from 'node:fs';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { describe, expect, it } from 'vitest';

/**
 * The console's provider presets (web `lib/provider-form.ts` `PROVIDER_PRESETS`) default the
 * provider id to pi's own provider name for that vendor. The agent's models.json names each
 * provider by that id and points `baseUrl` at llm-proxy, so the id is the only thing pi's
 * OpenAI-compat vendor detection (`max_tokens` field, thinking-parameter format, `store`) can
 * recognise. A pi upgrade that renames a provider, or starts shipping one for a vendor listed
 * below as unknown, fails here so the preset is realigned. Read as text: web is a separate
 * package without a pi dependency, and the preset ids are plain literals.
 */
const PRESETS_SOURCE = readFileSync(
  new URL('../../web/src/lib/provider-form.ts', import.meta.url),
  'utf8',
);

/** Vendors pi 1.1.0 has no built-in provider for — generic OpenAI defaults apply to them. */
const NOT_IN_PI = new Set(['dashscope', 'siliconflow']);

function presetIds(): string[] {
  const block = PRESETS_SOURCE.slice(PRESETS_SOURCE.indexOf('export const PROVIDER_PRESETS'));
  const body = block.slice(0, block.indexOf('\n];'));
  return [...body.matchAll(/^\s+id: '([a-z0-9-]+)',$/gm)].map((match) => match[1] as string);
}

describe('console provider presets vs pi built-in provider names', () => {
  it('finds the presets', () => {
    expect(presetIds()).toEqual([
      'anthropic',
      'openai',
      'deepseek',
      'openrouter',
      'moonshotai-cn',
      'dashscope',
      'siliconflow',
    ]);
  });

  it("every preset id is pi's provider name, or a vendor pi does not know", () => {
    const pi: ReadonlySet<string> = new Set<string>(getBuiltinProviders());
    for (const id of presetIds()) {
      if (NOT_IN_PI.has(id)) expect(pi.has(id), `pi now ships "${id}"`).toBe(false);
      else expect(pi.has(id), `pi has no provider "${id}"`).toBe(true);
    }
  });
});
