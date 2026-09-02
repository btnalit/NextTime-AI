import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDLE_SIGNING_ALG } from '@nexttime/shared';
import { exportSPKI, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProxyConfig } from './config.js';
import { loadConfig } from './config.js';
import type { LlmProxyApp } from './index.js';
import { VERSION, startLlmProxy } from './index.js';

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      })
      .on('error', reject);
  });
}

function addressPort(app: LlmProxyApp): number {
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  return address.port;
}

describe('@nexttime/llm-proxy', () => {
  it('exposes a semantic version', () => {
    expect(VERSION).toBe('0.1.0');
  });

  describe('startLlmProxy', () => {
    let app: LlmProxyApp | undefined;
    let dir: string | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      }
    });

    it('wires config, llm-providers.yaml, and the Handle public key, and answers /healthz', async () => {
      dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-index-'));

      const providersFile = join(dir, 'llm-providers.yaml');
      writeFileSync(
        providersFile,
        [
          'providers:',
          '  example:',
          '    api: openai-completions',
          '    upstream_base_url: https://api.example.invalid',
          '    api_key_env: EXAMPLE_API_KEY',
          '    auth:',
          '      header: authorization',
          '      scheme: Bearer',
          '    models:',
          '      - id: example-model',
          '',
        ].join('\n'),
      );

      const { publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const handlePubFile = join(dir, 'handle.pub');
      writeFileSync(handlePubFile, await exportSPKI(publicKey));

      // loadConfig() treats '0' as invalid and falls back to the real default port — set the
      // ephemeral port directly on the loaded config instead, so this test never binds a fixed,
      // possibly-in-use port (same pattern as packages/egress-proxy/src/index.test.ts).
      const config: LlmProxyConfig = {
        ...loadConfig({ LLM_PROVIDERS_FILE: providersFile, HANDLE_PUBLIC_KEY_FILE: handlePubFile }),
        port: 0,
      };

      app = await startLlmProxy(config);

      const health = await getJson(addressPort(app), '/healthz');
      expect(health).toEqual({ status: 200, body: { status: 'ok' } });
    });
  });
});
