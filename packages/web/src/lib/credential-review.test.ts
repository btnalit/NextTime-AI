// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  credentialReviewCount,
  credentialReviewParams,
  usePublishCredentialReview,
} from './credential-review.js';
import { HttpError } from './http-client.js';

describe('lib/credential-review', () => {
  it('reads the kernel’s count from its 400, and nothing from any other error', () => {
    const refused = new HttpError('capability_error', 'm', 'credentials_review_required', {
      subject: 'skill',
      suspectedSecretValues: 4,
    });
    expect(credentialReviewCount(refused)).toBe(4);
    // A refusal without a usable count still asks — for at least one.
    expect(
      credentialReviewCount(new HttpError('capability_error', 'm', 'credentials_review_required')),
    ).toBe(1);
    expect(credentialReviewCount(new HttpError('capability_error', 'm', 'reason_required'))).toBe(
      null,
    );
    expect(credentialReviewCount(new Error('boom'))).toBe(null);
    expect(credentialReviewCount(null)).toBe(null);
  });

  it('adds credentialsReviewed only when confirmed', () => {
    expect(credentialReviewParams(true)).toEqual({ credentialsReviewed: true });
    expect(credentialReviewParams(false)).toEqual({});
  });
});

describe('usePublishCredentialReview', () => {
  const refusal = new HttpError('capability_error', 'm', 'credentials_review_required', {
    subject: 'skill',
    suspectedSecretValues: 3,
  });

  it('opens on the kernel’s refusal, blocks until ticked, and adds the confirmation only then', () => {
    const { result } = renderHook(() => usePublishCredentialReview('sk-1@1'));
    expect(result.current).toMatchObject({ count: 0, blocked: false });
    expect(result.current.params()).toEqual({});

    let captured = false;
    act(() => {
      captured = result.current.capture(refusal);
    });
    expect(captured).toBe(true);
    expect(result.current).toMatchObject({ count: 3, checked: false, blocked: true });
    expect(result.current.params()).toEqual({});

    act(() => result.current.setChecked(true));
    expect(result.current.blocked).toBe(false);
    expect(result.current.params()).toEqual({ credentialsReviewed: true });
  });

  it('ignores other errors', () => {
    const { result } = renderHook(() => usePublishCredentialReview('sk-1@1'));
    act(() => {
      expect(result.current.capture(new HttpError('capability_error', 'm', 'conflict'))).toBe(
        false,
      );
    });
    expect(result.current.count).toBe(0);
  });

  it('another subject starts closed — a tick never carries over to content not checked', () => {
    const { result, rerender } = renderHook(({ key }) => usePublishCredentialReview(key), {
      initialProps: { key: 'sk-1@1' as string | null },
    });
    act(() => {
      result.current.capture(refusal);
    });
    act(() => result.current.setChecked(true));
    rerender({ key: 'sk-1@2' });
    expect(result.current).toMatchObject({ count: 0, checked: false, blocked: false });
    expect(result.current.params()).toEqual({});
    rerender({ key: null });
    expect(result.current.count).toBe(0);
  });
});
