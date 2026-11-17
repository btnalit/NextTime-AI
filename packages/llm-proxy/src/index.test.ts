import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDLE_SIGNING_ALG, INTERNAL_TOKEN_FILE_ENV, InternalTokenError } from '@nexttime/shared';
import { exportSPKI, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProxyConfig } from './config.js';
import { loadConfig } from './config.js';
import type { LlmProxyApp } from './index.js';
import { VERSION, startLlmProxy } from './index.js';
import { TestedKeys } from './tested-keys.js';

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

    it('S6-B: loads the console-managed provider store next to the yaml and merges it into the catalog', async () => {
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
      const storeFile = join(dir, 'state', 'providers.json');
      mkdirSync(join(dir, 'state'));
      writeFileSync(
        storeFile,
        JSON.stringify({
          version: 1,
          providers: {
            acme: {
              api: 'anthropic-messages',
              upstream_base_url: 'https://acme.example.invalid',
              api_key_env: 'ACME_KEY',
              auth: { header: 'x-api-key' },
              models: [{ id: 'acme-model' }],
              enabled: true,
              created_at: '2026-09-19T00:00:00.000Z',
              updated_at: '2026-09-19T00:00:00.000Z',
            },
          },
        }),
      );

      const { publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const handlePubFile = join(dir, 'handle.pub');
      writeFileSync(handlePubFile, await exportSPKI(publicKey));

      const config: LlmProxyConfig = {
        ...loadConfig({
          LLM_PROVIDERS_FILE: providersFile,
          HANDLE_PUBLIC_KEY_FILE: handlePubFile,
          LLM_PROVIDER_STORE_FILE: storeFile,
          MODELS_JSON_OUT_FILE: join(dir, 'models.json'),
        }),
        port: 0,
      };

      app = await startLlmProxy(config);
      expect(app.catalog.resolve().map((p) => [p.id, p.source])).toEqual([
        ['example', 'file'],
        ['acme', 'store'],
      ]);
      // Never written at startup (deploy/accept/docker-compose.fake.yml relies on this).
      expect(existsSync(join(dir, 'models.json'))).toBe(false);
    });

    it('legacy 202: a test recorded with a key file the restart rotated is not shown; the same key shows it again', async () => {
      dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-index-'));
      const root = dir;
      const providersFile = join(root, 'llm-providers.yaml');
      writeFileSync(providersFile, 'providers: {}\n');
      const stateDir = join(root, 'state');
      mkdirSync(stateDir);
      const testedAt = '2026-11-17T00:00:00.000Z';
      writeFileSync(
        join(stateDir, 'providers.json'),
        JSON.stringify({
          version: 1,
          providers: {
            acme: {
              api: 'openai-completions',
              upstream_base_url: 'https://acme.example.invalid',
              api_key_env: 'ACME_KEY',
              auth: { header: 'authorization', scheme: 'Bearer' },
              models: [{ id: 'acme-model' }],
              enabled: true,
              created_at: '2026-11-16T00:00:00.000Z',
              updated_at: '2026-11-16T00:00:00.000Z',
              last_test: {
                model: 'acme-model',
                completion: 'ok',
                tool_call: 'ok',
                latency_ms: 42,
                error: null,
                tested_at: testedAt,
              },
            },
          },
        }),
      );
      // The previous run tested acme with this key and wrote it down.
      const testedKey = `sk-${randomUUID()}`;
      const previous = new TestedKeys(join(stateDir, 'tested-keys.json'), () => {});
      await previous.load();
      await previous.record('acme', testedAt, testedKey);
      // A crashed writer's temp copy, which startup removes like the other state files'.
      const staleTemp = join(stateDir, `.tested-keys.json.${randomUUID()}.tmp`);
      writeFileSync(staleTemp, '{}');

      const { publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const handlePubFile = join(root, 'handle.pub');
      writeFileSync(handlePubFile, await exportSPKI(publicKey));
      const keysDir = join(root, 'keys');
      mkdirSync(keysDir);
      const start = async (key: string) => {
        writeFileSync(join(keysDir, 'ACME_KEY'), key);
        return startLlmProxy({
          ...loadConfig({
            LLM_PROVIDERS_FILE: providersFile,
            HANDLE_PUBLIC_KEY_FILE: handlePubFile,
            LLM_PROVIDER_STORE_FILE: join(stateDir, 'providers.json'),
            LLM_KEY_STORE_FILE: join(stateDir, 'keys.json'),
            LLM_PROVIDER_KEYS_DIR: keysDir,
            MODELS_JSON_OUT_FILE: join(root, 'models.json'),
          }),
          port: 0,
        });
      };
      const acmeTest = (running: LlmProxyApp) =>
        running.catalog.resolve().find((p) => p.id === 'acme')?.lastTest ?? null;

      // Rotated by editing the key file and restarting: the old result says nothing about it.
      app = await start(`sk-${randomUUID()}`);
      expect(acmeTest(app)).toBeNull();
      expect(existsSync(staleTemp)).toBe(false);
      await app.close();
      app = undefined;

      app = await start(testedKey);
      expect(acmeTest(app)).toMatchObject({ completion: 'ok', tested_at: testedAt });
    });

    it('fails fast when KERNEL_URL is configured but the internal-plane token file is missing (fix/internal-plane-auth)', async () => {
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

      const config: LlmProxyConfig = {
        ...loadConfig({
          LLM_PROVIDERS_FILE: providersFile,
          HANDLE_PUBLIC_KEY_FILE: handlePubFile,
          KERNEL_URL: 'http://kernel.internal:8080',
          [INTERNAL_TOKEN_FILE_ENV]: join(dir, 'does-not-exist', 'internal.token'),
        }),
        port: 0,
      };

      await expect(startLlmProxy(config)).rejects.toThrow(InternalTokenError);
    });
  });
});
