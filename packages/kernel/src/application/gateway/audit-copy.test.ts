import { describe, expect, it } from 'vitest';
import { credentialReviewAudit } from '../../governance/redaction/index.js';
import { auditedHandlerPayload } from './audit-copy.js';

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe('auditedHandlerPayload (S11 AA3c-1: a handler’s audit additions, both dispatch paths)', () => {
  it('is empty for no additions and keeps clean ones exactly as they are', () => {
    expect(auditedHandlerPayload(undefined)).toEqual({});
    const clean = {
      proposalId: '6f2c1d1e-0000-4000-8000-000000000001',
      digest: `sha256:${'a1'.repeat(32)}`,
      gateIds: ['tickets-a'],
      definition: { target: 'https://t.example.invalid/api?format=json', manifestSource: null },
      ...credentialReviewAudit(2),
    };
    expect(auditedHandlerPayload(clean)).toEqual(clean);
  });

  it('cuts every gate address that carries a credential, at any depth, by the connection rule', () => {
    const shown = auditedHandlerPayload({
      target: `https://ops:${FAKE}@t.example.invalid/api`,
      items: [
        { endpoint: `https://gate.example.invalid/x?X-Amz-Signature=${FAKE}` },
        { manifestSource: `https://t.example.invalid/openapi.json?sig=${FAKE}` },
      ],
    });
    expect(shown).toEqual({
      target: 'https://t.example.invalid/api',
      items: [
        { endpoint: 'https://gate.example.invalid/x' },
        { manifestSource: 'https://t.example.invalid/openapi.json' },
      ],
    });
    expect(JSON.stringify(shown)).not.toContain(FAKE);
  });

  it('hides a secret-looking value wherever it is, and leaves fields named after secrets alone', () => {
    const shown = auditedHandlerPayload({
      note: `run with PGPASSWORD=${FAKE}`,
      link: `https://t.example.invalid/x?token=${FAKE}`,
      ...credentialReviewAudit(1),
    });
    expect(JSON.stringify(shown)).not.toContain(FAKE);
    expect(shown.credentialReview).toEqual({ suspectedSecretValues: 1, confirmed: true });
  });
});
