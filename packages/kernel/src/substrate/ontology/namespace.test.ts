import { describe, expect, it } from 'vitest';
import {
  OntologyLinkEndpointError,
  findOntologyLinkEndpointProblems,
  findOntologyNamespaceConflicts,
} from './namespace.js';
import type { OntologyDefinition } from './schema.js';

/** I-P1 (docs/s10-evolution-plan-2026-10-04.md §3.3): the pure half of the namespace check. The
 *  DB-gated half (both publish paths refuse, nothing is written) is in `registry.test.ts`. */

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const FAMILY_C = '00000000-0000-4000-8000-00000000000c';

function definition(
  objects: readonly string[],
  actions: readonly string[] = [],
  links: readonly string[] = ['relates'],
): OntologyDefinition {
  return {
    objectTypes: objects.map((name) => ({ name, description: name })),
    linkTypes: links.map((name) => ({ name, domain: '*', range: '*', description: name })),
    ...(actions.length > 0
      ? {
          actionTypes: actions.map((name) => ({
            name,
            description: name,
            mode: 'execute' as const,
            blastRadius: 'low' as const,
          })),
        }
      : {}),
  };
}

describe('findOntologyNamespaceConflicts (I-P1)', () => {
  it('a new family may not reuse an ObjectType or ActionType name another family owns', () => {
    const conflicts = findOntologyNamespaceConflicts(
      null,
      definition(['Service', 'Dataset'], ['restart']),
      [{ id: FAMILY_A, definition: definition(['Service'], ['restart']) }],
    );
    expect(conflicts).toEqual([
      { kind: 'object', name: 'Service', ontologyId: FAMILY_A },
      { kind: 'action', name: 'restart', ontologyId: FAMILY_A },
    ]);
  });

  it("a family's own next version is not compared with its own published head", () => {
    expect(
      findOntologyNamespaceConflicts(FAMILY_A, definition(['Service', 'Host']), [
        { id: FAMILY_A, definition: definition(['Service']) },
        { id: FAMILY_B, definition: definition(['Dataset']) },
      ]),
    ).toEqual([]);
  });

  it('LinkType names may repeat across families (their signatures accumulate)', () => {
    expect(
      findOntologyNamespaceConflicts(null, definition(['Dataset'], [], ['runs_on']), [
        { id: FAMILY_A, definition: definition(['Service'], [], ['runs_on']) },
      ]),
    ).toEqual([]);
  });

  it('names are unique per kind: an ObjectType and an ActionType may share one', () => {
    expect(
      findOntologyNamespaceConflicts(null, definition(['restart']), [
        { id: FAMILY_A, definition: definition(['Service'], ['restart']) },
      ]),
    ).toEqual([]);
  });

  it('a definition that declares the same ObjectType twice conflicts with itself', () => {
    expect(findOntologyNamespaceConflicts(FAMILY_B, definition(['Host', 'Host']), [])).toEqual([
      { kind: 'object', name: 'Host', ontologyId: FAMILY_B },
    ]);
  });
});

/** Legacy 303: a definition whose LinkTypes are given as `name: domain -> range`. */
function linked(objects: readonly string[], links: readonly string[]): OntologyDefinition {
  return {
    objectTypes: objects.map((name) => ({ name, description: name })),
    linkTypes: links.map((link) => {
      const match = /^(\S+): (\S+) -> (\S+)$/.exec(link);
      if (!match) throw new Error(`bad link fixture ${link}`);
      const [, name = '', domain = '', range = ''] = match;
      return { name, domain, range, description: name };
    }),
  };
}

describe('findOntologyLinkEndpointProblems (legacy 303)', () => {
  const NONE = { undeclared: [], orphaned: [] };

  it('a LinkType end may name the candidate’s own ObjectType, another family’s, or "*"', () => {
    expect(
      findOntologyLinkEndpointProblems(
        null,
        linked(['Dataset'], ['served_by: Dataset -> Gatekeeper', 'mentions: * -> *']),
        null,
        [{ id: FAMILY_A, definition: linked(['Gatekeeper'], ['relates: * -> *']) }],
      ),
    ).toEqual(NONE);
  });

  it('an end naming a type no published family declares is undeclared, once per end', () => {
    expect(
      findOntologyLinkEndpointProblems(
        FAMILY_B,
        linked(
          ['Host'],
          ['runs_on: Contianer -> Host', 'runs_on: Contianer -> Host', 'owns: Owner -> Hots'],
        ),
        null,
        [{ id: FAMILY_A, definition: linked(['Gatekeeper'], ['relates: * -> *']) }],
      ),
    ).toEqual({
      undeclared: [
        { ontologyId: FAMILY_B, linkType: 'runs_on', end: 'domain', objectType: 'Contianer' },
        { ontologyId: FAMILY_B, linkType: 'owns', end: 'domain', objectType: 'Owner' },
        { ontologyId: FAMILY_B, linkType: 'owns', end: 'range', objectType: 'Hots' },
      ],
      orphaned: [],
    });
  });

  it('a type only the candidate’s own published head declares does not count for the candidate', () => {
    // The candidate replaces its head: what the head declares and the candidate drops is gone.
    expect(
      findOntologyLinkEndpointProblems(
        FAMILY_A,
        linked(['Host'], ['runs_on: Service -> Host']),
        linked(['Host', 'Service'], ['runs_on: Service -> Host']),
        [],
      ).undeclared,
    ).toEqual([
      { ontologyId: FAMILY_A, linkType: 'runs_on', end: 'domain', objectType: 'Service' },
    ]);
  });

  it('dropping an ObjectType another family’s LinkType names orphans that end', () => {
    expect(
      findOntologyLinkEndpointProblems(
        FAMILY_A,
        linked(['Host'], ['relates: * -> *']),
        linked(['Host', 'Gatekeeper'], ['relates: * -> *']),
        [{ id: FAMILY_B, definition: linked(['Dataset'], ['served_by: Dataset -> Gatekeeper']) }],
      ),
    ).toEqual({
      undeclared: [],
      orphaned: [
        { ontologyId: FAMILY_B, linkType: 'served_by', end: 'range', objectType: 'Gatekeeper' },
      ],
    });
  });

  it('retiring a family (no candidate types) orphans every other family’s end that named its types', () => {
    expect(
      findOntologyLinkEndpointProblems(
        FAMILY_A,
        { objectTypes: [], linkTypes: [] },
        linked(['Gatekeeper'], ['relates: * -> *']),
        [{ id: FAMILY_B, definition: linked(['Dataset'], ['served_by: Dataset -> Gatekeeper']) }],
      ).orphaned,
    ).toEqual([
      { ontologyId: FAMILY_B, linkType: 'served_by', end: 'range', objectType: 'Gatekeeper' },
    ]);
  });

  it('another family’s end that already named nothing is not the candidate’s to answer for', () => {
    expect(
      findOntologyLinkEndpointProblems(
        FAMILY_A,
        linked(['Host'], ['relates: * -> *']),
        linked(['Host', 'Gatekeeper'], ['relates: * -> *']),
        [
          {
            id: FAMILY_B,
            definition: linked(
              ['Dataset'],
              ['typo: Dataset -> Gatewaykeeper', 'served_by: Dataset -> Gatekeeper'],
            ),
          },
        ],
      ).orphaned,
    ).toEqual([
      { ontologyId: FAMILY_B, linkType: 'served_by', end: 'range', objectType: 'Gatekeeper' },
    ]);
  });

  it('a dropped type another family still declares is not orphaned', () => {
    expect(
      findOntologyLinkEndpointProblems(
        FAMILY_A,
        linked(['Host'], ['relates: * -> *']),
        linked(['Host', 'Gatekeeper'], ['relates: * -> *']),
        [
          { id: FAMILY_B, definition: linked(['Dataset'], ['served_by: Dataset -> Gatekeeper']) },
          { id: FAMILY_C, definition: linked(['Gatekeeper'], ['relates: * -> *']) },
        ],
      ),
    ).toEqual(NONE);
  });

  it('the error names every end, and which family’s end a dropped type would orphan', () => {
    const err = new OntologyLinkEndpointError({
      undeclared: [
        {
          ontologyId: null,
          family: null,
          linkType: 'runs_on',
          end: 'domain',
          objectType: 'Contianer',
        },
      ],
      orphaned: [
        {
          ontologyId: FAMILY_B,
          family: null,
          linkType: 'served_by',
          end: 'range',
          objectType: 'Gatekeeper',
        },
        {
          ontologyId: FAMILY_C,
          family: 'ops-assets',
          linkType: 'runs_on',
          end: 'range',
          objectType: 'Host',
        },
      ],
    });
    expect(err.code).toBe('ontology_link_endpoint_undeclared');
    expect(err.message).toContain('LinkType "runs_on" domain "Contianer"');
    // A family the ChangePlan named is called by that name; one it did not, by its id.
    expect(err.message).toContain(`LinkType "served_by" range "Gatekeeper" (ontology ${FAMILY_B})`);
    expect(err.message).toContain('LinkType "runs_on" range "Host" (ontology ops-assets)');
  });
});
