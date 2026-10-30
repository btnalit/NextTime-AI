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

  it('says a call that asks nobody (an observation, invoke_worker) only recorded them — never 「已确认」', () => {
    render(
      <AuditPayloadNotes
        payload={{ credentialReview: { suspectedSecretValues: 1, suspectedSecretPaths: ['q'] } }}
      />,
    );
    const note = screen.getByTestId('audit-credential-review');
    expect(note.textContent).toContain('已记录');
    expect(note.textContent).not.toContain('已确认');
  });

  it('legacy 168 ③: says how many Handles an upgrade revoked', () => {
    render(
      <AuditPayloadNotes
        payload={{
          by: 'migration governance/0018_container_held_handles_revoked',
          revokedHandleCount: 4,
        }}
      />,
    );
    expect(screen.getByTestId('audit-revoked-handles').textContent).toContain('吊销了 4 个凭证');
  });

  it('S10 E3-1c: says where the evaluation seal stopped content, what that left, and that the record holds none of it', () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { where: 'capability_result', rolledBack: true, outcome: 'withheld' },
        '调用写进平台的内容已撤回',
      ],
      [{ where: 'capability_result', rolledBack: false, outcome: 'withheld' }, '调用本身已经生效'],
      [{ where: 'capability_error', outcome: 'withheld' }, '错误信息里有评测用例集保留的内容'],
      [{ where: 'worker_start', outcome: 'withheld' }, '没有启动，任务记为启动失败'],
      [{ where: 'entry_turn', outcome: 'withheld' }, '没有发给智能体，也没有保存'],
    ];
    for (const [payload, says] of cases) {
      render(<AuditPayloadNotes payload={{ onBehalfOf: 'p', ...payload }} />);
      const note = screen.getByTestId('audit-evaluation-withheld').textContent;
      expect(note).toContain(says);
      expect(note).toContain('不写拦下的是哪段内容');
      cleanup();
    }
    // Another row's `outcome` is not this note.
    render(<AuditPayloadNotes payload={{ where: 'somewhere', outcome: 'withheld' }} />);
    expect(screen.queryByTestId('audit-payload-notes')).toBeNull();
  });

  it('S10 E3-1b: names what an evaluation case write keeps out of the record, and where to read it', () => {
    render(
      <AuditPayloadNotes
        payload={{
          params: { suiteId: 's', input: '[withheld]', assertions: '[withheld]' },
          withheldParams: ['input', 'assertions'],
        }}
      />,
    );
    const note = screen.getByTestId('audit-withheld-params').textContent;
    expect(note).toContain('评测用例的输入、断言不写进审计记录');
    expect(note).toContain('治理 → 评测');
    // Not a credential note: nothing was masked.
    expect(screen.queryByTestId('audit-redacted-values')).toBeNull();
  });

  it('says how many values were hidden from the parameters', () => {
    render(<AuditPayloadNotes payload={{ redactedValues: 3 }} />);
    const note = screen.getByTestId('audit-redacted-values').textContent;
    expect(note).toContain('隐藏了参数中的 3 处疑似凭据');
    // Only the audit copy is redacted — the call ran with the values as sent.
    expect(note).toContain('调用本身按原样执行');
  });

  it('legacy 420: says what a [redacted] outside the counted params stands for', () => {
    render(
      <AuditPayloadNotes
        payload={{
          redactedValues: 1,
          params: { apiKey: '[redacted]' },
          after: 'call it with Authorization: [redacted]',
        }}
      />,
    );
    expect(screen.getByTestId('audit-payload-redacted').textContent).toContain(
      '[redacted] 处的内容看起来像密码',
    );
  });

  it('legacy 420: leaves a [redacted] the params count already explains to that line', () => {
    render(<AuditPayloadNotes payload={{ redactedValues: 1, params: { apiKey: '[redacted]' } }} />);
    expect(screen.getByTestId('audit-redacted-values')).toBeTruthy();
    expect(screen.queryByTestId('audit-payload-redacted')).toBeNull();
  });

  it('legacy 420: explains a field the console masks by its name when nothing counted it', () => {
    render(<AuditPayloadNotes payload={{ params: { password: 'plain-word' } }} />);
    expect(screen.getByTestId('audit-payload-redacted')).toBeTruthy();
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
