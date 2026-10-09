import { describe, expect, it } from 'vitest';
import {
  EgressDenyListSchema,
  EntryWorkerDefinitionContentSchema,
  WorkerWorkerDefinitionContentSchema,
  workerDefinitionContentSchemaFor,
} from './worker-definition.js';

describe('worker-definition content schemas', () => {
  describe('EntryWorkerDefinitionContentSchema', () => {
    it('accepts a minimal entry definition (no model, no egressDeny)', () => {
      const result = EntryWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'You are the entry agent.',
        capabilities: ['get_object', 'traverse'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts model and egressDeny when present', () => {
      const result = EntryWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'You are the entry agent.',
        model: 'example-provider/example-model',
        capabilities: ['get_object'],
        egressDeny: ['blocked.example.com'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing systemPrompt', () => {
      const result = EntryWorkerDefinitionContentSchema.safeParse({ capabilities: [] });
      expect(result.success).toBe(false);
    });

    it('rejects a missing capabilities array', () => {
      const result = EntryWorkerDefinitionContentSchema.safeParse({ systemPrompt: 'hi' });
      expect(result.success).toBe(false);
    });

    it('rejects unknown extra fields (strict)', () => {
      const result = EntryWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'hi',
        capabilities: [],
        kind: 'entry',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a worker-only field (skills) on an entry definition', () => {
      const result = EntryWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'hi',
        capabilities: [],
        skills: ['some-skill'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('WorkerWorkerDefinitionContentSchema', () => {
    it('accepts a minimal worker definition (no capabilities field)', () => {
      const result = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'You are the ops-runner.',
      });
      expect(result.success).toBe(true);
    });

    it('accepts skills when present', () => {
      const result = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'You are the ops-runner.',
        skills: ['diagnose-network'],
      });
      expect(result.success).toBe(true);
    });

    // S2.7: `capabilities`/`gates` are now valid (worker-scoped) fields — see this module's own
    // doc comment on WorkerWorkerDefinitionContentSchema ("the WorkerDefinition's own declared
    // needs").
    it('accepts capabilities and gates when present', () => {
      const result = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'You are the ops-runner.',
        capabilities: ['get_object', 'assert_fact'],
        gates: ['gk-1'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts name and description when present', () => {
      const result = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'You are the ops-runner.',
        name: 'ops-runner',
        description: 'General-purpose ops worker.',
      });
      expect(result.success).toBe(true);
    });

    // feat/egress-definition-lists: egressDeny is no longer entry-only (design doc §7.9 applies a
    // WorkerDefinition's own allow/deny list to both entry sessions and WorkerRuns) — was
    // previously rejected here as an "entry-only field"; see worker-definition.ts's own doc
    // comment for the full rationale.
    it('accepts egressDeny when present', () => {
      const result = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'hi',
        egressDeny: ['blocked.example.com'],
      });
      expect(result.success).toBe(true);
    });
  });

  // fix/egress-suffix-match: the documented `.suffix` form was a silent no-op in the egress proxy;
  // now it parses to the bare name, and anything the proxy could never match is refused.
  describe('EgressDenyListSchema (both kinds)', () => {
    it('parses a leading `.` or `*.` to the bare name (lower-cased, trailing root dot dropped)', () => {
      expect(
        EgressDenyListSchema.parse([
          '.internal.example',
          '*.Internal.Example.',
          'blocked.example.com',
          'intra',
        ]),
      ).toEqual(['internal.example', 'internal.example', 'blocked.example.com', 'intra']);
    });

    it.each([
      ['*', 'wildcards'],
      ['foo.*.example', 'wildcards'],
      ['..internal.example', 'starts with'],
      ['https://blocked.example.com', 'not a host name'],
      ['blocked.example.com:443', 'not a host name'],
      ['blocked.example.com/path', 'not a host name'],
      ['198.51.100.0/24', 'not a host name'],
      ['bad host.example', 'not a host name'],
      ['例え.jp', 'not a host name'],
      ['203.0.113.7', 'IP address'],
      ['2001:db8::1', 'IP address'],
      ['.', 'empty'],
    ])('refuses %j with a reason naming the entry, on the field itself', (entry, reason) => {
      const result = EgressDenyListSchema.safeParse(['ok.example', entry]);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.path).toEqual([]);
        expect(result.error.issues[0]?.message).toContain(`"${entry}"`);
        expect(result.error.issues[0]?.message).toContain(reason);
      }
    });

    it('both content schemas use it: parsed output is canonical, a bad entry fails the definition', () => {
      const entry = EntryWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'hi',
        capabilities: [],
        egressDeny: ['.internal.example', '*.corp.example'],
      });
      expect(entry.success && entry.data.egressDeny).toEqual(['internal.example', 'corp.example']);
      const worker = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'hi',
        egressDeny: ['.internal.example'],
      });
      expect(worker.success && worker.data.egressDeny).toEqual(['internal.example']);
      const bad = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'hi',
        egressDeny: ['*.*.example'],
      });
      expect(bad.success).toBe(false);
      // The path a form keys its field errors by (packages/web catalog.ts fieldErrorsFromIssues).
      expect(bad.success ? null : bad.error.issues[0]?.path).toEqual(['egressDeny']);
    });
  });

  describe('workerDefinitionContentSchemaFor', () => {
    it('returns the entry schema for kind="entry"', () => {
      expect(workerDefinitionContentSchemaFor('entry')).toBe(EntryWorkerDefinitionContentSchema);
    });

    it('returns the worker schema for kind="worker"', () => {
      expect(workerDefinitionContentSchemaFor('worker')).toBe(WorkerWorkerDefinitionContentSchema);
    });
  });
});
