import { describe, expect, it } from 'vitest';
import { HUMAN_ATTESTATION_EVIDENCE_KIND } from './enums.js';
import {
  ARTIFACT_CONTENT_MAX_CHARS,
  MAX_ARTIFACTS_PER_CONTRACT,
  WorkerResultArtifactSchema,
  WorkerResultContractSchema,
  WorkerResultEvidenceSchema,
} from './worker-result.js';

/**
 * worker-result.test: S8 W5-A (leftover 74) — the `artifacts[].content` addition (durable text
 * content inlined in the contract, since the in-container `path` stops resolving to anything once
 * the WorkerRun's container exits) and its size/count caps.
 */
describe('WorkerResultArtifactSchema', () => {
  it('accepts a path-only artifact (content omitted — binary, or the Worker chose not to inline it)', () => {
    const result = WorkerResultArtifactSchema.safeParse({ path: '/workspace/report.md' });
    expect(result.success).toBe(true);
  });

  it('accepts a path + inlined content + description', () => {
    const result = WorkerResultArtifactSchema.safeParse({
      path: '/workspace/report.md',
      description: 'inventory report',
      content: '# Report\n\nfindings...',
    });
    expect(result.success).toBe(true);
  });

  it('rejects content over ARTIFACT_CONTENT_MAX_CHARS', () => {
    const result = WorkerResultArtifactSchema.safeParse({
      path: '/workspace/report.md',
      content: 'x'.repeat(ARTIFACT_CONTENT_MAX_CHARS + 1),
    });
    expect(result.success).toBe(false);
  });

  it('accepts content exactly at the cap', () => {
    const result = WorkerResultArtifactSchema.safeParse({
      path: '/workspace/report.md',
      content: 'x'.repeat(ARTIFACT_CONTENT_MAX_CHARS),
    });
    expect(result.success).toBe(true);
  });
});

describe('WorkerResultContractSchema — artifacts array cap', () => {
  function contractWithArtifacts(count: number) {
    return {
      summary: 'ok',
      artifacts: Array.from({ length: count }, (_, i) => ({ path: `/workspace/f${i}.md` })),
    };
  }

  it('accepts up to MAX_ARTIFACTS_PER_CONTRACT artifacts', () => {
    const result = WorkerResultContractSchema.safeParse(
      contractWithArtifacts(MAX_ARTIFACTS_PER_CONTRACT),
    );
    expect(result.success).toBe(true);
  });

  it('rejects one artifact over MAX_ARTIFACTS_PER_CONTRACT', () => {
    const result = WorkerResultContractSchema.safeParse(
      contractWithArtifacts(MAX_ARTIFACTS_PER_CONTRACT + 1),
    );
    expect(result.success).toBe(false);
  });
});

// STATUS leftover 89: `human_attestation` is a person's own confirmation (`attest_fact`) — a
// Worker's machine evidence may never carry that kind.
describe('WorkerResultEvidenceSchema — reserved human_attestation kind', () => {
  it('accepts a machine evidence kind', () => {
    const result = WorkerResultEvidenceSchema.safeParse({
      kind: 'command_output',
      content: { stdout: 'ok' },
    });
    expect(result.success).toBe(true);
  });

  it('refuses the reserved kind, and so the whole contract', () => {
    const entry = { kind: HUMAN_ATTESTATION_EVIDENCE_KIND, content: { note: 'trust me' } };
    const single = WorkerResultEvidenceSchema.safeParse(entry);
    expect(single.success).toBe(false);
    expect(single.error?.issues[0]?.message).toMatch(/reserved/);
    const contract = WorkerResultContractSchema.safeParse({ summary: 'ok', evidence: [entry] });
    expect(contract.success).toBe(false);
  });
});
