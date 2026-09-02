import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EgressProxyConfig } from './config.js';
import { loadConfig } from './config.js';
import type { EgressProxyApp } from './index.js';
import { VERSION, startEgressProxy } from './index.js';

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

describe('@nexttime/egress-proxy', () => {
  it('exposes a semantic version', () => {
    expect(VERSION).toBe('0.1.0');
  });

  describe('startEgressProxy', () => {
    let app: EgressProxyApp | undefined;
    let dir: string | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      }
    });

    it('wires config, the proxy server, and the admin server, and answers /healthz on loopback', async () => {
      dir = mkdtempSync(join(tmpdir(), 'egress-proxy-index-'));
      const sourceMapFile = join(dir, 'sources.json');
      writeFileSync(sourceMapFile, JSON.stringify({}));
      // loadConfig() treats '0' as an invalid PROXY_PORT/ADMIN_PORT (parseIntEnv requires > 0)
      // and falls back to the real defaults 3128/3129 — set the ephemeral port directly on the
      // loaded config instead, so this test never binds a fixed, possibly-in-use port.
      const config: EgressProxyConfig = {
        ...loadConfig({ SOURCE_MAP_FILE: sourceMapFile }),
        proxyPort: 0,
        adminPort: 0,
      };

      app = await startEgressProxy(config);

      const proxyAddress = app.proxyServer.address();
      const adminAddress = app.adminServer.address();
      if (proxyAddress === null || typeof proxyAddress === 'string') {
        throw new Error('expected a bound proxy address');
      }
      if (adminAddress === null || typeof adminAddress === 'string') {
        throw new Error('expected a bound admin address');
      }

      const health = await getJson(adminAddress.port, '/healthz');
      expect(health).toEqual({ status: 200, body: { status: 'ok' } });
    });
  });
});
