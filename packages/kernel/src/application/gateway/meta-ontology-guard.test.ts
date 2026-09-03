import { META_ONTOLOGY_OBJECT_TYPE_VALUES } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './authorize.js';
import {
  MetaOntologyWriteForbiddenError,
  assertMetaOntologyHandleWriteAllowed,
} from './meta-ontology-guard.js';

describe('assertMetaOntologyHandleWriteAllowed', () => {
  it('throws MetaOntologyWriteForbiddenError for every meta-ontology ObjectType on the handle channel', () => {
    for (const objectType of META_ONTOLOGY_OBJECT_TYPE_VALUES) {
      expect(() => assertMetaOntologyHandleWriteAllowed('handle', objectType)).toThrow(
        MetaOntologyWriteForbiddenError,
      );
    }
  });

  it('MetaOntologyWriteForbiddenError is a ForbiddenError (403 via the generic mapping too)', () => {
    expect(() => assertMetaOntologyHandleWriteAllowed('handle', 'WorkerDefinition')).toThrow(
      ForbiddenError,
    );
  });

  it('does not throw on the handle channel for a non-meta-ontology ObjectType', () => {
    expect(() =>
      assertMetaOntologyHandleWriteAllowed('handle', 'SomeOtherObjectType'),
    ).not.toThrow();
  });

  it('does not throw on the human channel, even for a meta-ontology ObjectType', () => {
    for (const objectType of META_ONTOLOGY_OBJECT_TYPE_VALUES) {
      expect(() => assertMetaOntologyHandleWriteAllowed('human', objectType)).not.toThrow();
    }
  });

  it('records the offending objectType on the thrown error', () => {
    try {
      assertMetaOntologyHandleWriteAllowed('handle', 'Gatekeeper');
      expect.fail('expected assertMetaOntologyHandleWriteAllowed to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MetaOntologyWriteForbiddenError);
      expect((err as MetaOntologyWriteForbiddenError).objectType).toBe('Gatekeeper');
    }
  });
});
