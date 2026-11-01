import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ATTEST_FACT_NOTE_MAX_LENGTH,
  CAPABILITY_REGISTRY,
  INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS,
  assertRegistryConsistent,
  capabilityHasSideEffects,
  getCapability,
  listByChannel,
} from './capabilities.js';
import { toJsonSchema } from './json-schema.js';

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
  // closing wave C5b (coverage gap G1 part 2) — not in §9.3 (added after it).
  'list_ontology_versions',
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
  // STATUS leftover 89 — not in §9.3: a person's own confirmation, recorded as Evidence.
  'attest_fact',
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
  'attest_fact',
  'approve_step_trial',
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

  // docs/wire-contract-conventions.md §5 / S3.7: every capability carries a resultSchema now
  // (previously only `get_operation_stats`) — a working Zod schema, not necessarily precise for
  // an unimplemented capability (see capabilities.ts's own module doc comment on placeholders).
  it('gives every capability a working Zod resultSchema', () => {
    for (const capability of CAPABILITY_REGISTRY) {
      expect(
        capability.resultSchema,
        `expected "${capability.name}" to carry a resultSchema`,
      ).toBeDefined();
      expect(typeof capability.resultSchema?.safeParse).toBe('function');
    }
  });

  // docs/wire-contract-conventions.md §1 vocabulary table / §5 "词表守卫" (2026-09-08 decision):
  // `mode: 'propose'` is reserved for a name that starts with `propose_` or `request_` (plus the
  // one named exception, `propose_ontology_change`, which already matches the `propose_` prefix) —
  // never an immediate in-platform write. Guards against the exact "propose"→"write" retagging
  // this task performed ever silently regressing for a future registry addition.
  it('reserves mode:"propose" for propose_*/request_* names, and never for an immediate write', () => {
    const proposeModeOffenders = CAPABILITY_REGISTRY.filter(
      (c) =>
        c.mode === 'propose' && !(c.name.startsWith('propose_') || c.name.startsWith('request_')),
    );
    expect(proposeModeOffenders.map((c) => c.name)).toEqual([]);

    const IMMEDIATE_WRITE_NAMES = [
      'assert_fact',
      'supersede_fact',
      'invalidate_fact',
      'record_decision',
      'resolve_conflict',
      'verify_fact',
      'attest_fact',
      'report_turn',
      'invoke_worker',
      'report_task_result',
      'cancel_task',
      'register_source',
      'submit_observations',
    ];
    for (const name of IMMEDIATE_WRITE_NAMES) {
      expect(getCapability(name)?.mode, `expected "${name}" to be mode:"write"`).toBe('write');
    }
  });
});

describe('assertRegistryConsistent', () => {
  it('passes on the real registry', () => {
    expect(() => assertRegistryConsistent()).not.toThrow();
  });
});

describe('sideEffects (review 2026-10-02 D-08)', () => {
  it('every non-observe capability has side effects; none declares otherwise', () => {
    for (const capability of CAPABILITY_REGISTRY) {
      if (capability.mode !== 'observe') {
        expect(capabilityHasSideEffects(capability), capability.name).toBe(true);
        expect(capability.sideEffects, capability.name).not.toBe(false);
      }
    }
  });

  it('pins the observe-mode capabilities that write — mode is not the read-only test', () => {
    const writingObserves = CAPABILITY_REGISTRY.filter(
      (capability) => capability.mode === 'observe' && capabilityHasSideEffects(capability),
    ).map((capability) => capability.name);
    expect(writingObserves.sort()).toEqual(
      ['<gate>.<op>', 'get_entry_context', 'observe_operation', 'test_gate_instance'].sort(),
    );
  });

  it('a plain read has none', () => {
    const auditQuery = getCapability('audit_query');
    expect(auditQuery && capabilityHasSideEffects(auditQuery)).toBe(false);
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

// fix/invoke-worker-wait-and-outbox-prune: `timeout` (seconds) is clamped to
// INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS (90 — matches the kernel's own wait-window default, no
// larger ceiling is defined anywhere) so a caller can never ask for a wait longer than the kernel
// will ever actually hold.
describe('invoke_worker paramsSchema timeout clamp', () => {
  const baseParams = { definitionId: 'def-1', version: 1, input: {} };
  const schema = () => getCapability('invoke_worker')?.paramsSchema;

  it('accepts a timeout at the max', () => {
    const result = schema()?.safeParse({
      ...baseParams,
      timeout: INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS,
    });
    expect(result?.success).toBe(true);
  });

  it('rejects a timeout above the max', () => {
    const result = schema()?.safeParse({
      ...baseParams,
      timeout: INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS + 1,
    });
    expect(result?.success).toBe(false);
  });

  it('accepts an omitted timeout (the kernel applies its own default)', () => {
    const result = schema()?.safeParse(baseParams);
    expect(result?.success).toBe(true);
  });
});

describe('grant_capability params (leftover 80, 2026-09-25; R-26 / D-14, 2026-10-02)', () => {
  const schema = () => getCapability('grant_capability')?.paramsSchema;
  const principalId = '00000000-0000-4000-8000-000000000001';
  const gatekeeperId = '00000000-0000-4000-8000-000000000003';

  it('accepts a per-gate grant without scope', () => {
    const result = schema()?.safeParse({
      principalId,
      resourceType: 'gatekeeper',
      resourceId: gatekeeperId,
    });
    expect(result?.success).toBe(true);
  });

  it('rejects a scope param: the stored scope was never enforced, so the param is gone', () => {
    const result = schema()?.safeParse({
      principalId,
      resourceType: 'gatekeeper',
      resourceId: gatekeeperId,
      scope: { operationNames: ['container.restart'] },
    });
    expect(result?.success).toBe(false);
  });

  it('rejects a wildcard gate grant: resourceId is required (the console cannot show or revoke one)', () => {
    const result = schema()?.safeParse({ principalId, resourceType: 'gatekeeper' });
    expect(result?.success).toBe(false);
  });

  it.each([
    ['an action kind', 'container.restart'],
    ['a future resource type', 'worker_definition'],
  ])('rejects a non-gatekeeper resourceType (%s), with or without a resourceId', (_label, type) => {
    expect(schema()?.safeParse({ principalId, resourceType: type }).success).toBe(false);
    expect(
      schema()?.safeParse({ principalId, resourceType: type, resourceId: gatekeeperId }).success,
    ).toBe(false);
  });
});

// STATUS leftover 89 (maintainer decision 2026-09-27): a person's own confirmation of a Fact.
describe('attest_fact (leftover 89)', () => {
  const factId = '00000000-0000-4000-8000-000000000002';
  const capability = () => getCapability('attest_fact');

  it('is a human-channel write with the same role gate as verify_fact', () => {
    const attest = capability();
    const verify = getCapability('verify_fact');
    expect(attest?.channel).toBe('human');
    expect(attest?.mode).toBe('write');
    expect(attest?.group).toBe('epistemic');
    expect(attest?.minRole).toBe(verify?.minRole);
    // Never in a Handle's reach: listByChannel('handle') is everything the Handle side can see.
    expect(listByChannel('handle').some((c) => c.name === 'attest_fact')).toBe(false);
  });

  it('requires a non-blank note and trims it', () => {
    const schema = capability()?.paramsSchema;
    expect(schema?.safeParse({ factId }).success).toBe(false);
    expect(schema?.safeParse({ factId, note: '   ' }).success).toBe(false);
    const parsed = schema?.safeParse({ factId, note: '  checked on the console  ' });
    expect(parsed?.success).toBe(true);
    expect((parsed?.data as { note: string }).note).toBe('checked on the console');
  });

  it('bounds the note', () => {
    const schema = capability()?.paramsSchema;
    const atCap = 'x'.repeat(ATTEST_FACT_NOTE_MAX_LENGTH);
    expect(schema?.safeParse({ factId, note: atCap }).success).toBe(true);
    expect(schema?.safeParse({ factId, note: `${atCap}x` }).success).toBe(false);
  });

  it('accepts only an http(s) link — never javascript: or another scheme', () => {
    const schema = capability()?.paramsSchema;
    const note = 'n';
    expect(schema?.safeParse({ factId, note, link: 'https://wiki.example/runbook' }).success).toBe(
      true,
    );
    expect(schema?.safeParse({ factId, note, link: 'http://ticket.example/42' }).success).toBe(
      true,
    );
    expect(schema?.safeParse({ factId, note, link: 'javascript:alert(1)' }).success).toBe(false);
    expect(schema?.safeParse({ factId, note, link: 'file:///etc/passwd' }).success).toBe(false);
    expect(schema?.safeParse({ factId, note, link: 'not a url' }).success).toBe(false);
  });

  it('refuses any extra field — the attester is the caller, never a request field', () => {
    const schema = capability()?.paramsSchema;
    expect(
      schema?.safeParse({ factId, note: 'n', attestedBy: '00000000-0000-4000-8000-000000000003' })
        .success,
    ).toBe(false);
    expect(schema?.safeParse({ factId, note: 'n', kind: 'observation' }).success).toBe(false);
  });
});

// Closing wave C5b (coverage gap G1 part 2): mirrors list_worker_definitions/list_skills exactly
// for visibility and channel — see capabilities.ts's own doc comment on this row.
describe('list_ontology_versions (closing wave C5b)', () => {
  const capability = () => getCapability('list_ontology_versions');
  const sibling = () => getCapability('list_worker_definitions');

  it('is a handle-channel observe read with the same minRole floor as its siblings', () => {
    const own = capability();
    expect(own?.channel).toBe('handle');
    expect(own?.mode).toBe('observe');
    expect(own?.group).toBe('ontology');
    expect(own?.minRole).toBe(sibling()?.minRole);
    expect(own?.minRole).toBe('member');
    // Never human-only — a Handle (e.g. an entry agent) may call it, same as list_types/get_type.
    expect(listByChannel('handle').some((c) => c.name === 'list_ontology_versions')).toBe(true);
  });

  it('accepts empty params and an optional limit/cursor page', () => {
    const schema = capability()?.paramsSchema;
    expect(schema?.safeParse({}).success).toBe(true);
    expect(schema?.safeParse({ limit: 50 }).success).toBe(true);
    expect(schema?.safeParse({ cursor: 'abc' }).success).toBe(true);
    expect(schema?.safeParse({ limit: 50, cursor: 'abc' }).success).toBe(true);
    expect(schema?.safeParse({ unexpected: true }).success).toBe(false);
  });
});

describe('D-24 publish / deprecate authority (review 2026-10-02)', () => {
  it('every publish_* / deprecate_* capability is human-channel with at least the builder floor', () => {
    const family = CAPABILITY_REGISTRY.filter((c) => /^(publish|deprecate)_/.test(c.name));
    expect(family.map((c) => c.name).sort()).toEqual(
      [
        'deprecate_operation',
        'deprecate_procedure',
        'deprecate_skill',
        'deprecate_worker_definition',
        'publish_manifest',
        'publish_ontology_version',
        'publish_operation',
        'publish_procedure',
        'publish_skill',
        'publish_worker_definition',
      ].sort(),
    );
    for (const capability of family) {
      expect(capability.channel, capability.name).toBe('human');
      expect(['builder', 'owner'], capability.name).toContain(capability.minRole);
    }
  });

  it('update_operation_description (STATUS leftover 123) has the same builder floor', () => {
    const capability = getCapability('update_operation_description');
    expect(capability?.channel).toBe('human');
    expect(capability?.minRole).toBe('builder');
  });
});

describe('ChangePlan segments are written by a person (S11 AA1, legacy 407)', () => {
  it('every capability that applies, rolls back or verifies a segment is actsForPerson', () => {
    for (const name of [
      'install_module',
      'upgrade_module',
      'install_pack',
      'roll_back_change_segment',
      'verify_change_segment',
    ]) {
      const capability = getCapability(name);
      expect(capability?.channel, name).toBe('human');
      expect(capability?.actsForPerson, name).toBe(true);
    }
  });
});

describe('platform_state: what an admin agent reads of the platform (S11 AA2)', () => {
  const group = CAPABILITY_REGISTRY.filter((capability) => capability.group === 'platform_state');

  it('holds every admin-agent-only capability, and only those', () => {
    expect(group.map((capability) => capability.name).sort()).toEqual([
      'platform_state_audit',
      'platform_state_connectors',
      'platform_state_gates',
    ]);
    const flagged = CAPABILITY_REGISTRY.filter((capability) => capability.adminAgentOnly);
    expect(flagged.map((capability) => capability.name).sort()).toEqual(
      group.map((capability) => capability.name).sort(),
    );
  });

  it('is side-effect-free handle-channel observation, for no role and no person in particular', () => {
    for (const capability of group) {
      expect(capability.channel, capability.name).toBe('handle');
      expect(capability.mode, capability.name).toBe('observe');
      expect(capabilityHasSideEffects(capability), capability.name).toBe(false);
      expect(capability.scope, capability.name).toBeUndefined();
      expect(capability.minRole, capability.name).toBeUndefined();
      expect(capability.actsForPerson, capability.name).toBeUndefined();
      expect(capability.paramsSchema.safeParse({}).success, capability.name).toBe(true);
      expect(capability.paramsSchema.safeParse({ any: 1 }).success, capability.name).toBe(false);
    }
  });

  /** A property name that reads like an address, a command, free text or a secret: allowed only
   *  for a value that cannot carry one (an enum, a constant, a number, a boolean). */
  const SENSITIVE_PROPERTY_NAME =
    /url|uri|host|address|endpoint|target|port|path|command|detail|payload|label|login|token|secret|credential|password|container|cidr|ip$|name$|display|summary|description|message|note|reason|error/i;
  /** Property names the rule above catches that hold a patterned identifier: a connector's `name`
   *  (`CONNECTOR_NAME_PATTERN`). */
  const SHAPED_SENSITIVE_NAMES = new Set(['name']);

  type Node = Record<string, unknown>;
  /** The schema's string leaves: `{type: 'string'}` nodes, through `anyOf` / `oneOf`. */
  function stringLeaves(node: Node): Node[] {
    const variants = [...((node.anyOf as Node[]) ?? []), ...((node.oneOf as Node[]) ?? [])];
    if (variants.length > 0) return variants.flatMap(stringLeaves);
    const type = node.type;
    return type === 'string' || (Array.isArray(type) && type.includes('string')) ? [node] : [];
  }
  function isShapedString(node: Node): boolean {
    return (
      Array.isArray(node.enum) ||
      node.const !== undefined ||
      typeof node.pattern === 'string' ||
      node.format === 'date-time'
    );
  }
  function walk(node: Node, path: string, problems: string[]): void {
    for (const leaf of stringLeaves(node)) {
      if (!isShapedString(leaf)) problems.push(`${path}: a string with no enum, pattern or format`);
    }
    for (const variant of [...((node.anyOf as Node[]) ?? []), ...((node.oneOf as Node[]) ?? [])]) {
      walk(variant, path, problems);
    }
    if (node.type === 'object' || node.properties !== undefined) {
      for (const [key, child] of Object.entries((node.properties as Record<string, Node>) ?? {})) {
        const childPath = `${path}.${key}`;
        if (SENSITIVE_PROPERTY_NAME.test(key)) {
          const free = stringLeaves(child).filter(
            (leaf) => !Array.isArray(leaf.enum) && leaf.const === undefined,
          );
          if (free.length > 0 && !SHAPED_SENSITIVE_NAMES.has(key)) {
            problems.push(`${childPath}: named like an address, command, free text or secret`);
          }
        }
        walk(child, childPath, problems);
      }
    }
    if (node.items !== undefined) walk(node.items as Node, `${path}[]`, problems);
  }

  /** Objects that would keep or drop an unknown key instead of refusing it (`.strict()`): JSON
   *  Schema writes both as `additionalProperties: false`, so this reads the Zod definition. */
  function looseObjects(schema: z.ZodType, path: string, problems: string[]): void {
    const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
    if (def.type === 'object') {
      const catchall = def.catchall as z.ZodType | undefined;
      const strict =
        (catchall as unknown as { _zod?: { def: { type: string } } } | undefined)?._zod?.def
          .type === 'never';
      if (!strict) problems.push(`${path}: an object that is not strict`);
      for (const [key, child] of Object.entries(def.shape as Record<string, z.ZodType>)) {
        looseObjects(child, `${path}.${key}`, problems);
      }
    } else if (def.type === 'array') {
      looseObjects(def.element as z.ZodType, `${path}[]`, problems);
    } else if (def.type === 'nullable' || def.type === 'optional' || def.type === 'default') {
      looseObjects(def.innerType as z.ZodType, path, problems);
    } else if (def.type === 'union') {
      for (const option of def.options as z.ZodType[]) looseObjects(option, path, problems);
    }
  }

  it('returns only strict objects whose every string is shaped and none is named like a secret or address', () => {
    for (const capability of group) {
      expect(capability.resultSchema, capability.name).toBeDefined();
      const schema = capability.resultSchema as z.ZodType;
      const problems: string[] = [];
      looseObjects(schema, capability.name, problems);
      walk(toJsonSchema(schema), capability.name, problems);
      expect(problems, capability.name).toEqual([]);
    }
  });

  it('the guard itself catches a free string, a loose object and an address-named field', () => {
    const probe = z.object({
      free: z.string(),
      loose: z.object({ count: z.number() }),
      endpoint: z.string().regex(/^[a-z]+$/),
      gateId: z.string().regex(/^[a-z]+$/),
      items: z.array(z.object({ note: z.string().nullable() }).strict()),
    });
    const problems: string[] = [];
    looseObjects(probe, 'probe', problems);
    walk(toJsonSchema(probe), 'probe', problems);
    expect(problems).toEqual([
      'probe: an object that is not strict',
      'probe.loose: an object that is not strict',
      'probe.free: a string with no enum, pattern or format',
      'probe.endpoint: named like an address, command, free text or secret',
      'probe.items[].note: named like an address, command, free text or secret',
      'probe.items[].note: a string with no enum, pattern or format',
    ]);
  });
});
