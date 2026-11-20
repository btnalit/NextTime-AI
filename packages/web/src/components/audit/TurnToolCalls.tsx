import type { TurnToolCallsWire } from '@nexttime/shared';
import { useMemo } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { type ToolCallRecord, toolCallRecordFromMessage } from '../../lib/tool-call-record.js';
import { PersistedToolCallRowView } from '../ToolCallRowView.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { SkeletonRows } from '../kit/skeleton.js';

/**
 * components/audit/TurnToolCalls (legacy 255, 审计 P1-15 余项): under `explain` of an agent Turn
 * (the chat's 「本轮记录」 chip lands here), the tool calls that Turn made — read with
 * `get_turn_tool_calls{turnId}`, which reads them as `get_chat_history` does (the Turn's Chat must
 * be one the reader can read; stored redacted). Each call is the chat's own persisted row
 * (`PersistedToolCallRowView`, which takes a record and nothing of the chat's live state), oldest
 * first. A Turn that called no tool says so (an empty list, not an error); more than the kernel
 * lists (100) says only the first are here and links to the Chat, which has them all. Each call's
 * start carries its date unless it is today (UX review on #1517: a Turn read here may be days old).
 * A call this console cannot read (a kernel newer than it) is not listed but is counted, so a Turn
 * whose calls were all unreadable never reads as one that called none; `turn_not_found` offers no
 * retry, the kernel answers it the same way every time (console review on #1517).
 */
export function TurnToolCalls({
  http,
  turnId,
}: {
  readonly http: CapabilityCaller;
  readonly turnId: string;
}) {
  const t = useT();
  const calls = useCapability<TurnToolCallsWire>(http, 'get_turn_tool_calls', { turnId });
  const state = calls.state;
  const data = state.status === 'ready' ? state.data : null;
  // A row the console cannot read as a tool-call record (a kernel newer than this console) is left
  // out rather than shown as an empty call; the count says how many are listed.
  const records = useMemo<readonly ToolCallRecord[]>(
    () =>
      data === null
        ? []
        : data.items
            .map((message) => toolCallRecordFromMessage(message))
            .filter((record): record is ToolCallRecord => record !== null),
    [data],
  );
  // Calls the kernel listed that the console could not read: left out, said, never "no calls".
  const unreadable = data === null ? 0 : data.items.length - records.length;
  // A role that may not call it has nothing to show here; `explain` above still stands.
  if (state.status === 'error' && isForbiddenError(state.error)) return null;
  // The kernel answers a Turn it cannot show (gone, or the reader may not read its chat) with the
  // same 404 every time: retrying only fails again.
  const retryable =
    state.status !== 'error' || describeError(state.error).code !== 'turn_not_found';

  return (
    <div className="stack-s" data-testid="explain-turn-tool-calls">
      <span className="section-title">{t('这一轮的工具调用', 'Tool calls in this turn')}</span>
      {state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label={t('正在读取工具调用', 'Loading tool calls')}
          testId="explain-turn-tool-calls-loading"
        />
      ) : state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取这一轮的工具调用', "Could not read this turn's tool calls")}
          overrides={{
            turn_not_found: t(
              '读不到这一轮所在的对话：它可能已被删除，或你没有权限读它。',
              'The chat this turn belongs to cannot be read: it may have been deleted, or you may not have access to it.',
            ),
          }}
          onRetry={retryable ? () => void calls.reload() : undefined}
          testId="explain-turn-tool-calls-error"
        />
      ) : data === null ? null : records.length === 0 ? (
        <p className="text-3" data-testid="explain-turn-tool-calls-empty">
          {unreadable === 0
            ? t('这一轮没有调用工具。', 'This turn called no tools.')
            : t(
                `这一轮有 ${unreadable} 个工具调用，这个控制台读不了（平台比控制台新），可以在对话里看。`,
                `This turn made ${unreadable} tool call(s) this console cannot read (the platform is newer than the console); the chat shows them.`,
              )}{' '}
          <RouteLink href={hrefs.chat(data.chatId)} testId="explain-turn-tool-calls-chat">
            {t('打开对话', 'Open the chat')}
          </RouteLink>
        </p>
      ) : (
        <>
          <span className="text-3 text-small" data-testid="explain-turn-tool-calls-count">
            {data.truncated === true
              ? // UX review on #1517: never a count that reads as the total when there are more.
                t(
                  `显示前 ${records.length} 个，这一轮还有更多；按调用先后排列。这是智能体自己报告的调用，参数和结果在存下时已遮蔽疑似凭据并截断。`,
                  `Showing the first ${records.length} call(s); this turn made more. In the order they were made. Reported by the agent; arguments and results had credential-like values hidden and were shortened when stored.`,
                )
              : t(
                  `共 ${records.length} 个，按调用先后排列。这是智能体自己报告的调用，参数和结果在存下时已遮蔽疑似凭据并截断。`,
                  `${records.length} call(s), in the order they were made. Reported by the agent; arguments and results had credential-like values hidden and were shortened when stored.`,
                )}{' '}
            <RouteLink href={hrefs.chat(data.chatId)} testId="explain-turn-tool-calls-chat">
              {t('打开对话', 'Open the chat')}
            </RouteLink>
          </span>
          {unreadable > 0 ? (
            <span className="text-3 text-small" data-testid="explain-turn-tool-calls-unreadable">
              {t(
                `另有 ${unreadable} 个这个控制台读不了（平台比控制台新），可以在对话里看。`,
                `${unreadable} more this console cannot read (the platform is newer than the console); the chat shows them.`,
              )}
            </span>
          ) : null}
          {data.truncated === true ? (
            <Notice tone="warn" testId="explain-turn-tool-calls-truncated">
              {t(
                `这一轮的工具调用超过 ${data.items.length} 个，这里只列出前 ${data.items.length} 个；全部调用在对话里这一轮的回复上方。`,
                `This turn made more than ${data.items.length} tool calls; only the first ${data.items.length} are listed here. The chat shows them all above this turn's reply.`,
              )}
            </Notice>
          ) : null}
          <div className="tool-calls" data-testid="explain-turn-tool-calls-list">
            {records.map((record) => (
              <PersistedToolCallRowView key={record.toolCallId} record={record} http={http} dated />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
