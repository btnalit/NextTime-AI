import { describe, expect, it } from 'vitest';
import { buildRagflowGate } from './index.js';

describe('buildRagflowGate', () => {
  it('throws when RAGFLOW_BASE_URL is not set', async () => {
    await expect(buildRagflowGate({} as NodeJS.ProcessEnv)).rejects.toThrow(/RAGFLOW_BASE_URL/);
  });

  it('loads the bundled manifest.json and exposes every operation via describe_operations', async () => {
    const env = {
      RAGFLOW_BASE_URL: 'https://ragflow.example.invalid',
      GATE_CREDENTIAL_RAGFLOW_API_KEY: 'test-key',
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
