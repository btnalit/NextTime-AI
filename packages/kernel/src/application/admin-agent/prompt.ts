import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveOntologyDir } from '../../substrate/ontology/index.js';

/**
 * application/admin-agent/prompt (S11 AA4c-2; the AA4c plan's D8): the admin agent's system
 * prompt, `ontology/admin-agent.yaml`. Only a prompt — not a WorkerDefinition, so no workspace
 * holds a version of it and no owner changes it; the file's own header says why. What the agent
 * may do is the kernel's (its ceiling, its targets, its container), never this text.
 *
 * Fails closed: a file that is missing, unreadable or not exactly `{systemPrompt: <text>}` throws,
 * and the runtime fails the Turn — an admin agent never starts with another agent's prompt (the
 * runtime image's entry fallback included).
 */

const loaded = new Map<string, Promise<string>>();

/** The `systemPrompt` of `admin-agent.yaml` under `ontologyDir` (default `resolveOntologyDir()`),
 *  read once per directory; a failed read is retried on the next call. */
export function loadAdminAgentSystemPrompt(
  ontologyDir: string = resolveOntologyDir(),
): Promise<string> {
  let prompt = loaded.get(ontologyDir);
  if (!prompt) {
    const filePath = path.join(ontologyDir, 'admin-agent.yaml');
    prompt = readFile(filePath, 'utf8').then((text) => parseAdminAgentPrompt(text, filePath));
    prompt.catch(() => loaded.delete(ontologyDir));
    loaded.set(ontologyDir, prompt);
  }
  return prompt;
}

/** `text`'s `systemPrompt`, when `text` is a YAML mapping holding that one non-empty string. */
export function parseAdminAgentPrompt(text: string, source = 'admin-agent.yaml'): string {
  const parsed: unknown = parseYaml(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source}: expected a mapping with one key, systemPrompt`);
  }
  const keys = Object.keys(parsed);
  const systemPrompt = (parsed as { systemPrompt?: unknown }).systemPrompt;
  if (keys.length !== 1 || typeof systemPrompt !== 'string' || systemPrompt.trim() === '') {
    throw new Error(
      `${source}: expected exactly one key, systemPrompt, holding the prompt text (got ${keys.join(', ') || 'nothing'})`,
    );
  }
  return systemPrompt;
}
