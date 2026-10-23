import type { OutputProblem, OutputSchema } from '@nexttime/shared';
import { prettyJsonVisible } from '../../lib/format.js';
import { outputContractFields, outputProblemText } from '../../lib/goals.js';
import type { Translate } from '../../lib/i18n.js';

/**
 * components/goals/OutputContract (S11 GO5d-1): a goal step's output contract and what it refused,
 * as the goal page (`GoalStepsSection`) and the Task page (`TaskDetail`) both show them — the
 * fields the step's Worker hands back (name, kind, 必填), the schema itself under them, and the
 * places a refused report did not match. A place is named, never its value: the kernel's problems
 * carry none.
 */
/** What an output contract is for, in a line — first under the contract's heading. */
export function OutputContractExplanation({ t }: { readonly t: Translate }) {
  return (
    <span className="text-small text-3">
      {t(
        'Worker 交回结果时要带上符合这份约定的 output；不符合的报告会被拒绝，Worker 会被告知哪里不对。',
        'The Worker’s result carries an output that meets this contract; a report that does not is refused, and the Worker is told where.',
      )}
    </span>
  );
}

/** `explain: false` when the page already put {@link OutputContractExplanation} above. */
export function OutputContractFields({
  schema,
  t,
  testId,
  explain = true,
}: {
  readonly schema: OutputSchema;
  readonly t: Translate;
  readonly testId?: string;
  readonly explain?: boolean;
}) {
  const fields = outputContractFields(schema, t);
  return (
    <div className="stack-s" data-testid={testId}>
      {explain ? <OutputContractExplanation t={t} /> : null}
      {fields.length === 0 ? (
        <span className="text-small text-3">
          {t(
            '约定没有列出字段：任何对象都符合。',
            'The contract lists no fields: any object meets it.',
          )}
        </span>
      ) : (
        <ul className="stack-s">
          {fields.map((field) => (
            <li
              key={field.name}
              className="row-wrap text-small"
              data-testid="output-contract-field"
            >
              <span className="mono">{field.name}</span>
              <span className="text-3">{field.kind}</span>
              {field.required ? (
                <span className="chip chip-neutral chip-s">{t('必填', 'Required')}</span>
              ) : null}
              {field.description ? <span className="text-3">— {field.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <details className="disclosure">
        <summary>{t('约定原文（JSON Schema）', 'The contract as JSON Schema')}</summary>
        <div className="disclosure-body">
          <pre className="code-block">{prettyJsonVisible(schema)}</pre>
        </div>
      </details>
    </div>
  );
}

export function OutputProblemList({
  problems,
  problemCount,
  t,
  testId,
}: {
  readonly problems: readonly OutputProblem[];
  readonly problemCount: number;
  readonly t: Translate;
  readonly testId?: string;
}) {
  const more = problemCount - problems.length;
  return (
    <ul className="stack-s output-problems" data-testid={testId}>
      {problems.map((problem, index) => (
        <li key={`${problem.path}-${index}`} className="text-small">
          <span className="mono">{problem.path}</span>
          <span className="text-3">
            {t('：', ': ')}
            {outputProblemText(problem.message, t)}
          </span>
        </li>
      ))}
      {more > 0 ? (
        <li className="text-small text-3">{t(`…… 还有 ${more} 处`, `… and ${more} more`)}</li>
      ) : null}
    </ul>
  );
}
