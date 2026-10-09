import { describe, expect, it } from 'vitest';
import {
  CredentialReviewRequiredError,
  assertCredentialsReviewed,
  assertDraftCredentialsReviewed,
  countSuspectedSecrets,
  credentialReviewAudit,
  findSuspectedSecrets,
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

  it('a literal the schema carries for a secret-named property counts, even one no pattern knows', () => {
    const schema = {
      type: 'object',
      properties: {
        apiKey: { type: 'string', default: 'hunter2', examples: ['hunter3', ''] },
        password: { const: 'swordfish' },
        mode: { enum: ['fast', 'slow'], default: 'fast' },
        tokenType: { enum: ['bearer'] },
      },
    };
    expect(countSuspectedSecrets(schema)).toBe(3);
  });
});

describe('findSuspectedSecrets — where, by field path only', () => {
  it('names each hit by its dot path, array items by index, never a value fragment', () => {
    const found = findSuspectedSecrets(
      {
        headers: { Authorization: `Bearer sk_live_${FAKE}` },
        steps: [{ run: 'ls' }, { run: `export API_TOKEN="${FAKE}"` }],
        password: FAKE,
        note: 'nothing here',
      },
      { secretFields: true },
    );
    expect(found.count).toBe(3);
    expect(found.paths).toEqual(['headers.Authorization', 'steps[1].run', 'password']);
    for (const path of found.paths) expect(path).not.toContain(FAKE);
  });

  it('a field name that itself looks like a secret is scrubbed in the path', () => {
    const found = findSuspectedSecrets(
      { [`sk_live_${FAKE}`]: { password: FAKE } },
      {
        secretFields: true,
      },
    );
    expect(found.count).toBe(1);
    expect(found.paths[0]).not.toContain(FAKE);
    expect(found.paths[0]).toMatch(/\.password$/);
  });

  it('keeps the count exact but lists at most 20 paths', () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`cmd${i}`, `PGPASSWORD=${FAKE} psql`]),
    );
    const found = findSuspectedSecrets(many, { secretFields: true });
    expect(found.count).toBe(25);
    expect(found.paths).toHaveLength(20);
  });
});

const found = (count: number) => ({ count, paths: count > 0 ? ['x'] : [] });

describe('assertCredentialsReviewed', () => {
  it('passes with nothing to confirm, with or without the flag', () => {
    expect(() =>
      assertCredentialsReviewed('action_request', 'ar-1', found(0), undefined),
    ).not.toThrow();
    expect(() => assertCredentialsReviewed('action_request', 'ar-1', found(0), true)).not.toThrow();
  });

  it('refuses N > 0 unless the flag is exactly true, naming the subject and the count', () => {
    for (const flag of [undefined, false]) {
      expect(() => assertCredentialsReviewed('skill', 's-1@2', found(2), flag)).toThrow(
        CredentialReviewRequiredError,
      );
    }
    try {
      assertCredentialsReviewed('skill', 's-1@2', found(2), undefined);
    } catch (err) {
      expect(err).toMatchObject({
        code: 'credentials_review_required',
        details: { subject: 'skill', suspectedSecretValues: 2, suspectedSecretPaths: ['x'] },
      });
    }
    expect(() => assertCredentialsReviewed('skill', 's-1@2', found(2), true)).not.toThrow();
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
