// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HeldDraftsNotice, ManifestPublishResultNotice } from './GateOwnedParams.js';

/**
 * GateOwnedParams.test.tsx (console G4, legacy 219): the bulk publish's held-back drafts, said with
 * their params in plain words, each linked to its catalog draft, and the next step that fits the
 * gate — align for a platform gate, connect again for one the workspace connected itself.
 */

afterEach(cleanup);

const HELD = [
  {
    name: 'stock.reserve',
    params: [
      { param: 'Authorization', location: 'header' as const },
      { param: 'access_token', location: 'query' as const },
    ],
  },
];

describe('HeldDraftsNotice', () => {
  it('names each held draft with its params, links it to the catalog, and says the platform gate’s next step', () => {
    render(<HeldDraftsNotice drafts={HELD} gatekeeperId="gk-1" fix="align" testId="held" />);
    const notice = screen.getByTestId('held');
    expect(notice.textContent).toContain('1 个 Operation 没有发布');
    expect(notice.textContent).toContain(
      'stock.reserve：Authorization（请求头）、access_token（查询参数里的凭据）',
    );
    expect(notice.textContent).toContain('与门公告对齐');
    expect(within(notice).getByText('stock.reserve').closest('a')?.getAttribute('href')).toBe(
      '#/govern/catalog/operations/gk-1%3A%3Astock.reserve',
    );
  });

  it('a self-connected gate is told to re-read its manifest, never to align or connect again (legacy 214)', () => {
    render(<HeldDraftsNotice drafts={HELD} gatekeeperId="gk-1" fix="resync" testId="held" />);
    const notice = screen.getByTestId('held');
    expect(notice.textContent).toContain('重新读取门的清单');
    expect(notice.textContent).not.toContain('与门公告对齐');
    expect(notice.textContent).not.toContain('重新接入');
  });

  it('renders nothing when nothing was held back (or an older kernel left the field out)', () => {
    const { container } = render(
      <>
        <HeldDraftsNotice drafts={[]} gatekeeperId="gk-1" fix="align" />
        <HeldDraftsNotice drafts={undefined} gatekeeperId="gk-1" fix="align" />
      </>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('ManifestPublishResultNotice', () => {
  it('says what was published, what was held back, and which proposals wait for a one-by-one publish', () => {
    render(
      <ManifestPublishResultNotice
        result={{
          gatekeeperId: 'gk-1',
          publishedOperationNames: ['stock.get'],
          skippedDraftOperationNames: ['stock.export'],
          gateOwnedParamDrafts: HELD,
          absentAnswerDrafts: [{ name: 'stock.lookup', absentAnswers: { statuses: [404] } }],
          credentialDrafts: [],
        }}
        fix="resync"
        testId="result"
      />,
    );
    expect(screen.getByTestId('result-published').textContent).toContain('已发布 1 个');
    expect(screen.getByTestId('result-held').textContent).toContain('stock.reserve');
    const proposals = screen.getByTestId('result-proposals');
    expect(proposals.textContent).toContain('1 份草稿是 agent 或成员提出的');
    expect(within(proposals).getByText('stock.export').closest('a')?.getAttribute('href')).toBe(
      '#/govern/catalog/operations/gk-1%3A%3Astock.export',
    );
    const absent = screen.getByTestId('result-absent');
    expect(absent.textContent).toContain('1 个 Operation 留作草稿，等人确认后发布');
    expect(absent.textContent).toContain('目标系统回答 404 时表示不存在');
    expect(within(absent).getByText('stock.lookup').closest('a')?.getAttribute('href')).toBe(
      '#/govern/catalog/operations/gk-1%3A%3Astock.lookup',
    );
  });
});

describe('ManifestPublishResultNotice — legacy 800', () => {
  it('lists the drafts held for suspected credentials by name and place, each linked to its draft, with the next step that fits the gate', () => {
    render(
      <ManifestPublishResultNotice
        result={{
          gatekeeperId: 'gk-1',
          publishedOperationNames: ['stock.get'],
          skippedDraftOperationNames: [],
          gateOwnedParamDrafts: [],
          absentAnswerDrafts: [],
          credentialDrafts: [
            {
              name: 'stock.login',
              suspectedSecretValues: 2,
              suspectedSecretPaths: ['description', 'params_schema.properties.password.example'],
            },
            { name: 'stock.audit', suspectedSecretValues: 1, suspectedSecretPaths: [] },
          ],
        }}
        fix="resync"
        testId="result"
      />,
    );
    const held = screen.getByTestId('result-credentials');
    expect(held.getAttribute('data-tone')).toBe('warn');
    expect(held.textContent).toContain('2 个 Operation 没有发布，还是草稿');
    const login = screen.getAllByTestId('result-credentials-item')[0];
    expect(login?.textContent).toContain('stock.login：2 处疑似凭据，在');
    // UX acceptance of #1370: the definition's top-level fields read as words.
    expect(login?.textContent).toContain('描述、参数定义.properties.password.example');
    // The console never shows the values: the next step points at the gate's document.
    expect(held.textContent).toContain('控制台不显示这些值');
    // A kernel that named no place still says how many.
    expect(held.textContent).toContain('stock.audit：1 处疑似凭据');
    expect(held.textContent).not.toContain('stock.audit：1 处疑似凭据，在');
    expect(within(held).getByText('stock.login').closest('a')?.getAttribute('href')).toBe(
      '#/govern/catalog/operations/gk-1%3A%3Astock.login',
    );
    expect(held.textContent).toContain('勾选「已核对凭据」后发布');
    expect(held.textContent).toContain('重新读取门的清单');
    expect(held.textContent).not.toContain('与门公告对齐');
    expect(screen.getAllByTestId('result-credentials-item')).toHaveLength(2);
  });

  it('says nothing when no draft was held for credentials, or an older kernel left the field out', () => {
    const result = {
      gatekeeperId: 'gk-1',
      publishedOperationNames: ['stock.get'],
      skippedDraftOperationNames: [],
      gateOwnedParamDrafts: [],
      absentAnswerDrafts: [],
    };
    const { rerender } = render(
      <ManifestPublishResultNotice
        result={{ ...result, credentialDrafts: [] }}
        fix="align"
        testId="result"
      />,
    );
    expect(screen.queryByTestId('result-credentials')).toBeNull();
    rerender(
      <ManifestPublishResultNotice
        result={result as unknown as Parameters<typeof ManifestPublishResultNotice>[0]['result']}
        fix="align"
        testId="result"
      />,
    );
    expect(screen.queryByTestId('result-credentials')).toBeNull();
  });
});
