import { describe, expect, it } from 'vitest';
import {
  UPSTREAM_ERROR_BODY_MAX_BYTES,
  oversizedUpstreamErrorBody,
  scrubUpstreamErrorBody,
} from './upstream-error-body.js';

/** Synthetic key, and an alphabet-spelled token-like run (`.gitleaks.toml`). */
const REAL_KEY = 'sk-real-anthropic-key';
const OTHER = 'abcdefghijklmnopqrstuvwxyz0123';

describe('scrubUpstreamErrorBody (review of #549, B5)', () => {
  it('keeps a JSON error body the same JSON, its classification fields intact', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `x-api-key ${REAL_KEY} was rejected; also saw token ${OTHER}`,
        details: [{ header: `Bearer ${REAL_KEY}` }],
      },
      request_id: 'req_0123456789abcdefghijklmnop',
    });
    const parsed = JSON.parse(scrubUpstreamErrorBody(body, REAL_KEY));
    expect(parsed).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'x-api-key *** was rejected; also saw token ***',
        details: [{ header: 'Bearer ***' }],
      },
      request_id: 'req_0123456789abcdefghijklmnop',
    });
  });

  it('replaces the real key even in a classification field, and in a key name', () => {
    const body = JSON.stringify({ error: { code: `bad_${REAL_KEY}`, [REAL_KEY]: 1 } });
    const out = scrubUpstreamErrorBody(body, REAL_KEY);
    expect(out).not.toContain(REAL_KEY);
    expect(JSON.parse(out)).toEqual({ error: { code: 'bad_***', '***': 1 } });
  });

  it('scrubs a body that is not JSON as text, without truncating it', () => {
    const text = `<html>upstream failed for key ${REAL_KEY}</html>${' '.repeat(500)}end`;
    const out = scrubUpstreamErrorBody(text, REAL_KEY);
    expect(out).not.toContain(REAL_KEY);
    expect(out.endsWith('end')).toBe(true);
  });

  it('says what happened to a body past the bound, in the provider error shape', () => {
    expect(JSON.parse(oversizedUpstreamErrorBody())).toEqual({
      error: {
        type: 'upstream_error',
        message: `the provider's error response was larger than ${UPSTREAM_ERROR_BODY_MAX_BYTES / 1024} KiB and was not forwarded`,
      },
    });
  });
});
