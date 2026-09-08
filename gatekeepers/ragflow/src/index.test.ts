import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRagflowGate } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'gatekeeper-ragflow-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tokenFile = join(dir, 'gate.token');
writeFileSync(tokenFile, `${'a'.repeat(40)}\n`);

describe('buildRagflowGate', () => {
  it('throws when RAGFLOW_BASE_URL is not set', async () => {
    await expect(buildRagflowGate({} as NodeJS.ProcessEnv)).rejects.toThrow(/RAGFLOW_BASE_URL/);
  });

  it('refuses to build without a readable gate auth token (review lane 5, P1-1)', async () => {
    const env = {
      RAGFLOW_BASE_URL: 'https://ragflow.example.invalid',
      GATE_CREDENTIAL_RAGFLOW_API_KEY: 'test-key',
      GATE_KERNEL_TOKEN_FILE: join(dir, 'missing.token'),
    } as unknown as NodeJS.ProcessEnv;
    await expect(buildRagflowGate(env)).rejects.toThrow(/gate auth token file/);
  });

  it('loads the bundled manifest.json and exposes every operation via describe_operations', async () => {
    const env = {
      RAGFLOW_BASE_URL: 'https://ragflow.example.invalid',
      GATE_CREDENTIAL_RAGFLOW_API_KEY: 'test-key',
      GATE_KERNEL_TOKEN_FILE: tokenFile,
    } as unknown as NodeJS.ProcessEnv;
    const { gate, app } = await buildRagflowGate(env);
    try {
      const ops = gate.describeOperations();
      expect(ops.map((op) => op.name).sort()).toEqual([
        'document.parse',
        'document.upload',
        'kb.documents',
        'kb.list',
        'retrieve',
      ]);
    } finally {
      await app.close();
    }
  });
});
