import { useEffect, useId, useState } from 'react';
import { parseJsonObject } from '../../lib/catalog.js';
import { prettyJson } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../ui/Button.js';
import { Field, Textarea } from '../ui/Field.js';

export interface JsonEditorProps {
  readonly label: string;
  /** The current wire content; the textarea re-syncs to it whenever it changes upstream. */
  readonly value: Readonly<Record<string, unknown>>;
  /** Called with the parsed object when the reader applies an edited JSON text. */
  readonly onApply: (value: Record<string, unknown>) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/**
 * components/catalog/JsonEditor: the "JSON 视图" of an editor (§5.3 "表单 + YAML 视图" — kept as
 * JSON, this package has no YAML dependency): the wire content pretty-printed into a textarea;
 * "应用 Apply" parses it back into the form. Structural validation stays with the editor's
 * submit (the shared Zod schemas), this only rejects non-object JSON.
 */
export function JsonEditor({ label, value, onApply, disabled, testId }: JsonEditorProps) {
  const t = useT();
  const id = useId();
  const serialized = prettyJson(value);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(serialized);
    setError(null);
  }, [serialized]);
  const dirty = text !== serialized;
  return (
    <div className="stack-s" data-testid={testId}>
      <Field id={id} label={label} error={error}>
        <Textarea
          id={id}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          rows={12}
          mono
          disabled={disabled}
          invalid={error !== null}
          spellCheck={false}
        />
      </Field>
      <div className="row">
        <Button
          variant="secondary"
          size="s"
          disabled={disabled || !dirty}
          onClick={() => {
            const parsed = parseJsonObject(text, t);
            if (!parsed.ok) {
              setError(parsed.error);
              return;
            }
            onApply(parsed.value);
          }}
          data-testid={testId ? `${testId}-apply` : undefined}
        >
          {t('应用到表单', 'Apply to form')}
        </Button>
      </div>
    </div>
  );
}
