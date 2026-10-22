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
  classificationOf,
  classifyOntologyDefinitionChange,
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
