import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from './config.js';
import {
  buildOutboundHeaders,
  buildOutboundSearch,
  stripProviderServerTools,
} from './outbound-policy.js';

/**
 * outbound-policy.test: R-30 (D-29) per provider kind — which inbound headers, query parameters
 * and tool definitions reach the provider. The end-to-end view (a fake upstream seeing the
 * narrowed request, and an untouched request forwarded byte-for-byte) is in proxy.test.ts.
 */

const openAiCompletions: ProviderConfig = {
  api: 'openai-completions',
  upstream_base_url: 'https://openai.example.invalid',
  api_key_env: 'OPENAI_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
  models: [{ id: 'gpt-example' }],
};
const openAiResponses: ProviderConfig = { ...openAiCompletions, api: 'openai-responses' };
const anthropic: ProviderConfig = {
  api: 'anthropic-messages',
  upstream_base_url: 'https://anthropic.example.invalid',
  api_key_env: 'ANTHROPIC_KEY',
  auth: { header: 'x-api-key' },
  models: [{ id: 'claude-example' }],
};

/** Roughly what pi's SDK clients send, plus everything an agent could add. */
const inboundHeaders = {
  host: 'llm-proxy:8082',
  'content-type': 'application/json; charset=utf-8',
  'content-length': '123',
  accept: 'application/json',
  'accept-encoding': 'gzip',
  connection: 'keep-alive',
  'user-agent': 'OpenAI/JS 7.19.0',
  'x-stainless-os': 'Linux',
  'x-stainless-retry-count': '0',
  'openai-organization': 'org-other',
  'openai-project': 'proj-other',
  'x-correlation-id': 'turn-1',
  'x-forwarded-for': '10.0.0.1',
  cookie: 'a=b',
  'proxy-authorization': 'Basic Zm9vOmJhcg==',
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
};

function headerMap(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

describe('buildOutboundHeaders — an allow-list per api kind (R-30)', () => {
  it('openai kinds: accept, content-type, identity encoding and the real key — nothing the agent chose', () => {
    for (const provider of [openAiCompletions, openAiResponses]) {
      const { headers, droppedBetas } = buildOutboundHeaders(
        { ...inboundHeaders, authorization: 'Bearer handle-token', 'x-api-key': 'smuggled' },
        provider,
        'sk-real',
      );
      expect(headerMap(headers)).toEqual({
        accept: 'application/json',
        'accept-encoding': 'identity',
        authorization: 'Bearer sk-real',
        'content-type': 'application/json',
      });
      expect(droppedBetas).toEqual([]);
    }
  });

  it('anthropic: anthropic-version and the allow-listed beta values; MCP / web-fetch / code-execution betas are dropped and reported', () => {
    const { headers, droppedBetas } = buildOutboundHeaders(
      {
        ...inboundHeaders,
        'x-api-key': 'handle-token',
        authorization: 'Bearer smuggled',
        'anthropic-beta':
          'fine-grained-tool-streaming-2025-05-14, mcp-client-2025-04-04,web-fetch-2025-09-10,interleaved-thinking-2025-05-14,code-execution-2025-08-25',
      },
      anthropic,
      'sk-ant-real',
    );
    expect(headerMap(headers)).toEqual({
      accept: 'application/json',
      'accept-encoding': 'identity',
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-real',
    });
    expect(droppedBetas).toEqual([
      'mcp-client-2025-04-04',
      'web-fetch-2025-09-10',
      'code-execution-2025-08-25',
    ]);
  });

  it('anthropic: no anthropic-beta header at all when every value is dropped', () => {
    const { headers, droppedBetas } = buildOutboundHeaders(
      { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mcp-client-2025-11-20' },
      anthropic,
      'sk-ant-real',
    );
    expect(headers.has('anthropic-beta')).toBe(false);
    expect(droppedBetas).toEqual(['mcp-client-2025-11-20']);
  });

  it('anthropic-beta is never forwarded to an OpenAI kind', () => {
    const { headers } = buildOutboundHeaders(
      { 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' },
      openAiCompletions,
      'sk-real',
    );
    expect(headers.has('anthropic-beta')).toBe(false);
  });
});

describe('buildOutboundSearch (R-30)', () => {
  it('keeps only `beta` for anthropic (the SDK’s client.beta.messages) and nothing for the OpenAI kinds', () => {
    const params = new URLSearchParams('beta=true&api-version=1&callback=https://attacker');
    expect(buildOutboundSearch('anthropic-messages', params)).toBe('?beta=true');
    expect(buildOutboundSearch('openai-completions', params)).toBe('');
    expect(buildOutboundSearch('openai-responses', params)).toBe('');
    expect(buildOutboundSearch('anthropic-messages', new URLSearchParams())).toBe('');
  });
});

const functionTool = {
  type: 'function',
  function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
};
const customTool = { type: 'custom', custom: { name: 'patch', description: 'apply a patch' } };

describe('stripProviderServerTools — openai-completions', () => {
  it('keeps function and custom tools, strips vendor server tools and the parameters that switch search on', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-example',
      messages: [
        { role: 'system', content: 'hi' },
        {
          role: 'system',
          tools: [functionTool, { type: 'builtin_function', function: { name: '$web_search' } }],
        },
        { role: 'user', content: 'search for it' },
      ],
      tools: [functionTool, { type: 'web_search', web_search: { enable: true } }, customTool],
      tool_choice: 'auto',
      web_search_options: { search_context_size: 'high' },
      plugins: [{ id: 'web' }],
      enable_search: true,
      search_parameters: { mode: 'on' },
      stream: true,
    };
    const result = stripProviderServerTools('openai-completions', body);
    expect(result).toEqual({
      strippedTools: ['web_search', 'builtin_function'],
      strippedParams: ['web_search_options', 'plugins', 'enable_search', 'search_parameters'],
    });
    expect(body.tools).toEqual([functionTool, customTool]);
    expect((body.messages as Array<{ tools?: unknown }>)[1]?.tools).toEqual([functionTool]);
    expect(body).toMatchObject({ tool_choice: 'auto', stream: true });
    expect(Object.keys(body).sort()).toEqual([
      'messages',
      'model',
      'stream',
      'tool_choice',
      'tools',
    ]);
  });

  it('a pi-shaped request (function tools, an empty tools list for tool history) is left exactly as sent', () => {
    const body = {
      model: 'gpt-example',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [functionTool],
      tool_choice: 'auto',
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      provider: { order: ['x'] },
    };
    const before = structuredClone(body);
    expect(stripProviderServerTools('openai-completions', body)).toEqual({
      strippedTools: [],
      strippedParams: [],
    });
    expect(body).toEqual(before);
    const empty: Record<string, unknown> = { model: 'gpt-example', messages: [], tools: [] };
    expect(stripProviderServerTools('openai-completions', empty).strippedTools).toEqual([]);
    expect(empty.tools).toEqual([]);
  });

  it('removes a tool entry with no type or a non-object entry (the OpenAI kinds always type their tools)', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-example',
      tools: [functionTool, { function: { name: 'x' } }, 'web_search'],
    };
    expect(stripProviderServerTools('openai-completions', body).strippedTools).toEqual(['(none)']);
    expect(body.tools).toEqual([functionTool]);
  });
});

describe('stripProviderServerTools — openai-responses', () => {
  const responsesFunction = { type: 'function', name: 'read', parameters: { type: 'object' } };
  const responsesCustom = { type: 'custom', name: 'patch' };

  it('keeps function and custom tools; strips mcp, web search, code interpreter, computer use, file search, image generation, shell', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-example',
      input: [
        { role: 'user', content: 'hi' },
        {
          type: 'tool_search_output',
          call_id: 'c1',
          execution: 'client',
          tools: [
            { ...responsesFunction, defer_loading: true },
            { type: 'mcp', server_label: 'x', server_url: 'https://attacker.example' },
          ],
        },
        { type: 'additional_tools', role: 'developer', tools: [{ type: 'web_search' }] },
      ],
      tools: [
        responsesFunction,
        { type: 'mcp', server_label: 'exfil', server_url: 'https://attacker.example/mcp' },
        { type: 'web_search_preview' },
        { type: 'code_interpreter', container: { type: 'auto' } },
        { type: 'computer_use_preview', display_width: 1024 },
        { type: 'file_search', vector_store_ids: ['vs_1'] },
        { type: 'image_generation' },
        { type: 'local_shell' },
        responsesCustom,
      ],
      include: ['reasoning.encrypted_content'],
    };
    const result = stripProviderServerTools('openai-responses', body);
    expect(result.strippedTools).toEqual([
      'mcp',
      'web_search_preview',
      'code_interpreter',
      'computer_use_preview',
      'file_search',
      'image_generation',
      'local_shell',
      'web_search',
    ]);
    expect(result.strippedParams).toEqual([]);
    expect(body.tools).toEqual([responsesFunction, responsesCustom]);
    const input = body.input as Array<{ tools?: unknown }>;
    expect(input[1]?.tools).toEqual([{ ...responsesFunction, defer_loading: true }]);
    expect(input[2]?.tools).toEqual([]);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
  });

  it('a plain string input and function-only tools are untouched', () => {
    const body = { model: 'gpt-example', input: 'hi', tools: [responsesFunction], stream: true };
    const before = structuredClone(body);
    expect(stripProviderServerTools('openai-responses', body)).toEqual({
      strippedTools: [],
      strippedParams: [],
    });
    expect(body).toEqual(before);
  });
});

describe('stripProviderServerTools — anthropic-messages', () => {
  const clientTool = { name: 'read', description: 'read a file', input_schema: { type: 'object' } };
  const deferred = {
    name: '__placeholder__',
    input_schema: { type: 'object' },
    defer_loading: true,
  };

  it('keeps untyped and custom tools; strips server tools, Anthropic-defined tools, the MCP connector and the container', () => {
    const body: Record<string, unknown> = {
      model: 'claude-example',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        clientTool,
        deferred,
        { type: 'custom', name: 'patch', input_schema: { type: 'object' } },
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20250910', name: 'web_fetch' },
        { type: 'code_execution_20250825', name: 'code_execution' },
        { type: 'mcp_toolset', mcp_server_name: 'exfil' },
        { type: 'computer_20250124', name: 'computer', display_width_px: 1024 },
        { type: 'bash_20250124', name: 'bash' },
      ],
      mcp_servers: [{ type: 'url', url: 'https://attacker.example/mcp', name: 'exfil' }],
      container: { skills: [{ type: 'anthropic', skill_id: 'pptx' }] },
      tool_choice: { type: 'auto' },
    };
    const result = stripProviderServerTools('anthropic-messages', body);
    expect(result).toEqual({
      strippedTools: [
        'web_search_20250305',
        'web_fetch_20250910',
        'code_execution_20250825',
        'mcp_toolset',
        'computer_20250124',
        'bash_20250124',
      ],
      strippedParams: ['mcp_servers', 'container'],
    });
    expect(body.tools).toEqual([
      clientTool,
      deferred,
      { type: 'custom', name: 'patch', input_schema: { type: 'object' } },
    ]);
    expect(body).not.toHaveProperty('mcp_servers');
    expect(body).not.toHaveProperty('container');
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('a pi-shaped request (untyped tools, thinking, metadata) is untouched', () => {
    const body = {
      model: 'claude-example',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [clientTool, deferred],
      thinking: { type: 'adaptive' },
      metadata: { user_id: 'x' },
      stream: true,
    };
    const before = structuredClone(body);
    expect(stripProviderServerTools('anthropic-messages', body)).toEqual({
      strippedTools: [],
      strippedParams: [],
    });
    expect(body).toEqual(before);
  });

  it('bounds what one request can put in the log line', () => {
    const body: Record<string, unknown> = {
      model: 'claude-example',
      tools: Array.from({ length: 50 }, (_, i) => ({ type: `server_${i}_${'x'.repeat(100)}` })),
    };
    const { strippedTools } = stripProviderServerTools('anthropic-messages', body);
    expect(strippedTools).toHaveLength(20);
    expect(strippedTools.every((value) => value.length <= 64)).toBe(true);
    expect(body.tools).toEqual([]);
  });
});
