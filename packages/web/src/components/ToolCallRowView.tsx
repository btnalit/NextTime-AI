import { memo } from 'react';
import { formatTime, prettyJson } from '../lib/format.js';
import { type Translate, useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import type { ToolCallRow } from '../lib/streaming-reducer.js';
import { type ToolCallRecord, previewDisplayText } from '../lib/tool-call-record.js';
import { Icon } from './ui/Icon.js';

/** components/ToolCallRowView: one `toolCallStarted`/`toolCallEnded` pair (S1.8 deliverable 1:
 *  "tool-call rows from toolCallStarted/Ended") as a collapsed disclosure — name and state on the
 *  summary line, arguments and result inside. */
export function ToolCallRowView({ row }: { readonly row: ToolCallRow }) {
  const t = useT();
  const running = row.status === 'started';
  // W7: a tool call the runtime flagged `isError` reads "failed" instead of "done" — the model saw
  // an error result, which is the single most useful thing to know when reading a transcript.
  const failed = row.status === 'ended' && row.isError === true;
  const chipClass = running ? 'chip-info chip-live' : failed ? 'chip-danger' : 'chip-neutral';
  // B4 bilingual; `data-tool-outcome` stays the machine-readable hook.
  const chipLabel = running
    ? t('运行中', 'running')
    : failed
      ? t('失败', 'failed')
      : t('完成', 'done');
  return (
    <details
      className={`tool-call-row tool-call-row-${row.status}${failed ? ' tool-call-row-failed' : ''}`}
    >
      <summary>
        <Icon name="chevron-right" size="s" className="icon-chevron" />
        <span className="tool-call-name">{row.name}</span>
        <span
          className={`chip chip-s ${chipClass}`}
          data-tool-outcome={running ? 'running' : failed ? 'failed' : 'ok'}
        >
          {chipLabel}
        </span>
      </summary>
      <div className="tool-call-detail">
        {row.args !== undefined ? (
          <>
            <span className="section-title">{t('参数', 'Arguments')}</span>
            <pre className="code-block">{prettyJson(row.args)}</pre>
          </>
        ) : null}
        {row.status === 'ended' && row.result !== undefined ? (
          <>
            <span className="section-title">{t('结果', 'Result')}</span>
            <pre className="code-block">{prettyJson(row.result)}</pre>
          </>
        ) : null}
        {row.args === undefined && (row.status !== 'ended' || row.result === undefined) ? (
          <span className="text-3 text-small">
            {t('未记录参数或结果。', 'No arguments or result recorded.')}
          </span>
        ) : null}
      </div>
    </details>
  );
}

function outcomeChip(record: ToolCallRecord, t: Translate): { className: string; label: string } {
  switch (record.outcome) {
    case 'failed':
      return { className: 'chip-danger', label: t('失败', 'failed') };
    case 'not_finished':
      return { className: 'chip-warn', label: t('未完成', 'not finished') };
    default:
      return { className: 'chip-neutral', label: t('完成', 'done') };
  }
}

/** One persisted tool call (`lib/tool-call-record`) — the same disclosure as a live row, plus what
 *  the kernel did to the preview (cut, values hidden) and when the call started and ended. */
export function PersistedToolCallRowView({ record }: { readonly record: ToolCallRecord }) {
  const t = useT();
  const chip = outcomeChip(record, t);
  const name = record.name ?? t('（未知工具）', '(unknown tool)');
  return (
    <details
      className={`tool-call-row tool-call-row-${record.outcome}`}
      data-testid="tool-call-record"
      data-tool-call-id={record.toolCallId}
    >
      <summary>
        <Icon name="chevron-right" size="s" className="icon-chevron" />
        <span className="tool-call-name">{name}</span>
        <span className={`chip chip-s ${chip.className}`} data-tool-outcome={record.outcome}>
          {chip.label}
        </span>
        {record.startedAt ? (
          <span className="text-3 text-small" data-volatile="">
            {formatTime(record.startedAt)}
            {record.endedAt ? `–${formatTime(record.endedAt)}` : ''}
          </span>
        ) : null}
      </summary>
      <div className="tool-call-detail">
        {record.args ? (
          <>
            <span className="section-title">{t('参数', 'Arguments')}</span>
            <pre className="code-block">{previewDisplayText(record.args)}</pre>
            {record.args.truncated ? (
              <span className="text-3 text-small">
                {t(
                  `已截断，原文至少 ${record.args.totalChars} 字符`,
                  `Cut short — at least ${record.args.totalChars} characters`,
                )}
              </span>
            ) : null}
          </>
        ) : null}
        {record.result ? (
          <>
            <span className="section-title">{t('结果', 'Result')}</span>
            <pre className="code-block">{previewDisplayText(record.result)}</pre>
            {record.result.truncated ? (
              <span className="text-3 text-small">
                {t(
                  `已截断，原文至少 ${record.result.totalChars} 字符`,
                  `Cut short — at least ${record.result.totalChars} characters`,
                )}
              </span>
            ) : null}
          </>
        ) : null}
        {!record.args && !record.result ? (
          <span className="text-3 text-small">
            {record.outcome === 'not_finished'
              ? t(
                  '本轮结束时这次调用还没有结束，没有结果。',
                  'The turn ended before this call finished — there is no result.',
                )
              : t('未记录参数或结果。', 'No arguments or result recorded.')}
          </span>
        ) : null}
        {record.redactedValues > 0 ? (
          <span className="text-3 text-small" data-testid="tool-call-redacted">
            {t(
              `已隐藏 ${record.redactedValues} 处疑似凭据`,
              `${record.redactedValues} credential-like value(s) hidden`,
            )}
          </span>
        ) : null}
      </div>
    </details>
  );
}

/** A Turn's persisted tool calls, folded into one disclosure above its reply — collapsed unless a
 *  call failed or did not finish, which is the case a reader opens it for. Memoized: ChatPage
 *  re-renders on every streamed delta, and `records` (from `threadItems`, memoized on
 *  `messages`) keeps its identity meanwhile, so the history's previews are not re-formatted per
 *  delta. */
export const ToolCallGroupView = memo(function ToolCallGroupView({
  records,
}: { readonly records: readonly ToolCallRecord[] }) {
  const t = useT();
  const failed = records.filter((r) => r.outcome === 'failed').length;
  const unfinished = records.filter((r) => r.outcome === 'not_finished').length;
  return (
    <details
      className="tool-call-group"
      open={failed + unfinished > 0}
      data-testid="tool-call-group"
    >
      <summary>
        <Icon name="chevron-right" size="s" className="icon-chevron" />
        <span>
          {t(`本轮调用了 ${records.length} 个工具`, `${records.length} tool call(s) this turn`)}
        </span>
        {failed > 0 ? (
          <span className="chip chip-s chip-danger">
            {t(`${failed} 个失败`, `${failed} failed`)}
          </span>
        ) : null}
        {unfinished > 0 ? (
          <span className="chip chip-s chip-warn">
            {t(`${unfinished} 个未完成`, `${unfinished} not finished`)}
          </span>
        ) : null}
      </summary>
      <div className="tool-calls">
        <span className="text-3 text-small">
          {t(
            'agent 自己报告的调用，参数和结果已脱敏、截断。能力调用的权威记录在',
            'Reported by the agent; arguments and results are redacted and shortened. The authoritative record of capability calls is the',
          )}{' '}
          <a href={hrefs.audit()}>{t('审计', 'audit log')}</a>
          {t('。', '.')}
        </span>
        {records.map((record) => (
          <PersistedToolCallRowView key={record.toolCallId} record={record} />
        ))}
      </div>
    </details>
  );
});
