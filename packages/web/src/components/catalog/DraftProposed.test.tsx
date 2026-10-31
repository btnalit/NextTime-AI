// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { DraftProposed } from './DraftProposed.js';

// `DraftProposed` still toasts through the legacy `ui/Toast`; mocked here (as FactRow.test does)
// so a test can say no toast went up without rendering the legacy provider.
const pushToast = vi.fn();
vi.mock('../ui/Toast.js', () => ({
  useToast: () => ({ push: pushToast, dismiss: () => undefined }),
}));

afterEach(() => {
  cleanup();
  pushToast.mockClear();
});

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

describe('DraftProposed — a Worker draft naming what is not there (legacy 302)', () => {
  it('each field on its own line next to Publish, focused — no toast, no credential question', async () => {
    const onPublish = vi
      .fn()
      .mockRejectedValueOnce(
        new HttpError(
          'capability_error',
          'WorkerDefinition wd-1@1 names what is not there, so it is not published (...)',
          'unresolved_references',
          { unresolved: { skills: ['draft-only'], capabilities: ['no_such_capability'] } },
        ),
      );
    render(
      <DraftProposed
        kindLabel="Worker 定义"
        draft={{ id: 'wd-1', version: 1, status: 'draft' }}
        onPublish={onPublish}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('draft-publish'));
    const problem = await screen.findByTestId('worker-publish-references');
    await waitFor(() => expect(document.activeElement).toBe(problem));
    expect(screen.getByTestId('worker-publish-references-skills').textContent).toContain(
      '「draft-only」没有已发布的版本',
    );
    expect(screen.getByTestId('worker-publish-references-capabilities').textContent).toContain(
      '「no_such_capability」不是 Worker 能持有的能力',
    );
    // There is no editor here to open: no fix button.
    expect(screen.queryByTestId('worker-publish-references-fix')).toBeNull();
    expect(screen.queryByTestId('draft-publish-error')).toBeNull();
    expect(pushToast).not.toHaveBeenCalled();
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

  it('legacy 488: once published, Publish is gone and focus is on 完成, not <body>', async () => {
    render(
      <DraftProposed
        kindLabel="Worker"
        draft={{ id: 'wd-1', version: 1, status: 'draft', name: 'ops-runner' }}
        onPublish={vi.fn().mockResolvedValue({ status: 'published' })}
        onDone={vi.fn()}
      />,
    );
    const publish = screen.getByTestId('draft-publish');
    publish.focus();
    fireEvent.click(publish);
    await waitFor(() => expect(screen.queryByTestId('draft-publish')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('draft-done'));
  });
});
