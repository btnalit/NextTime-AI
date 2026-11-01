import { type Operation, OperationFieldsSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  type ActionTypeDefinition,
  type OntologyDefinition,
  OntologyDefinitionSchema,
} from '../../substrate/ontology/index.js';
import {
  ACTION_TYPE_FIELD_RULES,
  LINK_TYPE_FIELD_RULES,
  OBJECT_TYPE_FIELD_RULES,
  ONTOLOGY_SECTION_NAMES,
  OPERATION_FIELD_RULES,
  classificationOf,
  classifyOntologyDefinitionChange,
  classifyOperationChange,
  classifySkillChange,
  classifyWorkerDefinitionChange,
} from './classify.js';

/**
 * application/change-plan/classify — the whitelist (I-A4). Every field the ontology schema has has
 * a rule, and a field none has is widening; each ActionType governance field, changed alone, is
 * widening when loosened (or, without a proven direction, whenever it changes) and not when
 * tightened; ObjectType / LinkType changes are not widening.
 */

const BASE_ACTION: ActionTypeDefinition = {
  name: 'restart',
  description: 'restart a container',
  mode: 'execute',
  blastRadius: 'medium',
  reversibility: true,
  autoApprovable: false,
  awaitDecision: false,
  requesterCanApprove: false,
};

function definition(actions?: readonly ActionTypeDefinition[]): OntologyDefinition {
  return {
    objectTypes: [{ name: 'Container', description: 'a container' }],
    linkTypes: [{ name: 'runs_on', domain: 'Container', range: '*', description: 'where' }],
    ...(actions ? { actionTypes: [...actions] } : {}),
  };
}

function withAction(patch: Partial<ActionTypeDefinition>): OntologyDefinition {
  const action = { ...BASE_ACTION, ...patch };
  for (const key of Object.keys(patch) as (keyof ActionTypeDefinition)[]) {
    if (patch[key] === undefined) delete action[key];
  }
  return definition([action]);
}

describe('classifyOntologyDefinitionChange — every schema field has a rule (whitelist)', () => {
  const shape = OntologyDefinitionSchema.shape;

  it('the sections are the schema top-level keys', () => {
    expect([...ONTOLOGY_SECTION_NAMES].sort()).toEqual(Object.keys(shape).sort());
  });

  it.each([
    ['objectTypes', Object.keys(shape.objectTypes.element.shape), OBJECT_TYPE_FIELD_RULES],
    ['linkTypes', Object.keys(shape.linkTypes.element.shape), LINK_TYPE_FIELD_RULES],
    ['actionTypes', Object.keys(shape.actionTypes.unwrap().element.shape), ACTION_TYPE_FIELD_RULES],
  ] as const)('%s fields', (_section, schemaKeys, rules) => {
    expect(Object.keys(rules).sort()).toEqual([...schemaKeys].sort());
  });

  it('a field no rule knows is unrecognized, in any section and at the top level', () => {
    const after = {
      ...definition([{ ...BASE_ACTION, gateOwnedParams: { x: 1 } } as ActionTypeDefinition]),
      objectTypes: [{ name: 'Container', description: 'a container', secret: 'x' }],
      requires: ['other-pack'],
    } as unknown as OntologyDefinition;
    expect(classifyOntologyDefinitionChange(definition([BASE_ACTION]), after)).toEqual([
      { path: 'requires', reason: 'unrecognized' },
      { path: 'objectTypes[Container].secret', reason: 'unrecognized' },
      { path: 'actionTypes[restart].gateOwnedParams', reason: 'unrecognized' },
    ]);
  });

  it('a new ObjectType carrying a field no rule knows is unrecognized too', () => {
    const after = {
      ...definition(),
      objectTypes: [
        { name: 'Container', description: 'a container' },
        { name: 'Host', description: 'a host', prompt: 'be nice' },
      ],
    } as unknown as OntologyDefinition;
    expect(classifyOntologyDefinitionChange(definition(), after)).toEqual([
      { path: 'objectTypes[Host].prompt', reason: 'unrecognized' },
    ]);
  });
});

describe('classifyOntologyDefinitionChange — ActionType governance fields, one at a time', () => {
  it.each([
    // [field, before patch, after patch, expected reason or null]
    ['mode loosened', { mode: 'execute' }, { mode: 'observe' }, 'loosened'],
    ['mode tightened', { mode: 'observe' }, { mode: 'execute' }, null],
    ['blastRadius lowered', { blastRadius: 'high' }, { blastRadius: 'low' }, 'loosened'],
    ['blastRadius raised', { blastRadius: 'low' }, { blastRadius: 'high' }, null],
    ['autoApprovable enabled', { autoApprovable: false }, { autoApprovable: true }, 'loosened'],
    [
      'autoApprovable declared from absent',
      { autoApprovable: undefined },
      { autoApprovable: true },
      'loosened',
    ],
    ['autoApprovable disabled', { autoApprovable: true }, { autoApprovable: false }, null],
    [
      'autoApprovable false to absent',
      { autoApprovable: false },
      { autoApprovable: undefined },
      null,
    ],
    [
      'requesterCanApprove enabled',
      { requesterCanApprove: false },
      { requesterCanApprove: true },
      'loosened',
    ],
    [
      'requesterCanApprove false to absent (default by blast radius)',
      { requesterCanApprove: false },
      { requesterCanApprove: undefined },
      'loosened',
    ],
    [
      'requesterCanApprove absent to true',
      { requesterCanApprove: undefined },
      { requesterCanApprove: true },
      'loosened',
    ],
    [
      'requesterCanApprove true to absent',
      { requesterCanApprove: true },
      { requesterCanApprove: undefined },
      null,
    ],
    [
      'requesterCanApprove disabled',
      { requesterCanApprove: true },
      { requesterCanApprove: false },
      null,
    ],
    ['reversibility true to false', { reversibility: true }, { reversibility: false }, 'changed'],
    ['reversibility false to true', { reversibility: false }, { reversibility: true }, 'changed'],
    ['reversibility dropped', { reversibility: true }, { reversibility: undefined }, 'changed'],
    ['awaitDecision on', { awaitDecision: false }, { awaitDecision: true }, 'changed'],
    ['awaitDecision off', { awaitDecision: true }, { awaitDecision: false }, 'changed'],
    ['description reworded', { description: 'a' }, { description: 'b' }, null],
  ] as const)('%s', (_label, beforePatch, afterPatch, expected) => {
    const result = classifyOntologyDefinitionChange(
      withAction(beforePatch as Partial<ActionTypeDefinition>),
      withAction(afterPatch as Partial<ActionTypeDefinition>),
    );
    if (expected === null) {
      expect(result).toEqual([]);
      expect(classificationOf(result)).toBe('not_widening');
    } else {
      const field = Object.keys(afterPatch)[0] as string;
      expect(result).toEqual([{ path: `actionTypes[restart].${field}`, reason: expected }]);
      expect(classificationOf(result)).toBe('authority_widening');
    }
  });

  it('an ActionType added, removed or declared twice is widening; a fresh install of one is added', () => {
    const other = { ...BASE_ACTION, name: 'stop' };
    expect(
      classifyOntologyDefinitionChange(definition([BASE_ACTION]), definition([BASE_ACTION, other])),
    ).toEqual([{ path: 'actionTypes[stop]', reason: 'added' }]);
    expect(
      classifyOntologyDefinitionChange(definition([BASE_ACTION, other]), definition([BASE_ACTION])),
    ).toEqual([{ path: 'actionTypes[stop]', reason: 'removed' }]);
    expect(classifyOntologyDefinitionChange(definition([BASE_ACTION]), definition())).toEqual([
      { path: 'actionTypes[restart]', reason: 'removed' },
    ]);
    expect(
      classifyOntologyDefinitionChange(
        definition([BASE_ACTION]),
        definition([BASE_ACTION, { ...BASE_ACTION, mode: 'observe' }]),
      ),
    ).toEqual([{ path: 'actionTypes[restart]', reason: 'changed' }]);
    expect(classifyOntologyDefinitionChange(null, definition([BASE_ACTION]))).toEqual([
      { path: 'actionTypes[restart]', reason: 'added' },
    ]);
    // P1-B: rolling a first install back takes the family out; its ActionTypes are removed.
    expect(classifyOntologyDefinitionChange(definition([BASE_ACTION]), null)).toEqual([
      { path: 'actionTypes[restart]', reason: 'removed' },
    ]);
  });

  it('several widening changes are all listed, in a stable order', () => {
    const result = classifyOntologyDefinitionChange(
      withAction({}),
      withAction({ mode: 'observe', autoApprovable: true, awaitDecision: true }),
    );
    expect(result).toEqual([
      { path: 'actionTypes[restart].autoApprovable', reason: 'loosened' },
      { path: 'actionTypes[restart].awaitDecision', reason: 'changed' },
      { path: 'actionTypes[restart].mode', reason: 'loosened' },
    ]);
  });
});

describe('classifyOntologyDefinitionChange — what is proven not to widen', () => {
  it('ObjectTypes and LinkTypes added, removed, redescribed or rekeyed', () => {
    const before = definition();
    const after: OntologyDefinition = {
      objectTypes: [
        { name: 'Container', description: 'renamed prose', identityKey: ['hostId', 'name'] },
        { name: 'Host', description: 'a host' },
      ],
      linkTypes: [
        { name: 'runs_on', domain: 'Container', range: 'Host', description: 'where' },
        { name: 'owned_by', domain: 'Host', range: '*', description: 'who' },
      ],
    };
    expect(classifyOntologyDefinitionChange(before, after)).toEqual([]);
    expect(classifyOntologyDefinitionChange(after, before)).toEqual([]);
    expect(classifyOntologyDefinitionChange(null, after)).toEqual([]);
    expect(classifyOntologyDefinitionChange(after, null)).toEqual([]);
  });

  it('the same content is not widening', () => {
    expect(
      classifyOntologyDefinitionChange(definition([BASE_ACTION]), definition([BASE_ACTION])),
    ).toEqual([]);
  });
});

describe('classifySkillChange / classifyWorkerDefinitionChange (P1-D)', () => {
  const SKILL = { name: 'fix-it', description: 'd', markdown: 'body', applicable: {} };
  const WORKER = { name: 'fixer', systemPrompt: 'p' };

  it('a family not installed is added as a whole; taking one out widens nothing', () => {
    expect(classifySkillChange(null, SKILL)).toEqual([{ path: 'skill', reason: 'added' }]);
    expect(classifyWorkerDefinitionChange(null, WORKER)).toEqual([
      { path: 'worker', reason: 'added' },
    ]);
    expect(classifySkillChange(SKILL, null)).toEqual([]);
    expect(classifyWorkerDefinitionChange(WORKER, null)).toEqual([]);
  });

  it('a Skill: any change to what a Worker reads widens; its discovery metadata does not', () => {
    expect(classifySkillChange(SKILL, { ...SKILL, markdown: 'other' })).toEqual([
      { path: 'skill.markdown', reason: 'changed' },
    ]);
    expect(classifySkillChange(SKILL, { ...SKILL, name: 'fix-that', description: 'e' })).toEqual([
      { path: 'skill.description', reason: 'changed' },
      { path: 'skill.name', reason: 'changed' },
    ]);
    expect(
      classifySkillChange(SKILL, { ...SKILL, applicable: { objectTypes: ['Container'] } }),
    ).toEqual([]);
  });

  it('a Worker: prompt and model whenever they change, lists by direction, labels never', () => {
    expect(classifyWorkerDefinitionChange(WORKER, { ...WORKER, systemPrompt: 'q' })).toEqual([
      { path: 'worker.systemPrompt', reason: 'changed' },
    ]);
    expect(classifyWorkerDefinitionChange(WORKER, { ...WORKER, model: 'm' })).toEqual([
      { path: 'worker.model', reason: 'changed' },
    ]);
    expect(
      classifyWorkerDefinitionChange(WORKER, { ...WORKER, name: 'other', description: 'd' }),
    ).toEqual([]);
    // S11 GO13: a contract only describes the Worker's input and report — what it may do does
    // not change with it, so declaring, changing or removing one widens nothing.
    const report = { type: 'object', properties: { summary: { type: 'string' } } };
    expect(
      classifyWorkerDefinitionChange(WORKER, {
        ...WORKER,
        inputSchema: report,
        outputSchema: report,
      }),
    ).toEqual([]);
    expect(
      classifyWorkerDefinitionChange(
        { ...WORKER, outputSchema: report },
        { ...WORKER, outputSchema: { type: 'object', properties: {} } },
      ),
    ).toEqual([]);
    // Skills and gates: more is wider (absent is none); fewer is not.
    expect(classifyWorkerDefinitionChange(WORKER, { ...WORKER, skills: ['a'] })).toEqual([
      { path: 'worker.skills', reason: 'loosened' },
    ]);
    expect(
      classifyWorkerDefinitionChange(
        { ...WORKER, gates: ['g1', 'g2'] },
        { ...WORKER, gates: ['g1'] },
      ),
    ).toEqual([]);
    // Capabilities: between the default and a list is not proven either way; a longer list widens.
    expect(classifyWorkerDefinitionChange(WORKER, { ...WORKER, capabilities: ['search'] })).toEqual(
      [{ path: 'worker.capabilities', reason: 'changed' }],
    );
    expect(
      classifyWorkerDefinitionChange(
        { ...WORKER, capabilities: ['search'] },
        { ...WORKER, capabilities: ['search', 'request_action'] },
      ),
    ).toEqual([{ path: 'worker.capabilities', reason: 'loosened' }]);
    // The egress a Worker is denied: a shorter list widens.
    expect(
      classifyWorkerDefinitionChange(
        { ...WORKER, egressDeny: ['a.example', 'b.example'] },
        { ...WORKER, egressDeny: ['a.example'] },
      ),
    ).toEqual([{ path: 'worker.egressDeny', reason: 'loosened' }]);
    // A field the schema does not have is widening until a rule says otherwise.
    expect(classifyWorkerDefinitionChange(WORKER, { ...WORKER, extra: true })).toEqual([
      { path: 'worker.extra', reason: 'unrecognized' },
    ]);
  });
});

describe('classifyOperationChange (P1-E) — the whole Operation, field by field', () => {
  /** An execute-class MCP call that is as loose as its governance fields go: auto-approvable, low
   *  impact, not awaiting the decision. The rows below change one field each — the three
   *  governance fields stay as they are, so `classifyOperationGovernanceChange` reads every one of
   *  them as `neutral`. */
  const OPERATION: Operation = {
    name: 'container.restart',
    description: 'Restart one container.',
    binding: { kind: 'mcp', tool_name: 'restart' },
    params_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    mode: 'execute',
    blast_radius: 'low',
    reversibility: true,
    auto_approvable: true,
    await_decision: false,
    reads: ['Container'],
    writes: ['Container'],
    result_mapping: { jmes_path: '@', object_type: 'Container', identity_keys: ['id'] },
    read_only_hint: false,
    destructive_hint: false,
    idempotent_hint: true,
  };

  /** `OPERATION` with `patch` applied; a key set to `undefined` is left out. */
  function changed(patch: Partial<Record<keyof Operation, unknown>>): Operation {
    const next = { ...OPERATION, ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
    return next as Operation;
  }

  it('every schema field has a rule', () => {
    expect(Object.keys(OPERATION_FIELD_RULES).sort()).toEqual(
      Object.keys(OperationFieldsSchema.shape).sort(),
    );
  });

  it('a new Operation is added as a whole; taking one out widens nothing', () => {
    const observe = changed({ mode: 'observe' });
    expect(classifyOperationChange(null, OPERATION)).toEqual([
      { path: 'operation', reason: 'added' },
    ]);
    expect(classifyOperationChange(null, observe)).toEqual([
      { path: 'operation', reason: 'added' },
    ]);
    expect(classifyOperationChange(OPERATION, null)).toEqual([]);
    expect(classifyOperationChange(OPERATION, OPERATION)).toEqual([]);
  });

  // The plan's §5.4 list and the roadmap's P1 acceptance: each of these, changed alone with the
  // three governance fields untouched, needs a person to confirm it.
  it.each([
    ['binding: another tool', { binding: { kind: 'mcp', tool_name: 'restart_all' } }, 'binding'],
    [
      'binding: an ssh command template',
      { binding: { kind: 'ssh', command_template: 'docker restart {id} && rm -rf /' } },
      'binding',
    ],
    [
      'binding: an http path and method',
      { binding: { kind: 'http', method: 'DELETE', path: '/containers/{id}' } },
      'binding',
    ],
    [
      'params_schema: loosened',
      { params_schema: { type: 'object', additionalProperties: true } },
      'params_schema',
    ],
    [
      'params_schema: a gate-owned param declared',
      {
        params_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            authorization: { type: 'string', 'x-in': 'header' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      'params_schema',
    ],
    ['reversibility: true to false', { reversibility: false }, 'reversibility'],
    ['description', { description: 'Restart, and say it is safe.' }, 'description'],
    [
      'result_mapping',
      { result_mapping: { jmes_path: '@', object_type: 'Host', identity_keys: ['id'] } },
      'result_mapping',
    ],
    ['read_only_hint', { read_only_hint: true }, 'read_only_hint'],
  ] as const)('%s → changed', (_label, patch, field) => {
    const widening = classifyOperationChange(OPERATION, changed(patch));
    expect(widening).toEqual([{ path: `operation.${field}`, reason: 'changed' }]);
    expect(classificationOf(widening)).toBe('authority_widening');
  });

  it('reversibility needs confirmation whichever way it moves', () => {
    expect(
      classifyOperationChange(changed({ reversibility: false }), changed({ reversibility: true })),
    ).toEqual([{ path: 'operation.reversibility', reason: 'changed' }]);
  });

  // Fields with a direction: the looser way widens, the stricter way (and staying) does not.
  const strict: Operation = changed({
    mode: 'execute',
    blast_radius: 'high',
    auto_approvable: false,
    await_decision: true,
    destructive_hint: true,
    idempotent_hint: false,
    reads: ['Container'],
    writes: ['Container'],
  });
  it.each([
    ['mode: execute → observe', { mode: 'observe' }, 'mode'],
    ['blast_radius: high → medium', { blast_radius: 'medium' }, 'blast_radius'],
    ['blast_radius: high → low', { blast_radius: 'low' }, 'blast_radius'],
    ['auto_approvable: false → true', { auto_approvable: true }, 'auto_approvable'],
    ['await_decision: true → false', { await_decision: false }, 'await_decision'],
    ['destructive_hint: true → false', { destructive_hint: false }, 'destructive_hint'],
    ['idempotent_hint: false → true', { idempotent_hint: true }, 'idempotent_hint'],
    ['writes: one more type', { writes: ['Container', 'Host'] }, 'writes'],
    ['reads: one more type', { reads: ['Container', 'Secret'] }, 'reads'],
  ] as const)('loosened — %s', (_label, patch, field) => {
    const after = { ...strict, ...patch } as Operation;
    expect(classifyOperationChange(strict, after)).toEqual([
      { path: `operation.${field}`, reason: 'loosened' },
    ]);
    // The other way round tightens: proven not to widen.
    expect(classifyOperationChange(after, strict)).toEqual([]);
  });

  it('an MCP hint left out reads as not declared: as strict as the stricter value', () => {
    const declared = changed({ destructive_hint: true, idempotent_hint: false });
    const undeclared = changed({ destructive_hint: undefined, idempotent_hint: undefined });
    expect(classifyOperationChange(declared, undeclared)).toEqual([]);
    expect(classifyOperationChange(undeclared, declared)).toEqual([]);
    expect(classifyOperationChange(undeclared, changed({ destructive_hint: false }))).toEqual([
      { path: 'operation.destructive_hint', reason: 'loosened' },
      { path: 'operation.idempotent_hint', reason: 'loosened' },
    ]);
  });

  it('every governance field tightened at once is not widening', () => {
    expect(classifyOperationChange(OPERATION, strict)).toEqual([]);
  });

  it('a field the schema does not have is widening until a rule says otherwise', () => {
    expect(
      classifyOperationChange(OPERATION, { ...OPERATION, gate_owned: true } as Operation),
    ).toEqual([{ path: 'operation.gate_owned', reason: 'unrecognized' }]);
  });
});
