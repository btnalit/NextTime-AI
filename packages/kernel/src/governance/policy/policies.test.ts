import { describe, expect, it } from 'vitest';
import { type PolicyRow, autoApproveConsent, toPolicyEvaluationInput } from './policies.js';

/**
 * Legacy 218: `autoApproveConsent` — whether a gate-scoped "always allow" still applies to the
 * definition in force. Pure; the DB half is covered by
 * application/gateway/auto-approval-scope.integration.test.ts.
 */

const DIGEST_V1 = `sha256:${'1'.repeat(64)}`;
const DIGEST_V2 = `sha256:${'2'.repeat(64)}`;

function rule(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    workspaceId: 'ws',
    id: 'rule',
    gatekeeperId: 'gk',
    actionKind: 'svc.restart',
    blastRadius: 'medium',
    autoApprove: true,
    requesterCanApprove: null,
    setBy: 'owner',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    operationDigest: DIGEST_V1,
    operationVersion: 1,
    ...overrides,
  };
}

describe('autoApproveConsent', () => {
  it('is current for the definition the rule was given for, at no higher blast radius', () => {
    expect(autoApproveConsent(rule(), { operationDigest: DIGEST_V1, blastRadius: 'medium' })).toBe(
      'current',
    );
    expect(autoApproveConsent(rule(), { operationDigest: DIGEST_V1, blastRadius: 'low' })).toBe(
      'current',
    );
  });

  it('is definition_changed for another definition, none published, or a raised blast radius', () => {
    expect(autoApproveConsent(rule(), { operationDigest: DIGEST_V2, blastRadius: 'medium' })).toBe(
      'definition_changed',
    );
    expect(autoApproveConsent(rule(), { operationDigest: undefined, blastRadius: 'medium' })).toBe(
      'definition_changed',
    );
    expect(autoApproveConsent(rule(), null)).toBe('definition_changed');
    expect(
      autoApproveConsent(rule({ blastRadius: 'low' }), {
        operationDigest: DIGEST_V1,
        blastRadius: 'medium',
      }),
    ).toBe('definition_changed');
  });

  it('is not_recorded for a rule naming no definition', () => {
    expect(
      autoApproveConsent(rule({ operationDigest: null, operationVersion: null }), {
        operationDigest: DIGEST_V1,
        blastRadius: 'medium',
      }),
    ).toBe('not_recorded');
  });

  it('is current for every rule that does not turn auto-approval on at a gate', () => {
    const inForce = { operationDigest: DIGEST_V2, blastRadius: 'medium' as const };
    expect(autoApproveConsent(rule({ autoApprove: false, operationDigest: null }), inForce)).toBe(
      'current',
    );
    expect(autoApproveConsent(rule({ gatekeeperId: null, operationDigest: null }), inForce)).toBe(
      'current',
    );
  });

  it('feeds evaluate() through toPolicyEvaluationInput', () => {
    expect(
      toPolicyEvaluationInput(rule(), { operationDigest: DIGEST_V2, blastRadius: 'medium' }),
    ).toEqual({
      scope: 'gatekeeper',
      autoApprove: true,
      requesterCanApprove: null,
      allowsThisDefinition: false,
    });
  });
});
