import type { ToolCallRow } from '../lib/streaming-reducer.js';

function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** components/ToolCallRowView: one `toolCallStarted`/`toolCallEnded` pair
 *  (docs/development-tasks.md S1.8 deliverable 1: "tool-call rows from toolCallStarted/Ended"). */
export function ToolCallRowView({ row }: { readonly row: ToolCallRow }) {
  const args = stringifyUnknown(row.args);
  const result = stringifyUnknown(row.result);
  return (
    <div className={`tool-call-row tool-call-row-${row.status}`}>
      <span className="tool-call-name">{row.name}</span>
      <span className="tool-call-status">{row.status === 'started' ? 'running…' : 'done'}</span>
      {args && <code className="tool-call-args">{args}</code>}
      {row.status === 'ended' && result && <code className="tool-call-result">{result}</code>}
    </div>
  );
}
