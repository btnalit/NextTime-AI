import type { LlmProviderTestResultWire } from '@nexttime/shared';
import { formatDateTime, formatRelative } from '../../../lib/format.js';
import { type Translate, useT } from '../../../lib/i18n.js';
import { explainUpstreamError, testVerdict } from '../../../lib/provider-form.js';

export interface ProviderTestResultProps {
  readonly result: LlmProviderTestResultWire;
  readonly testId?: string;
}

function outcomeTone(outcome: LlmProviderTestResultWire['completion']): string {
  if (outcome === 'ok') return 'chip-ok';
  if (outcome === 'error') return 'chip-danger';
  return 'chip-neutral';
}

function outcomeLabel(outcome: LlmProviderTestResultWire['completion'], t: Translate): string {
  if (outcome === 'ok') return t('通过', 'ok');
  if (outcome === 'error') return t('失败', 'error');
  return t('跳过', 'skipped');
}

/**
 * components/platform/providers/ProviderTestResult: the structured outcome of 测试调用 (S6-B,
 * plan §5.4 acceptance — "含一次工具调用往返"): one chip per round trip (completion, tool call),
 * the latency, the sanitized upstream error when there is one, and when it ran. Plain
 * `chip chip-*` spans rather than `StatusChip`: no state machine in `lib/status-tone.ts` covers
 * a three-valued test outcome (that file is another lane's — see the S6-B report). The verdict
 * line on top says in words what the two outcomes mean for chats vs. Workers and gate tools, and
 * what the upstream error most likely means (lib/provider-form.ts `explainUpstreamError`); the
 * raw, already-sanitized error stays one click away.
 */
export function ProviderTestResult({ result, testId }: ProviderTestResultProps) {
  const t = useT();
  const verdict = testVerdict(result);
  const explanation = explainUpstreamError(result.error, t);
  return (
    <div className="stack-s" data-testid={testId}>
      <div
        className="provider-test-verdict"
        data-verdict={verdict}
        data-testid="provider-test-verdict"
      >
        <span className="provider-test-verdict-mark" aria-hidden="true">
          {verdict === 'ok' ? '✓' : '!'}
        </span>
        <div>
          <strong>
            {verdict === 'ok'
              ? t(`${result.model} 可用`, `${result.model} works`)
              : verdict === 'chat-only'
                ? t(
                    `${result.model} 能对话，但工具调用没通过`,
                    `${result.model} answers, but tool calling failed`,
                  )
                : t(`${result.model} 调用失败`, `${result.model} failed`)}
          </strong>
          <span className="text-2">
            {verdict === 'ok'
              ? t(
                  '补全和工具调用都通过：对话、Worker 和门工具都能用它。',
                  'Completion and tool call both passed — chats, Workers and gate tools can use it.',
                )
              : verdict === 'chat-only'
                ? (explanation ??
                  t(
                    '对话可以用，但 Worker 和门工具依赖工具调用，会用不了。',
                    'Chats work, but Workers and gate tools depend on tool calling and will not.',
                  ))
                : (explanation ??
                  t(
                    '第一次补全就失败了，没有继续测工具调用。看下面的原始错误。',
                    'The first completion failed, so the tool call was not tried — see the raw error below.',
                  ))}
          </span>
        </div>
      </div>
      <div className="row-wrap">
        <span className="text-small text-2">{t('补全', 'completion')}</span>
        <span
          className={`chip chip-s ${outcomeTone(result.completion)}`}
          data-testid="provider-test-completion"
          data-status={result.completion}
        >
          {outcomeLabel(result.completion, t)}
        </span>
        <span className="text-small text-2">{t('工具调用', 'tool call')}</span>
        <span
          className={`chip chip-s ${outcomeTone(result.toolCall)}`}
          data-testid="provider-test-tool-call"
          data-status={result.toolCall}
        >
          {outcomeLabel(result.toolCall, t)}
        </span>
        <span className="text-small text-3 mono">
          {result.model} · {result.latencyMs} ms ·{' '}
          <time title={formatDateTime(result.testedAt)}>{formatRelative(result.testedAt)}</time>
        </span>
      </div>
      {result.error ? (
        <details className="disclosure">
          <summary>{t('原始错误', 'Raw error')}</summary>
          <div className="disclosure-body">
            <p className="field-error mono" data-testid="provider-test-error">
              {result.error}
            </p>
          </div>
        </details>
      ) : null}
    </div>
  );
}
