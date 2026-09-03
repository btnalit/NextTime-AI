import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_REGISTRY,
  assertRegistryConsistent,
  getCapability,
  listByChannel,
} from './capabilities.js';

/**
 * Every capability name listed in design doc §9.3, hardcoded (no snapshot), plus `list_tasks`
 * (S2.10 addition — §9.3 has no list capability for Task, only `get_task`; the web Tasks & Workers
 * view needs one, docs/development-tasks.md S2.10 deliverable 4). `deprecate_*` in the meta row is
 * expanded to its two concrete siblings of publish_skill/publish_procedure in that same row:
 * deprecate_skill, deprecate_procedure (see capabilities.ts header comment). The two `<gate>.<op>`
 * rows (observe-class, execute-class-via-request_action) are represented as the pattern names
 * `<gate>.<op>` and `<gate>.<op>:execute`.
 */
const EXPECTED_CAPABILITY_NAMES = [
  // chat
  'list_chats',
  'new_chat',
  'send_chat_message',
  'stop_agent',
  'get_chat_history',
  'subscribe_chat',
  // ontology
  'publish_ontology_version',
  'propose_ontology_change',
  'get_type',
  'list_types',
  'validate',
  // graph
  'get_object',
  'traverse',
  'search',
  'state_at',
  'find_operations',
  'find_workers',
  'find_procedures',
  // gate
  '<gate>.<op>',
  '<gate>.<op>:execute',
  // connection
  'request_connection',
  'create_connection',
  'publish_manifest',
  'connect_gatekeeper',
  // meta
  'propose_operation',
  'propose_skill',
  'propose_procedure',
  'publish_skill',
  'publish_procedure',
  'deprecate_skill',
  'deprecate_procedure',
  'list_skills',
  'list_procedures',
  'assert_fact',
  'supersede_fact',
  'invalidate_fact',
  // epistemic
  'explain',
  'record_decision',
  'query_decisions',
  'find_precedents',
  'causal_chain',
  'decision_impact',
  'list_conflicts',
  'resolve_conflict',
  'verify_fact',
  // governance
  'request_action',
  'approve',
  'reject',
  'list_pending',
  'get_action',
  'set_auto_approved_action_kind',
  'grant_capability',
  'revoke_capability',
  'set_policy',
  'set_quota',
  'issue_handle',
  // task
  'create_task',
  'invoke_worker',
  'get_task',
  'list_tasks',
  'cancel_task',
  // worker
  'propose_worker_definition',
  'publish_worker_definition',
  'deprecate_worker_definition',
  'list_worker_definitions',
  // ingest
  'register_source',
  'submit_observations',
  // audit
  'audit_query',
  'reconstruct',
  'export_prov',
] as const;

const HUMAN_ONLY_NAMES = [
  'publish_ontology_version',
  'create_connection',
  'publish_manifest',
  'connect_gatekeeper',
  'publish_skill',
  'publish_procedure',
  'approve',
  'reject',
  'grant_capability',
  'revoke_capability',
  'set_policy',
  'set_quota',
  'issue_handle',
];

describe('CAPABILITY_REGISTRY', () => {
  it('has no duplicate names', () => {
    const names = CAPABILITY_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains at least every capability name listed in design §9.3', () => {
    const names = new Set(CAPABILITY_REGISTRY.map((c) => c.name));
    for (const expected of EXPECTED_CAPABILITY_NAMES) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('gives every capability exactly one channel', () => {
    for (const capability of CAPABILITY_REGISTRY) {
      expect(['human', 'handle']).toContain(capability.channel);
    }
  });

  it('keeps the human-only capabilities off the handle channel', () => {
    for (const name of HUMAN_ONLY_NAMES) {
      const capability = getCapability(name);
      expect(capability, `expected "${name}" to be registered`).toBeDefined();
      expect(capability?.channel).toBe('human');
    }
  });

  it('restricts execute-mode handle-channel capabilities to request_action and the gate execute pattern', () => {
    const offenders = CAPABILITY_REGISTRY.filter(
      (c) =>
        c.mode === 'execute' &&
        c.channel === 'handle' &&
        c.name !== 'request_action' &&
        c.name !== '<gate>.<op>:execute',
    );
    expect(offenders).toEqual([]);
  });

  it('gives every capability a working Zod paramsSchema', () => {
    for (const capability of CAPABILITY_REGISTRY) {
      expect(typeof capability.paramsSchema.safeParse).toBe('function');
    }
  });
});

describe('assertRegistryConsistent', () => {
  it('passes on the real registry', () => {
    expect(() => assertRegistryConsistent()).not.toThrow();
  });
});

describe('getCapability', () => {
  it('finds a known capability by name', () => {
    expect(getCapability('invoke_worker')?.group).toBe('task');
  });

  it('returns undefined for an unknown name', () => {
    expect(getCapability('__does_not_exist__')).toBeUndefined();
  });
});

describe('listByChannel', () => {
  it('splits the registry across human and handle with no overlap', () => {
    const human = listByChannel('human');
    const handle = listByChannel('handle');
    expect(human.length + handle.length).toBe(CAPABILITY_REGISTRY.length);
    const handleNames = new Set(handle.map((c) => c.name));
    for (const capability of human) {
      expect(handleNames.has(capability.name)).toBe(false);
    }
  });

  it('every human-channel row is actually channel=human', () => {
    for (const capability of listByChannel('human')) {
      expect(capability.channel).toBe('human');
    }
  });
});
