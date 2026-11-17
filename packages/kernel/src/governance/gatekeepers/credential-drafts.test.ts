import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { compareAnnouncedOperations } from '../../application/gateway/announced-operations.js';
import { credentialDraftOf, suspectedCredentialValuesOf } from './credential-drafts.js';

/**
 * governance/gatekeepers/credential-drafts.test (legacy 198): which imported definitions a bulk
 * publish leaves for a person to confirm — the same count `publishOperation` asks a person to
 * confirm — and how a preview says so before anything is imported.
 */

// Built at run time: a vendor-key-shaped value an OpenAPI document's `example` might carry.
const vendorShaped = `sk-${'a1B2'.repeat(12)}`;

function lookup(name: string, example?: string): Operation {
  return {
    name,
    description: 'Looks up one record by its id.',
    binding: { kind: 'http', method: 'GET', path: '/records/{id}' },
    params_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', 'x-in': 'path', ...(example !== undefined ? { example } : {}) },
        // A field named after a credential is a declaration, not a value.
        password: { type: 'string', 'x-in': 'query' },
      },
      required: ['id'],
    },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: ['Record'],
    writes: [],
  };
}

describe('credentialDraftOf (legacy 198)', () => {
  it('lists a definition carrying a suspected credential value, with where it is and never the value', () => {
    const draft = credentialDraftOf('records.get', lookup('records.get', vendorShaped));
    expect(draft).toEqual({
      name: 'records.get',
      suspectedSecretValues: 1,
      suspectedSecretPaths: ['params_schema.properties.id.example'],
    });
    expect(JSON.stringify(draft)).not.toContain(vendorShaped);
    expect(suspectedCredentialValuesOf(lookup('records.get', vendorShaped))).toBe(1);
  });

  it('leaves a definition whose only credential-like thing is a field name alone', () => {
    expect(credentialDraftOf('records.get', lookup('records.get', 'R-1'))).toBeUndefined();
    expect(suspectedCredentialValuesOf(lookup('records.get'))).toBe(0);
  });
});

describe('compareAnnouncedOperations — suspected credentials (legacy 198)', () => {
  it('says how many suspected credential values an announced entry to import carries, and only then', async () => {
    // No Gatekeeper yet: nothing is read, every announced entry is one to import.
    const { operationsToImport } = await compareAnnouncedOperations(
      undefined as never,
      'workspace-1',
      undefined,
      [lookup('records.get', vendorShaped), lookup('records.list')],
      () => false,
      'platform',
    );
    expect(
      operationsToImport.map(({ name, suspectedSecretValues }) => [name, suspectedSecretValues]),
    ).toEqual([
      ['records.get', 1],
      ['records.list', undefined],
    ]);
    expect(operationsToImport[1]).not.toHaveProperty('suspectedSecretValues');
  });
});
