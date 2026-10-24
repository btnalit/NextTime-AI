import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { entryTemplateDigest, loadEntryTemplate } from './entry-template.js';

const ONTOLOGY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'ontology',
);

describe('entry template (legacy 145)', () => {
  it('loads the shipped template, valid for an entry definition, with its digest', async () => {
    const template = await loadEntryTemplate(ONTOLOGY_DIR);
    expect(template.kind).toBe('entry');
    expect(template.systemPrompt.length).toBeGreaterThan(0);
    expect(template.capabilities).toContain('propose_goal');
    expect(template.digest).toBe(entryTemplateDigest(template.definition));
    expect(template.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('digests the prompt and the capabilities as a set; nothing else counts', () => {
    const base = { systemPrompt: 'Answer.', capabilities: ['get_task', 'search'] };
    const digest = entryTemplateDigest(base);
    expect(entryTemplateDigest({ ...base, capabilities: ['search', 'get_task'] })).toBe(digest);
    expect(entryTemplateDigest({ ...base, model: 'anthropic/x', egressDeny: ['a.example'] })).toBe(
      digest,
    );
    expect(entryTemplateDigest({ ...base, systemPrompt: 'Answer briefly.' })).not.toBe(digest);
    expect(entryTemplateDigest({ ...base, capabilities: ['get_task'] })).not.toBe(digest);
    // Not an entry content's shape: a digest no template has.
    expect(entryTemplateDigest({ systemPrompt: 1, capabilities: 'search' })).not.toBe(digest);
  });
});
