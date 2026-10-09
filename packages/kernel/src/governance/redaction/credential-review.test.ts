import { describe, expect, it } from 'vitest';
import {
  CredentialReviewRequiredError,
  assertCredentialsReviewed,
  assertDraftCredentialsReviewed,
  countSuspectedSecrets,
  credentialReviewAudit,
} from './index.js';

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe('countSuspectedSecrets — the same detector as the scrubs', () => {
  it('counts secret-looking values inside strings, at any depth', () => {
    expect(countSuspectedSecrets({ cmd: `PGPASSWORD=${FAKE} psql` })).toBe(1);
    expect(
      countSuspectedSecrets({ steps: [{ run: `export API_TOKEN="${FAKE}"` }, `sk_live_${FAKE}`] }),
    ).toBe(2);
    expect(countSuspectedSecrets({ host: 'db.example.invalid', port: 5432, tags: ['a'] })).toBe(0);
  });

  it('with secretFields, also counts a non-blank string under a secret-named field', () => {
    const args = { user: 'ops', password: FAKE, nested: { apiKey: FAKE, clientSecret: FAKE } };
    expect(countSuspectedSecrets(args)).toBe(0);
    expect(countSuspectedSecrets(args, { secretFields: true })).toBe(3);
  });

  it('a secret-named field that is blank, not a string, or only names tokens as a quantity is not counted', () => {
    expect(
      countSuspectedSecrets(
        { password: '', token: '   ', apiKey: null, max_tokens: 1024, tokenCount: 3 },
        { secretFields: true },
      ),
    ).toBe(0);
  });

  it('a JSON Schema declaring a password property carries no value (documents leave secretFields off)', () => {
    const schema = { type: 'object', properties: { password: { type: 'string' } } };
    expect(countSuspectedSecrets(schema)).toBe(0);
  });
});

describe('assertCredentialsReviewed', () => {
  it('passes with nothing to confirm, with or without the flag', () => {
    expect(() => assertCredentialsReviewed('action_request', 'ar-1', 0, undefined)).not.toThrow();
    expect(() => assertCredentialsReviewed('action_request', 'ar-1', 0, true)).not.toThrow();
  });

  it('refuses N > 0 unless the flag is exactly true, naming the subject and the count', () => {
    for (const flag of [undefined, false]) {
      expect(() => assertCredentialsReviewed('skill', 's-1@2', 2, flag)).toThrow(
        CredentialReviewRequiredError,
      );
    }
    try {
      assertCredentialsReviewed('skill', 's-1@2', 2, undefined);
    } catch (err) {
      expect(err).toMatchObject({
        code: 'credentials_review_required',
        details: { subject: 'skill', suspectedSecretValues: 2 },
      });
    }
    expect(() => assertCredentialsReviewed('skill', 's-1@2', 2, true)).not.toThrow();
  });
});

describe('assertDraftCredentialsReviewed', () => {
  const draft = { markdown: `call it with --api-key=${FAKE}` };

  it('checks a person’s publish and returns the count', () => {
    expect(() =>
      assertDraftCredentialsReviewed('skill', 's-1@1', draft, { credentialsReviewed: undefined }),
    ).toThrow(CredentialReviewRequiredError);
    expect(
      assertDraftCredentialsReviewed('skill', 's-1@1', draft, { credentialsReviewed: true }),
    ).toBe(1);
  });

  it('an internal publish (no actor) confirms nothing', () => {
    expect(assertDraftCredentialsReviewed('skill', 's-1@1', draft, undefined)).toBe(0);
  });
});

describe('credentialReviewAudit', () => {
  it('records the confirmed count, and nothing when there was none', () => {
    expect(credentialReviewAudit(0)).toEqual({});
    expect(credentialReviewAudit(3)).toEqual({
      credentialReview: { suspectedSecretValues: 3, confirmed: true },
    });
  });
});
