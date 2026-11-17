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
const en: Translate = (_zhText, enText) => enText;

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
    expect(normalizeBaseUrl('http://192.0.2.5:8000/')).toEqual({
      value: 'http://192.0.2.5:8000',
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
    expect(providerIdFromUrl('https://api.moonshot.cn/v1')).toBe('moonshotai-cn');
    expect(providerIdFromUrl('https://relay.example.com')).toBe('example');
  });

  it('explains upstream failures in words', () => {
    expect(explainUpstreamError('HTTP 401: invalid', zh)).toContain('密钥');
    expect(explainUpstreamError('HTTP 404: model not found', zh)).toContain('拼错');
    // P1-1: fetching the model list names no model — a 404 there is a missing endpoint.
    const listing = explainUpstreamError('HTTP 404: not found', zh, 'model_list');
    expect(listing).toContain('模型列表接口');
    expect(listing).not.toContain('拼错');
    expect(explainUpstreamError('HTTP 429: slow down', zh)).toContain('限流');
    expect(
      explainUpstreamError('completion request failed: TypeError: fetch failed', zh),
    ).toContain('连不上上游');
    expect(explainUpstreamError('tool-call response carried no call of "ping"', zh)).toContain(
      '工具调用',
    );
    expect(explainUpstreamError(null, zh)).toBeNull();
  });

  // Legacy 795: llm-proxy says an upstream redirect's status and where it pointed (#1344).
  it('explains a redirect llm-proxy did not follow, by where it pointed', () => {
    const advice =
      "llm-proxy does not follow redirects (the provider key would go along): set the provider's Base URL to the final address.";
    const elsewhere = explainUpstreamError(
      `GET /v1/models responded 301, a redirect to "https://api.example.net/***/models". ${advice}`,
      zh,
      'model_list',
    );
    expect(elsewhere).toBe(
      '上游返回 301 重定向，转到另一个地址 https://api.example.net/***/models。llm-proxy 不会跟着重定向走，否则密钥会被一起发到那个地址。常见于 http 被转到 https、服务换了域名，或中转要求先登录。确认这个地址可信后，把 Base URL 改成它的源站（不带 /v1）。',
    );
    expect(elsewhere).not.toContain('连不上上游');
    const samePath = explainUpstreamError(
      `POST /v1/messages responded 308, a redirect to "/api/v1/messages". ${advice}`,
      zh,
      'completion',
    );
    expect(samePath).toContain('上游返回 308 重定向，转到同一站点的 /api/v1/messages');
    expect(samePath).toContain('路径写法不对');
    // A target llm-proxy shows with an escaped quote reads back as it was.
    expect(
      explainUpstreamError(`upstream responded 307, a redirect to "/a\\"b". ${advice}`, en),
    ).toContain('a redirect to /a"b on the same site');
    for (const where of ['nowhere (no Location header)', 'an unparseable Location header']) {
      expect(
        explainUpstreamError(`upstream responded 302, a redirect to ${where}. ${advice}`, zh),
      ).toBe('上游返回 302 重定向，却没有说转到哪里：检查 Base URL 是否写对。');
    }
    // Before #1344 a redirect failed as a bare fetch error: still read as unreachable.
    expect(
      explainUpstreamError('model list request failed: TypeError: fetch failed', zh),
    ).toContain('连不上上游');
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
