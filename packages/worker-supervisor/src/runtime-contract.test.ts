import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMAGE_RUNTIME_CONTRACT_LABEL, RUNTIME_CONTRACT_VERSION } from './runtime-contract.js';

describe('runtime contract', () => {
  // The two halves of the contract are bumped by hand together (runtime-contract.ts header); a
  // build whose label lags the supervisor would be refused on every spawn.
  it('is the version the runtime image’s Dockerfile labels itself with', () => {
    const dockerfile = readFileSync(
      join(import.meta.dirname, '../../../deploy/worker-runtime/Dockerfile'),
      'utf8',
    );
    const labels = [...dockerfile.matchAll(/^LABEL\s+(\S+)="([^"]*)"\s*$/gm)].filter(
      ([, key]) => key === IMAGE_RUNTIME_CONTRACT_LABEL,
    );
    expect(labels.map(([, , value]) => value)).toEqual([RUNTIME_CONTRACT_VERSION]);
  });
});
