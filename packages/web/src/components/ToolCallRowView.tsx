import { prettyJson } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import type { ToolCallRow } from '../lib/streaming-reducer.js';
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
