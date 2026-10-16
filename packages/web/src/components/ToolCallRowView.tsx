import { memo } from 'react';
import { useCapability } from '../hooks/useCapability.js';
import { useRoleCan } from '../hooks/useRoleCan.js';
import {
  type ActionOutcome,
  actionOutcomeChip,
  actionOutcomeOfToolResult,
  actionTargetLabel,
  waitingReason,
} from '../lib/action-outcome.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { gateReasonNextStep } from '../lib/errors.js';
import { formatTime, prettyJson, shortId } from '../lib/format.js';
import { type Translate, useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import type { ToolCallRow } from '../lib/streaming-reducer.js';
import { type ToolCallRecord, previewDisplayText } from '../lib/tool-call-record.js';
import { useGatekeeperDirectory } from './approvals/useDirectoryNames.js';
import { Notice } from './kit/notice.js';
import { RouteLink } from './kit/route-link.js';
import { Icon } from './ui/Icon.js';

/** The `gatekeeperId` a gate call's arguments name — an object, or its JSON text (a persisted
 *  preview; one cut short does not parse and names none). */
function gatekeeperIdOf(args: unknown): string | undefined {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object') return undefined;
  const id = (value as { gatekeeperId?: unknown }).gatekeeperId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** A gate refusal the result names (`operation_definition_mismatch`, an ActionRequest's
 *  `operation_definition_unavailable:` reason, …), said in the viewer's language with what to do —
 *  above the raw result, which stays as the agent saw it (review of #538, G3). With a link to the
 *  system the call went to when its arguments name it (UX acceptance of #538).
 *
 *  Legacy 287 (UX acceptance of #586): "not sent" is a plain note — nothing ran; "outcome unknown"
 *  is the loudest — it may have run — names what to check (`target`) and on which system, says
 *  what the raw `"status": "failed"` below means, and has no link: the system's console page
 *  cannot tell whether the action took effect. */
function GateReasonNote({
  http,
  actionRequestId,
  ...note
}: GateReasonNoteProps & {
  readonly http?: CapabilityCaller;
  readonly actionRequestId?: string;
}) {
  const t = useT();
  if (http !== undefined && gateReasonNextStep(note.text, t)?.code === 'outcome_unknown') {
    return <NamedGateReasonNote http={http} actionRequestId={actionRequestId} {...note} />;
  }
  return <GateReasonNoteBody {...note} />;
}

interface GateReasonNoteProps {
  readonly text: string;
  readonly gatekeeperId?: string;
  readonly target?: string;
}

/** An outcome-unknown note that names the system the call went to (UX acceptance of #586, P3):
 *  from the call's own `gatekeeperId` argument (`request_action`), else — a gate tool's arguments
 *  carry none — from the ActionRequest the result names (`get_action`, operator and up; another
 *  reader gets the note without the name). Two systems with one name add the short id. */
function NamedGateReasonNote({
  http,
  actionRequestId,
  ...note
}: GateReasonNoteProps & {
  readonly http: CapabilityCaller;
  readonly actionRequestId?: string;
}) {
  const directory = useGatekeeperDirectory(http);
  const canGetAction = useRoleCan(http)('get_action') === true;
  const lookUp = note.gatekeeperId === undefined && actionRequestId !== undefined && canGetAction;
  const action = useCapability<{ readonly gatekeeperId: string }>(
    http,
    'get_action',
    { actionRequestId: actionRequestId ?? '' },
    { enabled: lookUp },
  );
  const gatekeeperId =
    note.gatekeeperId ??
    (lookUp && action.state.status === 'ready' ? action.state.data.gatekeeperId : undefined);
  const name = gatekeeperId !== undefined ? directory.names.get(gatekeeperId) : undefined;
  const system =
    gatekeeperId !== undefined && name !== undefined
      ? directory.same.has(gatekeeperId)
        ? `${name} · ${shortId(gatekeeperId)}`
        : name
      : undefined;
  return <GateReasonNoteBody {...note} system={system} />;
}

function GateReasonNoteBody({
  text,
  gatekeeperId,
  target,
  system,
}: GateReasonNoteProps & { readonly system?: string }) {
  const t = useT();
  const step = gateReasonNextStep(text, t, target, system);
  if (!step) return null;
  const outcomeUnknown = step.code === 'outcome_unknown';
  return (
    <Notice
      tone={step.tone}
      testId="tool-call-gate-reason"
      icon={outcomeUnknown ? <Icon name="alert" size="s" /> : undefined}
    >
      <span className="stack-s" data-error-code={step.code}>
        <span className="font-medium">{step.title}</span>
        <span>{step.message}</span>
        {outcomeUnknown ? (
          <span className="text-3" data-testid="tool-call-gate-reason-raw-status">
            {t(
              '下面原始结果里的 "status": "failed" 只表示平台不再跟进这条请求，不表示动作没有执行。',
              'The raw result below says "status": "failed" only because the platform stopped following this request, not because the action did not run.',
            )}
          </span>
        ) : gatekeeperId !== undefined ? (
          <a href={hrefs.gatekeeper(gatekeeperId)} data-testid="tool-call-gate-reason-link">
            {t('打开这个系统', 'Open this system')}
          </a>
        ) : null}
      </span>
    </Notice>
  );
}

/** Why an action the result reports has not finished (legacy 287, review of #586): an
 *  `executing` one whose call got no answer (warn — the platform is still asking the gate), or an
 *  approved one held back by an earlier request on the same system. */
function WaitingNote({ outcome }: { readonly outcome: ActionOutcome | null }) {
  const t = useT();
  const reason = outcome ? waitingReason(outcome, t) : null;
  if (!reason) return null;
  return (
    <Notice tone={reason.tone} testId="tool-call-waiting">
      <span className="stack-s">
        <span className="font-medium">{reason.title}</span>
        <span>{reason.message}</span>
      </span>
    </Notice>
  );
}

/** components/ToolCallRowView: one `toolCallStarted`/`toolCallEnded` pair (S1.8 deliverable 1:
 *  "tool-call rows from toolCallStarted/Ended") as a collapsed disclosure — name and state on the
 *  summary line, arguments and result inside. */
export function ToolCallRowView({
  row,
  http,
}: {
  readonly row: ToolCallRow;
  /** Names the system an outcome-unknown note points at; without it the note names none. */
  readonly http?: CapabilityCaller;
}) {
  const t = useT();
  const running = row.status === 'started';
  // W7: a tool call the runtime flagged `isError` reads "failed" instead of "done" — the model saw
  // an error result, which is the single most useful thing to know when reading a transcript.
  const failed = row.status === 'ended' && row.isError === true;
  // Legacy 287 (UX acceptance of #586): a gate action's result says where the action stands, and
  // the chip says the same — not 「完成」 over an action whose outcome is unknown.
  const resultText =
    row.status === 'ended' && row.result !== undefined ? prettyJson(row.result) : undefined;
  const action =
    row.status === 'ended' && !failed && row.result !== undefined
      ? outcomeOfLiveResult(row.result)
      : null;
  const actionChip = action ? actionOutcomeChip(action, t) : null;
  const chipClass = running
    ? 'chip-info chip-live'
    : failed
      ? 'chip-danger'
      : (actionChip?.className ?? 'chip-neutral');
  // B4 bilingual; `data-tool-outcome` stays the machine-readable hook.
  const chipLabel = running
    ? t('运行中', 'running')
    : failed
      ? t('失败', 'failed')
      : (actionChip?.label ?? t('完成', 'done'));
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
          data-action-outcome={action?.kind}
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
        {resultText !== undefined ? (
          <>
            <span className="section-title">{t('结果', 'Result')}</span>
            <GateReasonNote
              http={http}
              actionRequestId={action?.id}
              text={resultText}
              gatekeeperId={gatekeeperIdOf(row.args)}
              target={actionTargetLabel(row.name, row.args, t)}
            />
            <WaitingNote outcome={action} />
            <pre className="code-block">{resultText}</pre>
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

/** A live row's result is pi's `{content, details}` object (redacted), or — from an older
 *  runtime or a test — the capability result itself. */
function outcomeOfLiveResult(result: unknown): ActionOutcome | null {
  return actionOutcomeOfToolResult(typeof result === 'string' ? result : JSON.stringify(result));
}

/** Where the gate action a persisted call reports stands — only for a call that finished: a
 *  failed or unfinished call's chip says so first. */
function actionOutcomeOfRecord(record: ToolCallRecord): ActionOutcome | null {
  return record.outcome === 'done' && record.result
    ? actionOutcomeOfToolResult(record.result.text)
    : null;
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
export function PersistedToolCallRowView({
  record,
  http,
}: {
  readonly record: ToolCallRecord;
  readonly http?: CapabilityCaller;
}) {
  const t = useT();
  const action = actionOutcomeOfRecord(record);
  const chip = action ? actionOutcomeChip(action, t) : outcomeChip(record, t);
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
        <span
          className={`chip chip-s ${chip.className}`}
          data-tool-outcome={record.outcome}
          data-action-outcome={action?.kind}
        >
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
            <GateReasonNote
              http={http}
              actionRequestId={action?.id}
              text={record.result.text}
              gatekeeperId={record.args ? gatekeeperIdOf(record.args.text) : undefined}
              target={actionTargetLabel(record.name ?? undefined, record.args?.text, t)}
            />
            <WaitingNote outcome={action} />
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
  http,
}: {
  readonly records: readonly ToolCallRecord[];
  readonly http?: CapabilityCaller;
}) {
  const t = useT();
  const failed = records.filter((r) => r.outcome === 'failed').length;
  const unfinished = records.filter((r) => r.outcome === 'not_finished').length;
  // Legacy 287: an action whose outcome is unknown came back from a call that finished, but it is
  // the case a reader most needs to see — counted and opened like a failure; one the platform is
  // still asking the gate about is counted apart, in the waiting tone.
  const kinds = records.map((r) => actionOutcomeOfRecord(r)?.kind);
  const outcomeUnknown = kinds.filter((kind) => kind === 'outcome_unknown').length;
  const inDoubt = kinds.filter((kind) => kind === 'in_doubt').length;
  return (
    <details
      className="tool-call-group"
      open={failed + unfinished + outcomeUnknown + inDoubt > 0}
      data-testid="tool-call-group"
    >
      <summary>
        <Icon name="chevron-right" size="s" className="icon-chevron" />
        <span>{t(`调用了 ${records.length} 个工具`, `${records.length} tool call(s)`)}</span>
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
        {outcomeUnknown > 0 ? (
          <span className="chip chip-s chip-danger" data-testid="tool-call-group-outcome-unknown">
            {t(`${outcomeUnknown} 个结果不明`, `${outcomeUnknown} outcome unknown`)}
          </span>
        ) : null}
        {inDoubt > 0 ? (
          <span className="chip chip-s chip-warn" data-testid="tool-call-group-in-doubt">
            {t(`${inDoubt} 个结果不明·查询中`, `${inDoubt} outcome unknown · asking`)}
          </span>
        ) : null}
      </summary>
      <div className="tool-calls">
        <span className="text-3 text-small">
          {t(
            'agent 自己报告的调用，参数和结果已脱敏、截断。能力调用的权威记录在',
            'Reported by the agent; arguments and results are redacted and shortened. The authoritative record of capability calls is the',
          )}
          {t('', ' ')}
          <RouteLink href={hrefs.audit()}>{t('审计', 'audit log')}</RouteLink>
          {t('。', '.')}
        </span>
        {records.map((record) => (
          <PersistedToolCallRowView key={record.toolCallId} record={record} http={http} />
        ))}
      </div>
    </details>
  );
});
