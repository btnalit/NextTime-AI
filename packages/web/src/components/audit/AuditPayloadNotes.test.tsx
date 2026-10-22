// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialReview } from '../kit/credential-review.js';
import { AuditPayloadNotes } from './AuditPayloadNotes.js';

afterEach(cleanup);

describe('AuditPayloadNotes (legacy 159, 178)', () => {
  it('says a person confirmed the suspected credentials', () => {
    render(
      <AuditPayloadNotes
        payload={{ credentialReview: { suspectedSecretValues: 2, confirmed: true } }}
      />,
    );
    const note = screen.getByTestId('audit-credential-review');
    expect(note.textContent).toContain('含 2 处疑似凭据');
    expect(note.textContent).toContain('已确认');
    expect(note.dataset.confirmed).toBe('true');
  });

  it('says an observation only recorded them — never 「已确认」', () => {
    render(
      <AuditPayloadNotes
        payload={{ credentialReview: { suspectedSecretValues: 1, suspectedSecretPaths: ['q'] } }}
      />,
    );
    const note = screen.getByTestId('audit-credential-review');
    expect(note.textContent).toContain('已记录');
    expect(note.textContent).not.toContain('已确认');
  });

  it('says how many values were hidden from the parameters', () => {
    render(<AuditPayloadNotes payload={{ redactedValues: 3 }} />);
    expect(screen.getByTestId('audit-redacted-values').textContent).toContain(
      '参数中已隐藏 3 处疑似凭据',
    );
  });

  it('renders nothing for an ordinary payload or a malformed count', () => {
    const { container } = render(
      <>
        <AuditPayloadNotes payload={{ name: 'x' }} />
        <AuditPayloadNotes
          payload={{ redactedValues: 0, credentialReview: { suspectedSecretValues: '2' } }}
        />
        <AuditPayloadNotes payload={null} />
        <AuditPayloadNotes payload={[1]} />
      </>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('CredentialReview — a truncated path list (legacy 178)', () => {
  it('says the total and that only the first fields are listed, not a bare 「等」', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `field${i}`);
    render(
      <CredentialReview
        count={31}
        paths={paths}
        subject="publish"
        checked={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('credential-review-more').textContent).toBe(
      '等（共 31 处疑似值，这里只列出前 20 个字段）',
    );
  });

  it('lists no 「等」 when every field is shown', () => {
    render(
      <CredentialReview
        count={5}
        paths={['a', 'b']}
        subject="publish"
        checked={false}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId('credential-review-more')).toBeNull();
  });
});
