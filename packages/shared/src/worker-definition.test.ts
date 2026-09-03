import { describe, expect, it } from 'vitest';
import {
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

    it('rejects an entry-only field (egressDeny) on a worker definition', () => {
      const result = WorkerWorkerDefinitionContentSchema.safeParse({
        systemPrompt: 'hi',
        egressDeny: ['blocked.example.com'],
      });
      expect(result.success).toBe(false);
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
