import { describe, expect, it } from 'vitest';
import { findOntologyNamespaceConflicts } from './namespace.js';
import type { OntologyDefinition } from './schema.js';

/** I-P1 (docs/s10-evolution-plan-2026-10-04.md §3.3): the pure half of the namespace check. The
 *  DB-gated half (both publish paths refuse, nothing is written) is in `registry.test.ts`. */

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';

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
