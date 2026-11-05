// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteAccessProvider } from '../../hooks/useCanOpen.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime } from '../../lib/format.js';
import { LangProvider } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
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
      [{ where: 'entry_start', outcome: 'withheld' }, '这一轮没有开始'],
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

  const TARGET = '00000000-0000-4000-8000-0000000000a1';
  const REOPENS_AT = '2026-11-09T08:30:00.000Z';
  const REJECTED_AT = [
    '2026-11-02T08:30:00.000Z',
    '2026-11-03T08:30:00.000Z',
    '2026-11-04T08:30:00.000Z',
  ];
  function breakerPayload(rejectedCount = 3): Record<string, unknown> {
    return {
      channel: 'handle',
      sessionKind: 'admin_agent',
      outcome: 'refused',
      refusal: {
        code: 'admin_proposal_target_rejected_repeatedly',
        status: 429,
        segment: 0,
        targetWorkspaceId: TARGET,
        rejectionLimit: 3,
        windowDays: 7,
        reopensAt: REOPENS_AT,
        rejections: Array.from({ length: rejectedCount }, (_, index) => ({
          proposalId: `p${index + 1}`,
          segmentId: `s${index + 1}`,
          rejectedAt: REJECTED_AT[index] ?? REJECTED_AT[2],
        })),
      },
    };
  }
  const nobody: CapabilityCaller = { call: vi.fn(async () => ({})) as CapabilityCaller['call'] };

  it('S11 AA5a-2: says which target closed to the admin agent, until when, and links the rejected proposals', () => {
    render(
      <AuditPayloadNotes
        payload={breakerPayload()}
        workspaceNames={new Map([[TARGET, 'Ops production']])}
      />,
    );
    const note = screen.getByTestId('audit-admin-proposal-breaker');
    const text = note.textContent ?? '';
    expect(text).toContain(
      '目标工作区「Ops production」在 7 天内拒绝了这位管理员的提案 3 次，到了上限。',
    );
    expect(text).not.toContain('满 3 次');
    expect(text).toContain(`在 ${formatDateTime(REOPENS_AT)} 之前不能再向它提案，到时自动恢复`);
    expect(text).toContain('这次提案什么也没写入');
    expect(text).toContain('「平台 → 管理员提案」里，智能体看不到。');
    expect(text).toContain('被拒的是这几份（按被拒时间）：');
    expect(screen.getByTestId('audit-admin-proposal-breaker-proposals').getAttribute('href')).toBe(
      hrefs.platformAdminProposals(),
    );
    const rejections = screen.getAllByTestId('audit-admin-proposal-breaker-rejection');
    expect(rejections.map((link) => link.getAttribute('href'))).toEqual(
      ['p1', 'p2', 'p3'].map((id) => hrefs.platformAdminProposals('proposals', id)),
    );
    expect(rejections.map((link) => link.textContent)).toEqual(
      REJECTED_AT.map((at) => formatDateTime(at)),
    );
  });

  it('S11 AA5a-2: names an unknown target by a short id, says the limit when more counted, and links nothing for a reader who is not a platform administrator', () => {
    render(
      <RouteAccessProvider http={nobody} platformAdmin={false}>
        <AuditPayloadNotes payload={breakerPayload(4)} />
      </RouteAccessProvider>,
    );
    const note = screen.getByTestId('audit-admin-proposal-breaker');
    expect(note.textContent).toContain(
      '目标工作区「00000000」在 7 天内拒绝了这位管理员的提案 4 次，上限是 3 次。',
    );
    expect(note.querySelector('a')).toBeNull();
    expect(screen.getByTestId('audit-admin-proposal-breaker-proposals').textContent).toBe(
      '平台 → 管理员提案',
    );
    expect(screen.getAllByTestId('audit-admin-proposal-breaker-rejection')).toHaveLength(4);
  });

  it('S11 AA5a-2: says it in English with the counts spelled out', () => {
    localStorage.setItem('nexttime.lang', 'en');
    try {
      render(
        <LangProvider>
          <AuditPayloadNotes
            payload={breakerPayload()}
            workspaceNames={new Map([[TARGET, 'Ops production']])}
          />
        </LangProvider>,
      );
      const text = screen.getByTestId('audit-admin-proposal-breaker').textContent ?? '';
      expect(text).toContain(
        'The target workspace “Ops production” rejected this administrator’s proposals 3 times within 7 days, which is the limit, so the admin agent cannot propose to it again until',
      );
      expect(text).not.toContain('(s)');
      expect(text).toContain(
        'The owner’s reasons are under Platform → Admin proposals; the agent never sees them.',
      );
      expect(text).toContain('The rejected proposals, by when they were rejected: ');
    } finally {
      localStorage.removeItem('nexttime.lang');
    }
  });

  it('renders nothing for an ordinary payload or a malformed count', () => {
    const { container } = render(
      <>
        <AuditPayloadNotes payload={{ name: 'x' }} />
        <AuditPayloadNotes
          payload={{ redactedValues: 0, credentialReview: { suspectedSecretValues: '2' } }}
        />
        <AuditPayloadNotes
          payload={{ outcome: 'refused', refusal: { code: 'admin_agent_refused', status: 403 } }}
        />
        <AuditPayloadNotes
          payload={{
            outcome: 'refused',
            refusal: {
              code: 'admin_proposal_target_rejected_repeatedly',
              rejectionLimit: 3,
              windowDays: 7,
            },
          }}
        />
        <AuditPayloadNotes
          payload={{
            refusal: {
              code: 'admin_proposal_target_rejected_repeatedly',
              rejectionLimit: 3,
              windowDays: 7,
              reopensAt: '2026-11-09T08:30:00.000Z',
            },
          }}
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
