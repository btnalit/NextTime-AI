// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBody } from './MessageBody.js';

afterEach(cleanup);

// The assistant branch renders through `React.lazy` (S8 W1-A2: keeps react-markdown/remark-gfm
// out of the main chunk — see MessageBody.tsx's own module doc comment for the measured size).
// Its Suspense fallback shows the raw text first; every assertion on the *rendered Markdown* below
// waits for the lazy chunk's dynamic import() to resolve — a longer `waitFor` timeout than the
// 1000ms default, since a cold Vitest transform cache for react-markdown/remark-gfm's first
// dynamic import can occasionally take longer than that (observed ~1.3s on a cold run).
const LAZY_TIMEOUT = { timeout: 5000 };

describe('chat/MessageBody', () => {
  it('renders a user message as plain text — a literal "*" is not emphasis', () => {
    const { container } = render(
      <MessageBody messageRole="user" text={'*not bold* — literal text'} />,
    );
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('.message-bubble')?.textContent).toBe(
      '*not bold* — literal text',
    );
  });

  it('renders an assistant message through the Markdown kit component', async () => {
    render(<MessageBody messageRole="assistant" text={'**bold** text'} />);
    await waitFor(() => expect(screen.getByText('bold').tagName).toBe('STRONG'), LAZY_TIMEOUT);
  });

  it('keeps the .message-text selector other suites/e2e depend on, for both roles', async () => {
    const user = render(<MessageBody messageRole="user" text="hi" />);
    expect(user.container.querySelector('.message-bubble.message-text')).toBeTruthy();
    cleanup();
    const assistant = render(<MessageBody messageRole="assistant" text="hi" />);
    // True even during the Suspense fallback — the wrapping div is not part of what suspends.
    expect(assistant.container.querySelector('.message-bubble.message-text')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('hi').tagName).toBe('P'), LAZY_TIMEOUT);
  });

  it('resets white-space to normal only for the Markdown (assistant) branch, so a single "\\n" is a soft break, not a hard one', async () => {
    const assistant = render(<MessageBody messageRole="assistant" text={'line one\nline two'} />);
    const bubble = assistant.container.querySelector('.message-bubble') as HTMLElement;
    expect(bubble.style.whiteSpace).toBe('normal');
    // A single soft break inside one paragraph collapses to one <p>, not two — once the lazy
    // Markdown chunk has resolved (the Suspense fallback is a bare <span>, no <p> at all).
    await waitFor(
      () => expect(assistant.container.querySelectorAll('p')).toHaveLength(1),
      LAZY_TIMEOUT,
    );
    cleanup();

    const user = render(<MessageBody messageRole="user" text={'line one\nline two'} />);
    const userBubble = user.container.querySelector('.message-bubble') as HTMLElement;
    // Plain-text branch keeps the CSS pre-wrap (styles/pages.css) — no inline override.
    expect(userBubble.style.whiteSpace).toBe('');
  });

  it('appends `trailing` after the content, for the streaming caret', () => {
    // Present even during the Suspense fallback — trailing is a sibling of Suspense, not inside it.
    const { container } = render(
      <MessageBody messageRole="assistant" text="typing" trailing={<span data-testid="caret" />} />,
    );
    expect(container.querySelector('[data-testid="caret"]')).toBeTruthy();
  });

  it('does not render Markdown for tool/system roles', () => {
    const { container } = render(<MessageBody messageRole="system" text={'# not a heading'} />);
    expect(container.querySelector('h1')).toBeNull();
  });
});
