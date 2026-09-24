import type { LlmProviderTestResultWire } from '@nexttime/shared';
import { formatDateTime, formatRelative } from '../../../lib/format.js';
import { useT } from '../../../lib/i18n.js';

export interface ProviderTestResultProps {
  readonly result: LlmProviderTestResultWire;
  readonly testId?: string;
}

function outcomeTone(outcome: LlmProviderTestResultWire['completion']): string {
  if (outcome === 'ok') return 'chip-ok';
  if (outcome === 'error') return 'chip-danger';
  return 'chip-neutral';
}

function outcomeLabel(outcome: LlmProviderTestResultWire['completion']): string {
  if (outcome === 'ok') return '通过 ok';
  if (outcome === 'error') return '失败 error';
  return '跳过 skipped';
}

/**
 * components/platform/providers/ProviderTestResult: the structured outcome of 测试调用 (S6-B,
 * plan §5.4 acceptance — "含一次工具调用往返"): one chip per round trip (completion, tool call),
 * the latency, the sanitized upstream error when there is one, and when it ran. Plain
 * `chip chip-*` spans rather than `StatusChip`: no state machine in `lib/status-tone.ts` covers
 * a three-valued test outcome (that file is another lane's — see the S6-B report).
 */
export function ProviderTestResult({ result, testId }: ProviderTestResultProps) {
  const t = useT();
  return (
    <div className="stack-s" data-testid={testId}>
      <div className="row-wrap">
        <span className="text-small text-2">{t('补全', 'completion')}</span>
        <span
          className={`chip chip-s ${outcomeTone(result.completion)}`}
          data-testid="provider-test-completion"
          data-status={result.completion}
        >
          {outcomeLabel(result.completion)}
        </span>
        <span className="text-small text-2">{t('工具调用', 'tool call')}</span>
        <span
          className={`chip chip-s ${outcomeTone(result.toolCall)}`}
          data-testid="provider-test-tool-call"
          data-status={result.toolCall}
        >
          {outcomeLabel(result.toolCall)}
        </span>
        <span className="text-small text-3 mono">
          {result.model} · {result.latencyMs} ms ·{' '}
          <time title={formatDateTime(result.testedAt)}>{formatRelative(result.testedAt)}</time>
        </span>
      </div>
      {result.error ? (
        <p className="field-error" data-testid="provider-test-error">
          {result.error}
        </p>
      ) : null}
    </div>
  );
}
