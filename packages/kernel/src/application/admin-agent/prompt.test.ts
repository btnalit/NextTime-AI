import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAdminAgentSystemPrompt, parseAdminAgentPrompt } from './prompt.js';

/** The admin agent's system prompt (S11 AA4c-2): the shipped file parses, and anything else fails
 *  closed. */

const ONTOLOGY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'ontology',
);

describe('admin agent prompt', () => {
  it('reads the shipped ontology/admin-agent.yaml', async () => {
    const prompt = await loadAdminAgentSystemPrompt(ONTOLOGY_DIR);
    expect(prompt).toContain('You are the admin agent');
    expect(prompt).toContain('admin_proposal_target_not_chosen');
    expect(prompt).toContain('Proposal targets');
  });

  it.each([
    ['not a mapping', '- systemPrompt'],
    ['no systemPrompt', 'other: text'],
    ['an empty systemPrompt', 'systemPrompt: "  "'],
    ['a key beside it', 'systemPrompt: text\nmodel: anything'],
    ['a non-string systemPrompt', 'systemPrompt: [a, b]'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseAdminAgentPrompt(text)).toThrow(/systemPrompt/);
  });

  it('fails when the file is missing, and reads it again on the next call', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'admin-agent-prompt-'));
    try {
      await expect(loadAdminAgentSystemPrompt(dir)).rejects.toThrow();
      await writeFile(path.join(dir, 'admin-agent.yaml'), 'systemPrompt: |\n  Now here.\n');
      await expect(loadAdminAgentSystemPrompt(dir)).resolves.toBe('Now here.\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
