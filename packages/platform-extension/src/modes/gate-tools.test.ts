import { describe, expect, it } from 'vitest';
import {
  type AllowedOperationWire,
  gateToolDescription,
  gateToolName,
  sanitizeToolName,
  truncateToolResult,
} from './gate-tools.js';

/**
 * modes/gate-tools.test: `gateToolDescription`'s own unit tests (S5.4, docs/development-tasks.md
 * S5.4 deliverable 3 — "统一在描述末尾附加一句 mode + blast radius"). `ops-runner.yaml`'s own prompt
 * now tells the Worker to read a gate tool's description to learn observe/execute (S5.4's H2 fix,
 * replacing the fictitious `describe_operations` tool) — these tests are what keeps that prompt
 * instruction true. `gateToolName`/`sanitizeToolName` already had indirect coverage via
 * entry.test.ts/worker.test.ts; not retested here.
 */

function op(overrides: Partial<AllowedOperationWire['operation']> = {}): AllowedOperationWire {
  return {
    gatekeeperId: 'gk-1',
    gateName: 'docker',
    name: 'container.restart',
    operation: { mode: 'observe', ...overrides },
  };
}

describe('gateToolDescription', () => {
  it('appends an observe-class sentence for an observe-mode Operation', () => {
    const description = gateToolDescription(op({ mode: 'observe' }), 'docker.container.restart');
    expect(description).toContain('Observe-class: read-only, returns data directly.');
  });

  it('appends an execute-class sentence (naming the ActionRequest indirection) for an execute-mode Operation', () => {
    const description = gateToolDescription(op({ mode: 'execute' }), 'docker.container.restart');
    expect(description).toContain('Execute-class: a governed write');
    expect(description).toContain('ActionRequest');
  });

  it('appends a blast-radius sentence when the Operation carries one', () => {
    const description = gateToolDescription(
      op({ mode: 'execute', blast_radius: 'high' }),
      'docker.container.restart',
    );
    expect(description).toContain('Blast radius: high.');
  });

  it('omits the blast-radius sentence entirely when the Operation does not carry one', () => {
    const description = gateToolDescription(op({ mode: 'observe' }), 'docker.container.restart');
    expect(description).not.toContain('Blast radius');
  });

  it('uses the manifest description as the base sentence when present', () => {
    const description = gateToolDescription(
      op({ mode: 'observe', description: 'Get current stock for a SKU.' }),
      'accept_s2_api.stock.get',
    );
    expect(description.startsWith('Get current stock for a SKU.')).toBe(true);
  });

  it('falls back to a generic base sentence naming the tool when the manifest has no description', () => {
    const description = gateToolDescription(op({ mode: 'observe' }), 'docker.container.restart');
    expect(description.startsWith('Gatekeeper Operation "docker.container.restart".')).toBe(true);
  });

  it('falls back the same way for a blank (whitespace-only) manifest description', () => {
    const description = gateToolDescription(
      op({ mode: 'observe', description: '   ' }),
      'docker.container.restart',
    );
    expect(description.startsWith('Gatekeeper Operation "docker.container.restart".')).toBe(true);
  });
});

// Re-exported for the sanity of this file's own import list — gate-tools.ts already exports these
// and they are exercised end-to-end via entry.test.ts/worker.test.ts; asserting they still exist
// here costs nothing and catches an accidental rename before those larger suites would.
describe('gate-tools module surface', () => {
  it('still exports gateToolName and sanitizeToolName', () => {
    expect(typeof gateToolName).toBe('function');
    expect(typeof sanitizeToolName).toBe('function');
  });
});

/**
 * truncateToolResult (S8 W3-K1, leftover 75 first half, docs/STATUS.md §4 row 75): the shared cap
 * on a gate tool's rendered result text — `modes/worker.ts`'s `buildGateTool` and `modes/entry.ts`'s
 * `buildGateObserveTool` both call it (their own tests exercise one call path each; this file owns
 * the helper's own boundary behavior).
 */
describe('truncateToolResult', () => {
  it('returns text at or under the limit byte-for-byte unchanged (no marker appended)', () => {
    const text = 'x'.repeat(100);
    expect(truncateToolResult(text, 100)).toBe(text);
    expect(truncateToolResult('short', 100)).toBe('short');
  });

  it('truncates text over the limit to exactly maxChars of head content, plus a marker line naming the omitted count', () => {
    const text = 'a'.repeat(150);
    const result = truncateToolResult(text, 100);
    expect(result.startsWith('a'.repeat(100))).toBe(true);
    expect(result).not.toContain('a'.repeat(101));
    expect(result).toContain('50 more characters omitted');
    expect(result).toContain('the full result is not shown');
  });

  it('uses the default cap (16000) when maxChars is omitted', () => {
    const text = 'b'.repeat(20_000);
    const result = truncateToolResult(text);
    expect(result.length).toBeGreaterThan(16_000);
    expect(result.length).toBeLessThan(20_000);
    expect(result).toContain('4000 more characters omitted');
  });
});
