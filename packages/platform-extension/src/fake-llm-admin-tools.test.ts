import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_TOOL_CAPABILITY_NAMES } from './modes/admin.js';
import { ENTRY_TOOL_CAPABILITY_NAMES } from './modes/entry.js';

/**
 * S11 AA4d-2 (#481 on #949): the accept_s2 admin agent scenario's `ADMIN_TOOLS` verdict
 * (deploy/fake-llm/server.mjs `adminToolsVerdict`) checks the tool list pi offered the model by
 * name. It only proves the admin container started in admin mode if the names it looks for tell
 * the two modes apart — so both lists are read out of server.mjs and pinned to the modes' own:
 * `ENTRY_ONLY_TOOLS` is exactly entry mode's tools less admin mode's, and the tools the scenario
 * calls are admin mode's alone.
 */
const FAKE_LLM_SOURCE = readFileSync(
  new URL('../../../deploy/fake-llm/server.mjs', import.meta.url),
  'utf8',
);

function stringArray(name: string): string[] {
  const body = new RegExp(`const ${name} = \\[([^\\]]*)\\];`).exec(FAKE_LLM_SOURCE)?.[1];
  if (body === undefined) throw new Error(`deploy/fake-llm/server.mjs has no array ${name}`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

const entry = new Set<string>(ENTRY_TOOL_CAPABILITY_NAMES);
const admin = new Set<string>(ADMIN_TOOL_CAPABILITY_NAMES);

describe('fake-llm admin agent scenario tool names (S11 AA4d-2)', () => {
  it('ENTRY_ONLY_TOOLS is exactly the entry tools the admin mode does not register', () => {
    const entryOnly = stringArray('ENTRY_ONLY_TOOLS');
    for (const name of entryOnly) {
      expect(entry.has(name), `${name} is an entry mode tool`).toBe(true);
      expect(admin.has(name), `${name} is not an admin mode tool`).toBe(false);
    }
    expect([...entryOnly].sort()).toEqual(
      ENTRY_TOOL_CAPABILITY_NAMES.filter((name) => !admin.has(name)).sort(),
    );
  });

  it('the tools the scenario calls are admin mode tools, never entry ones', () => {
    const used = stringArray('ADMIN_AGENT_TOOLS_USED');
    expect(used).toEqual([
      'agent_list_proposal_targets',
      'platform_state_connectors',
      'propose_admin_proposal',
    ]);
    for (const name of used) {
      expect(admin.has(name), `${name} is an admin mode tool`).toBe(true);
      expect(entry.has(name), `${name} is not an entry mode tool`).toBe(false);
    }
  });

  // S11 AA5c: the ticket journey's five Turns (`ticketsConnectChatScenario` and the four after it).
  it('the tools the ticket journey calls are admin mode tools', () => {
    const used = [
      ...stringArray('TICKETS_CONNECT_TOOLS'),
      ...stringArray('TICKETS_DRAFT_TOOLS'),
      ...stringArray('TICKETS_TRY_TOOLS'),
      ...stringArray('TICKETS_PROPOSE_TOOLS'),
      ...stringArray('TICKETS_PROGRESS_TOOLS'),
    ];
    expect(used).toEqual([
      'request_connection',
      'invoke_worker',
      'find_operations',
      'propose_skill',
      'propose_worker_definition',
      'invoke_worker',
      'agent_list_proposal_targets',
      'propose_admin_proposal',
      'agent_get_admin_proposal',
    ]);
    for (const name of used) {
      expect(admin.has(name), `${name} is an admin mode tool`).toBe(true);
    }
  });
});
