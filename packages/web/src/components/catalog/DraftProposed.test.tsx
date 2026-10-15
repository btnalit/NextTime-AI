// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { DraftProposed } from './DraftProposed.js';

afterEach(cleanup);

const refused = (count: number) =>
  new HttpError(
    'capability_error',
    'skill sk-1@1 carries suspected credentials',
    'credentials_review_required',
    {
      subject: 'skill',
      suspectedSecretValues: count,
      suspectedSecretPaths: ['markdown'],
    },
  );

describe('DraftProposed — credential confirmation (decision 2026-10-09 "二次确认")', () => {
  it('a refused publish opens the question in place of an error; Publish waits for the tick, then carries it', async () => {
    const onPublish = vi
      .fn()
      .mockRejectedValueOnce(refused(2))
      .mockResolvedValueOnce({ status: 'published' });
    render(
      <DraftProposed
        kindLabel="Skill"
        draft={{ id: 'sk-1', version: 1, status: 'draft', name: 'rotate' }}
        onPublish={onPublish}
        onDone={vi.fn()}
        detailHref="#/govern/catalog/skills/sk-1"
        fieldNames={{ markdown: '正文' }}
      />,
    );
    expect(screen.queryByTestId('credential-review')).toBeNull();

    fireEvent.click(screen.getByTestId('draft-publish'));
    const review = await screen.findByTestId('credential-review');
    expect(onPublish).toHaveBeenNthCalledWith(1, {});
    expect(review.getAttribute('data-count')).toBe('2');
    expect(screen.getByTestId('credential-review-warning').textContent).toContain(
      '含 2 处疑似凭据',
    );
    expect(screen.queryByTestId('draft-publish-error')).toBeNull();
    // This screen does not show the content: the question names where and links to it.
    // Named as the editor labels it, not by the kernel's field name.
    expect(screen.getByTestId('credential-review-paths').textContent).toBe('正文');
    expect(screen.getByTestId('draft-credential-detail-link').getAttribute('href')).toBe(
      '#/govern/catalog/skills/sk-1',
    );
    const publish = screen.getByTestId('draft-publish') as HTMLButtonElement;
    expect(publish.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('credential-review-confirm'));
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    await waitFor(() =>
      expect(onPublish).toHaveBeenNthCalledWith(2, { credentialsReviewed: true }),
    );
    await waitFor(() => expect(screen.queryByTestId('draft-publish')).toBeNull());
    expect(screen.queryByTestId('credential-review')).toBeNull();
  });

  it('any other failure still shows the kernel’s error, with no question', async () => {
    const onPublish = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('capability_error', 'not a draft', 'conflict'));
    render(
      <DraftProposed
        kindLabel="Skill"
        draft={{ id: 'sk-1', version: 1, status: 'draft' }}
        onPublish={onPublish}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('draft-publish'));
    await screen.findByTestId('draft-publish-error');
    expect(screen.queryByTestId('credential-review')).toBeNull();
  });
});

describe('DraftProposed — the page refreshes on publish (#541 acceptance must-fix 1)', () => {
  it('calls onPublished once the publish succeeded, not on a refusal', async () => {
    const onPublished = vi.fn();
    const onPublish = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('capability_error', 'nope', 'illegal_transition'))
      .mockResolvedValueOnce({ status: 'published' });
    render(
      <DraftProposed
        kindLabel="Worker"
        draft={{ id: 'wd-1', version: 1, status: 'draft', name: 'ops-runner' }}
        onPublish={onPublish}
        onDone={vi.fn()}
        onPublished={onPublished}
      />,
    );
    fireEvent.click(screen.getByTestId('draft-publish'));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect(onPublished).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('draft-publish'));
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
  });
});
