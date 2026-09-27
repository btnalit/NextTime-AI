// @vitest-environment jsdom
import type { FactWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { linkError } from './AttestFactDialog.js';
import { FactRow } from './FactRow.js';
import { parseFactValue, valueChanges } from './SupersedeFactDialog.js';
import { FACTS, NOW, type ScriptedHttp, fact, iso, scriptedHttp } from './test-fixtures.js';

// The row pushes its toasts through the app's toast hook; observe the pushes directly (this test
// file stays off the legacy `components/ui/*` import allowlist).
const toastPush = vi.hoisted(() => vi.fn());
vi.mock('../ui/Toast.js', () => ({
  useToast: () => ({ push: toastPush, dismiss: () => undefined }),
}));

afterEach(() => {
  cleanup();
  toastPush.mockClear();
});

function expectToast(title: string): void {
  expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ tone: 'ok', title }));
}

/**
 * components/graph/FactRow.test: the Fact row's write actions — STATUS leftover 89's 附人工确认
 * (`attest_fact`, then 验证 goes through) and coverage gap G2's 取代 / 作废 (`supersede_fact`,
 * `invalidate_fact`), each behind its own confirm surface, all from the row's 更多 menu.
 */

const F1 = FACTS[0] as FactWire;

function renderRow(
  options: {
    readonly http?: ScriptedHttp;
    readonly fact?: FactWire;
    readonly onFactChanged?: () => void;
  } = {},
) {
  const onFactChanged = options.onFactChanged ?? vi.fn();
  render(
    <ul>
      <FactRow
        fact={options.fact ?? F1}
        objectId="h-1"
        asOf={NOW}
        onExpand={() => undefined}
        onProvenance={() => undefined}
        http={options.http}
        onFactChanged={onFactChanged}
      />
    </ul>,
  );
  return { onFactChanged };
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByTestId('graph-fact-menu'), { button: 0 });
}

async function choose(testId: string): Promise<void> {
  openMenu();
  fireEvent.click(await screen.findByTestId(testId));
}

describe('FactRow — row menu availability', () => {
  it('offers the menu (and 验证) only for an active Fact with a capability caller', () => {
    renderRow({ http: scriptedHttp() });
    expect(screen.getByTestId('graph-fact-menu')).toBeTruthy();
    expect(screen.getByTestId('graph-fact-verify')).toBeTruthy();
    cleanup();

    renderRow();
    expect(screen.queryByTestId('graph-fact-menu')).toBeNull();
    cleanup();

    renderRow({ http: scriptedHttp(), fact: fact({ id: 'f-old', supersededAt: iso(-1000) }) });
    expect(screen.queryByTestId('graph-fact-menu')).toBeNull();
    expect(screen.queryByTestId('graph-fact-verify')).toBeNull();
    cleanup();

    renderRow({ http: scriptedHttp(), fact: fact({ id: 'f-gone', invalidatedAt: iso(-1000) }) });
    expect(screen.queryByTestId('graph-fact-menu')).toBeNull();
  });

  it('lists 附人工确认, 取代 and 作废', async () => {
    renderRow({ http: scriptedHttp() });
    openMenu();
    expect((await screen.findByTestId('graph-fact-attest')).textContent).toBe('附人工确认');
    expect(screen.getByTestId('graph-fact-supersede').textContent).toBe('取代…');
    expect(screen.getByTestId('graph-fact-invalidate').textContent).toBe('作废…');
  });
});

describe('FactRow — 附人工确认 (leftover 89)', () => {
  function attestHttp(overrides: Record<string, (params: unknown) => unknown> = {}) {
    return scriptedHttp({
      attest_fact: (params) => {
        const { factId, note, link } = params as { factId: string; note: string; link?: string };
        return {
          id: 'ev-1',
          factId,
          kind: 'human_attestation',
          note,
          link: link ?? null,
          activityId: 'act-att-1',
          attestedBy: 'p-me',
          createdAt: iso(0),
        };
      },
      verify_fact: () => ({ ...F1, epistemicStatus: 'verified', verifiedBy: 'p-me' }),
      ...overrides,
    });
  }

  it('says it is recorded as the person’s own audited confirmation, requires a note, validates the link, then calls attest_fact', async () => {
    const http = attestHttp();
    const { onFactChanged } = renderRow({ http });
    await choose('graph-fact-attest');

    const dialog = await screen.findByTestId('attest-fact-dialog');
    const notice = within(dialog).getByTestId('attest-fact-notice');
    expect(notice.textContent).toContain('你本人的名义');
    expect(notice.textContent).toContain('人工确认');
    expect(notice.textContent).toContain('机器证据');
    expect(notice.textContent).toContain('审计');
    const submit = within(dialog).getByTestId('attest-fact-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // A blank note is flagged once the person leaves the field.
    const note = within(dialog).getByTestId('attest-fact-note');
    fireEvent.change(note, { target: { value: '   ' } });
    fireEvent.blur(note);
    expect(dialog.textContent).toContain('请写下你确认了什么');
    expect(submit.disabled).toBe(true);

    // Only an http(s) link is accepted.
    fireEvent.change(note, { target: { value: '  到机房核对过  ' } });
    const link = within(dialog).getByTestId('attest-fact-link');
    fireEvent.change(link, { target: { value: 'javascript:alert(1)' } });
    expect(dialog.textContent).toContain('链接需以 http:// 或 https:// 开头');
    expect(submit.disabled).toBe(true);
    fireEvent.change(link, { target: { value: 'https://ticket.example/42' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByTestId('attest-fact-dialog')).toBeNull());
    expect(http.callsTo('attest_fact')).toEqual([
      { factId: 'f-1', note: '到机房核对过', link: 'https://ticket.example/42' },
    ]);
    expectToast('已附人工确认');
    // An attestation changes no Fact field — no re-read.
    expect(onFactChanged).not.toHaveBeenCalled();
  });

  it('omits the link when none is given', async () => {
    const http = attestHttp();
    renderRow({ http });
    await choose('graph-fact-attest');
    const dialog = await screen.findByTestId('attest-fact-dialog');
    fireEvent.change(within(dialog).getByTestId('attest-fact-note'), {
      target: { value: '与负责人确认过' },
    });
    fireEvent.click(within(dialog).getByTestId('attest-fact-submit'));
    await waitFor(() => expect(http.callsTo('attest_fact')).toHaveLength(1));
    expect(http.callsTo('attest_fact')[0]).toEqual({ factId: 'f-1', note: '与负责人确认过' });
  });

  it('keeps the dialog open with the kernel’s reason when the call is refused', async () => {
    const http = attestHttp({
      attest_fact: () => {
        throw new HttpError('capability_error', 'attest_fact: Fact f-1 is superseded', 'conflict');
      },
    });
    renderRow({ http });
    await choose('graph-fact-attest');
    const dialog = await screen.findByTestId('attest-fact-dialog');
    fireEvent.change(within(dialog).getByTestId('attest-fact-note'), { target: { value: 'n' } });
    fireEvent.click(within(dialog).getByTestId('attest-fact-submit'));
    const error = await within(dialog).findByTestId('attest-fact-error');
    expect(error.getAttribute('data-error-code')).toBe('conflict');
    expect(error.textContent).toContain('superseded');
    expect(screen.getByTestId('attest-fact-dialog')).toBeTruthy();
  });

  it('then 验证 goes through: verify_fact is called and the row re-reads', async () => {
    const http = attestHttp();
    const { onFactChanged } = renderRow({ http });
    await choose('graph-fact-attest');
    const dialog = await screen.findByTestId('attest-fact-dialog');
    fireEvent.change(within(dialog).getByTestId('attest-fact-note'), { target: { value: 'ok' } });
    fireEvent.click(within(dialog).getByTestId('attest-fact-submit'));
    await waitFor(() => expect(screen.queryByTestId('attest-fact-dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('graph-fact-verify'));
    const confirm = await screen.findByTestId('graph-fact-verify-confirm');
    expect(confirm.textContent).toContain('附人工确认');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(onFactChanged).toHaveBeenCalledTimes(1));
    expect(http.callsTo('verify_fact')).toEqual([{ factId: 'f-1' }]);
  });
});

describe('FactRow — 作废 (coverage gap G2)', () => {
  it('lists the Fact and the consequences, requires a reason, then calls invalidate_fact', async () => {
    const http = scriptedHttp({
      invalidate_fact: () => ({ ...F1, invalidatedAt: iso(0), invalidationReason: 'gone' }),
    });
    const { onFactChanged } = renderRow({ http });
    await choose('graph-fact-invalidate');

    const confirm = await screen.findByTestId('graph-fact-invalidate-confirm');
    expect(within(confirm).getByTestId('confirm-target').textContent).toContain('runs_on');
    const impact = within(confirm).getByTestId('confirm-impact').textContent ?? '';
    expect(impact).toContain('不能撤回');
    expect(impact).toContain('审计');
    const confirmButton = within(confirm).getByTestId('confirm-button') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(within(confirm).getByTestId('graph-fact-invalidate-reason'), {
      target: { value: '  上周已下线  ' },
    });
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(onFactChanged).toHaveBeenCalledTimes(1));
    expect(http.callsTo('invalidate_fact')).toEqual([{ factId: 'f-1', reason: '上周已下线' }]);
    expectToast('已作废');
  });
});

describe('FactRow — 取代 (coverage gap G2)', () => {
  it('edits the value on the same identity, reviews the changes, then calls supersede_fact', async () => {
    const current = fact({ id: 'f-7', properties: { port: 80 } });
    const http = scriptedHttp({
      supersede_fact: (params) => ({
        ...current,
        id: 'f-8',
        supersedesId: 'f-7',
        properties: (params as { properties: Record<string, unknown> }).properties,
      }),
    });
    const { onFactChanged } = renderRow({ http, fact: current });
    await choose('graph-fact-supersede');

    const dialog = await screen.findByTestId('supersede-fact-dialog');
    const value = within(dialog).getByTestId('supersede-fact-value') as HTMLTextAreaElement;
    expect(JSON.parse(value.value)).toEqual({ port: 80 });
    const review = within(dialog).getByTestId('supersede-fact-review') as HTMLButtonElement;
    // Unchanged, not JSON, not an object — each refused before the review step.
    expect(review.disabled).toBe(true);
    expect(dialog.textContent).toContain('新值与当前值相同');
    fireEvent.change(value, { target: { value: '{ nope' } });
    expect(dialog.textContent).toContain('不是有效的');
    fireEvent.change(value, { target: { value: '[1]' } });
    expect(dialog.textContent).toContain('新值必须是一个 JSON 对象');
    expect(review.disabled).toBe(true);

    fireEvent.change(value, { target: { value: '{"port": 81, "proto": "tcp"}' } });
    expect(review.disabled).toBe(false);
    fireEvent.click(review);

    await waitFor(() =>
      expect(screen.getByTestId('supersede-fact-dialog').getAttribute('data-step')).toBe('review'),
    );
    const changes = screen.getByTestId('supersede-fact-changes');
    const rows = within(changes).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-change'))).toEqual(['changed', 'added']);
    expect(rows[0]?.textContent).toContain('80 → 81');
    expect(screen.getByTestId('supersede-fact-impact').textContent).toContain('审计');
    expect(http.callsTo('supersede_fact')).toEqual([]);

    fireEvent.click(screen.getByTestId('supersede-fact-confirm'));
    await waitFor(() => expect(onFactChanged).toHaveBeenCalledTimes(1));
    expect(http.callsTo('supersede_fact')).toEqual([
      {
        factId: 'f-7',
        sourceObjectId: current.sourceObjectId,
        targetObjectId: current.targetObjectId,
        linkType: current.linkType,
        properties: { port: 81, proto: 'tcp' },
      },
    ]);
    await waitFor(() => expect(screen.queryByTestId('supersede-fact-dialog')).toBeNull());
    expectToast('已取代');
  });
});

describe('dialog helpers', () => {
  it('linkError accepts blank and http(s), flags other schemes and overlong links', () => {
    expect(linkError('')).toBeNull();
    expect(linkError('  https://a.example/x ')).toBeNull();
    expect(linkError('http://a.example')).toBeNull();
    expect(linkError('javascript:alert(1)')).toBe('scheme');
    expect(linkError('file:///etc/passwd')).toBe('scheme');
    expect(linkError(`https://a.example/${'x'.repeat(3000)}`)).toBe('length');
  });

  it('parseFactValue requires a JSON object', () => {
    expect(parseFactValue('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseFactValue('nope')).toEqual({ ok: false, reason: 'json' });
    expect(parseFactValue('null')).toEqual({ ok: false, reason: 'object' });
    expect(parseFactValue('[]')).toEqual({ ok: false, reason: 'object' });
  });

  it('valueChanges ignores key order and reports added / removed / changed keys', () => {
    expect(valueChanges({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
    expect(valueChanges({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual([
      { key: 'a', kind: 'removed', before: '1' },
      { key: 'b', kind: 'changed', before: '2', after: '3' },
      { key: 'c', kind: 'added', after: '4' },
    ]);
  });
});
