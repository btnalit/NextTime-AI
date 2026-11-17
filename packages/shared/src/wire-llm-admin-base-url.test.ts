import { describe, expect, it } from 'vitest';
import {
  LLM_PROVIDER_UPSTREAM_BASE_URL_MAX_CHARS,
  LlmProviderUpstreamBaseUrlWireSchema,
  upstreamBaseUrlProblem,
} from './wire/llm-admin.js';

/** #510 review: llm-proxy appends `/v1/…` to the base by concatenation, so the base must not be
 *  able to move that path into a query or fragment, nor carry userinfo or a non-http scheme. */
describe('upstreamBaseUrlProblem', () => {
  it('accepts bare http(s) bases, with a port, a path prefix, or a LAN host', () => {
    for (const ok of [
      'https://api.openai.com',
      'https://api.openai.com/',
      'https://openrouter.ai/api',
      'https://dashscope.aliyuncs.com/compatible-mode',
      'http://192.0.2.10:11434',
      'http://llm.example.invalid:8000/proxy',
    ]) {
      expect(upstreamBaseUrlProblem(ok), ok).toBeNull();
      expect(LlmProviderUpstreamBaseUrlWireSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('refuses a query, a fragment (even empty), userinfo, other schemes and non-URLs', () => {
    expect(upstreamBaseUrlProblem('http://h/a?x=')).toMatch(/query/);
    expect(upstreamBaseUrlProblem('http://h/a?')).toMatch(/query/);
    expect(upstreamBaseUrlProblem('http://h/a#frag')).toMatch(/fragment/);
    expect(upstreamBaseUrlProblem('http://h/a#')).toMatch(/fragment/);
    expect(upstreamBaseUrlProblem('https://u:p@h')).toMatch(/user name/);
    expect(upstreamBaseUrlProblem('https://u@h')).toMatch(/user name/);
    expect(upstreamBaseUrlProblem('ftp://h')).toMatch(/http/);
    expect(upstreamBaseUrlProblem('file:///etc/passwd')).toMatch(/http/);
    expect(upstreamBaseUrlProblem('not a url')).toMatch(/absolute/);
    expect(LlmProviderUpstreamBaseUrlWireSchema.safeParse('http://h/a#').success).toBe(false);
  });
});

/** Legacy 151: an audit row carries the base, twice when a provider moves to another upstream, and
 *  the kernel refuses a row over its details limit. */
describe('LlmProviderUpstreamBaseUrlWireSchema length', () => {
  const base = (length: number) => {
    const prefix = 'https://llm.example.invalid/';
    return prefix + 'a'.repeat(length - prefix.length);
  };

  it('accepts a base of LLM_PROVIDER_UPSTREAM_BASE_URL_MAX_CHARS characters and refuses a longer one', () => {
    expect(LLM_PROVIDER_UPSTREAM_BASE_URL_MAX_CHARS).toBe(1024);
    const longest = base(LLM_PROVIDER_UPSTREAM_BASE_URL_MAX_CHARS);
    expect(longest).toHaveLength(1024);
    expect(LlmProviderUpstreamBaseUrlWireSchema.safeParse(longest).success).toBe(true);
    expect(LlmProviderUpstreamBaseUrlWireSchema.safeParse(`${longest}a`).success).toBe(false);
  });
});
