import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  explainUpstreamError,
  looksLikeSecret,
  normalizeBaseUrl,
  normalizeEnvName,
  providerIdFromUrl,
  slugifyProviderId,
} from './provider-form.js';

const zh: Translate = (zhText) => zhText;

describe('lib/provider-form', () => {
  it('normalizeEnvName turns typed or pasted names into the proxy’s form, never keeping a value', () => {
    expect(normalizeEnvName('deepseek_api_key')).toEqual({
      value: 'DEEPSEEK_API_KEY',
      note: 'normalized',
    });
    expect(normalizeEnvName('my-key.v2').value).toBe('MY_KEY_V2');
    expect(normalizeEnvName('$OPENAI_API_KEY').value).toBe('OPENAI_API_KEY');
    expect(normalizeEnvName('${OPENAI_API_KEY}').value).toBe('OPENAI_API_KEY');
    expect(normalizeEnvName('export FOO=sk-something')).toEqual({
      value: 'FOO',
      note: 'value-dropped',
    });
    expect(normalizeEnvName('OPENAI_API_KEY')).toEqual({ value: 'OPENAI_API_KEY', note: 'none' });
    expect(normalizeEnvName('sk-ant-api03-AbCdEfGh0123456789')).toEqual({
      value: '',
      note: 'secret',
    });
    expect(normalizeEnvName('')).toEqual({ value: '', note: 'none' });
  });

  it('looksLikeSecret: key prefixes and long mixed runs, not upper-case env names', () => {
    expect(looksLikeSecret('sk-proj-0123456789abcdef')).toBe(true);
    expect(looksLikeSecret('AIzaSyD0123456789abcdefgh')).toBe(true);
    expect(looksLikeSecret('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    expect(looksLikeSecret('SK_LIVE_OPENAI_API_KEY')).toBe(false);
    expect(looksLikeSecret('DEEPSEEK_API_KEY')).toBe(false);
    expect(looksLikeSecret('sk-short')).toBe(false);
  });

  it('normalizeBaseUrl strips endpoint paths and adds a scheme', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toEqual({
      value: 'https://api.openai.com',
      changed: 'suffix-stripped',
    });
    expect(normalizeBaseUrl('https://api.anthropic.com/v1/messages').value).toBe(
      'https://api.anthropic.com',
    );
    expect(normalizeBaseUrl('openrouter.ai/api/v1/chat/completions?x=1')).toEqual({
      value: 'https://openrouter.ai/api',
      changed: 'both',
    });
    expect(normalizeBaseUrl('http://10.0.0.5:8000/')).toEqual({
      value: 'http://10.0.0.5:8000',
      changed: 'none',
    });
    expect(normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1').value).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode',
    );
  });

  it('derives ids from names and hosts', () => {
    expect(slugifyProviderId('Moonshot (Kimi)')).toBe('moonshot-kimi');
    expect(slugifyProviderId('My_Relay.2')).toBe('my-relay-2');
    expect(slugifyProviderId('通义千问')).toBe('');
    expect(providerIdFromUrl('https://api.deepseek.com')).toBe('deepseek');
    expect(providerIdFromUrl('https://openrouter.ai/api')).toBe('openrouter');
  });

  it('explains upstream failures in words', () => {
    expect(explainUpstreamError('HTTP 401: invalid', zh)).toContain('密钥');
    expect(explainUpstreamError('HTTP 404: model not found', zh)).toContain('拼错');
    expect(explainUpstreamError('HTTP 429: slow down', zh)).toContain('限流');
    expect(
      explainUpstreamError('completion request failed: TypeError: fetch failed', zh),
    ).toContain('连不上上游');
    expect(explainUpstreamError('tool-call response carried no call of "ping"', zh)).toContain(
      '工具调用',
    );
    expect(explainUpstreamError(null, zh)).toBeNull();
  });

  // 4.7b host check: DeepSeek thinking mode refused the probe's forced tool_choice.
  it('tells a refused probe apart from a model that cannot call tools', () => {
    const stored = 'HTTP 400: Thinking mode does not support this tool_choice (request_id: ***)';
    expect(explainUpstreamError(stored, zh, 'tool_call')).toContain('不代表不能用工具');
    const refused =
      'HTTP 400: tools are not supported (retried with tool_choice auto after the forced tool_choice was rejected: HTTP 400: x)';
    expect(explainUpstreamError(refused, zh, 'tool_call')).toContain('不支持工具调用');
    expect(explainUpstreamError('HTTP 400: bad model', zh, 'completion')).toContain('请求参数');
    const prose =
      'tool-call response carried no call of "ping" (retried with tool_choice auto after the forced tool_choice was rejected: HTTP 400: x)';
    expect(explainUpstreamError(prose, zh, 'tool_call')).toContain('没有按要求发起工具调用');
    expect(explainUpstreamError('tool-call request failed: TypeError: fetch failed', zh)).toContain(
      '连不上上游',
    );
  });
});
