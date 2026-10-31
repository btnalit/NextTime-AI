import { useEffect, useRef } from 'react';
import {
  DEFINITION_REFERENCE_FIELDS,
  type DefinitionReferenceRefusal,
  definitionReferenceFieldLabel,
  definitionReferenceFieldText,
} from '../../lib/definition-reference.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';

/** Legacy 302: why publishing this Worker draft was refused — it names what is not there — next to
 *  Publish, focused when it appears: each field by the editor's label, its values and what to do,
 *  one per line, and (where the reader can propose) the way to fix it: a version proposed from
 *  this draft, the same fields marked. Shown on the draft's detail in the catalog and on the
 *  editor's "proposed" screen alike, instead of a toast. */
export function PublishReferenceProblem({
  refusal,
  onFix,
}: {
  readonly refusal: DefinitionReferenceRefusal;
  /** Opens the editor on a next version of this draft; absent where there is no such way. */
  readonly onFix?: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus again on each new refusal.
  useEffect(() => {
    ref.current?.focus();
  }, [refusal]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="field-error stack-s"
      data-testid="worker-publish-references"
    >
      <strong>
        {t(
          '这份草稿引用了不存在的东西，所以没有发布。',
          'This draft names what is not there, so it was not published.',
        )}
      </strong>
      <ul className="stack-s">
        {DEFINITION_REFERENCE_FIELDS.flatMap((field) => {
          const values = refusal[field];
          return values && values.length > 0
            ? [
                <li key={field} data-testid={`worker-publish-references-${field}`}>
                  <strong>{definitionReferenceFieldLabel(field, t)}</strong>
                  {t('：', ': ')}
                  {definitionReferenceFieldText(field, values, t)}
                </li>,
              ]
            : [];
        })}
      </ul>
      {onFix ? (
        <span className="row-wrap">
          <Button
            variant="secondary"
            size="s"
            onClick={onFix}
            data-testid="worker-publish-references-fix"
          >
            {t('按这份草稿改一版', 'Fix it in a new version')}
          </Button>
          <span className="text-3 text-small">
            {t(
              '会打开编辑器，标出要改的字段；提议的新版本发布后，这份草稿可以丢弃。',
              'Opens the editor with these fields marked; once the new version is published, this draft can be discarded.',
            )}
          </span>
        </span>
      ) : null}
    </div>
  );
}
