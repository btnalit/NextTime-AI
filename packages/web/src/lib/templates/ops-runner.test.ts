import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { OPS_RUNNER_WORKER_TEMPLATE } from './ops-runner.js';

/**
 * lib/templates/ops-runner.test: the drift guard `ops-runner.ts`'s own doc comment promises — the
 * web bundle's checked-in copy of `ontology/ops-runner.yaml` must equal what the file on disk
 * actually parses to, field for field (audit J7/CW1's "从模板创建" button; F1 "不加新功能"). Reads
 * the YAML relative to this test file (not `process.cwd()`, which is `packages/web` under
 * `pnpm --filter @nexttime/web test`, five directories below where `ontology/` lives) so the test
 * is not sensitive to how it is invoked. `yaml` is a devDependency of this package only (added
 * alongside this file) — nothing in the shipped bundle imports it; `ops-runner.ts` itself is a
 * plain object literal with no parser of its own.
 */
const YAML_PATH = fileURLToPath(
  new URL('../../../../../ontology/ops-runner.yaml', import.meta.url),
);

describe('OPS_RUNNER_WORKER_TEMPLATE (drift guard)', () => {
  it('equals the parsed ontology/ops-runner.yaml, field for field', () => {
    const raw = readFileSync(YAML_PATH, 'utf8');
    const parsed = parse(raw) as Record<string, unknown>;

    // Guards against the YAML growing a field this template silently drops (or vice versa).
    expect(Object.keys(parsed).sort()).toEqual(['egressDeny', 'kind', 'skills', 'systemPrompt']);

    expect(OPS_RUNNER_WORKER_TEMPLATE).toEqual({
      kind: parsed.kind,
      skills: parsed.skills,
      egressDeny: parsed.egressDeny,
      systemPrompt: parsed.systemPrompt,
    });
  });
});
