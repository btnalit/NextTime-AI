import type { ModelRow } from '../../lib/governance.js';
import { Field, Select } from '../ui/Field.js';

/** The 入口模型 select's "no model of its own" choice — `entryModel: null` on the wire (pi's own
 *  default), which a `<select>` cannot carry as a value. */
const PLATFORM_DEFAULT = '__default__';

export interface EntryModelSelectProps {
  readonly id: string;
  /** The models this workspace may take as its entry model: its own non-empty allowed list, or
   *  the whole catalog when it does not restrict. */
  readonly options: readonly string[];
  readonly value: string | null;
  readonly onChange: (entryModel: string | null) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/**
 * components/platform/WorkspaceModelControls: the two model controls 新建工作区 and the workspace
 * drawer both render (P-A2) — the entry model every member's entry agent takes until they pick
 * their own in 我的智能体, and the allow-list 我的智能体 narrows to. One definition so the two
 * surfaces cannot drift apart on labels, testids or the `null`/`[]` encodings.
 */
export function EntryModelSelect({
  id,
  options,
  value,
  onChange,
  disabled = false,
  testId,
}: EntryModelSelectProps) {
  return (
    <Field
      id={id}
      label="入口模型 Entry model"
      hint="成员在「我的智能体」里没有自己选模型时用它。 Used until a member picks their own in 我的智能体."
    >
      <Select
        id={id}
        value={value ?? PLATFORM_DEFAULT}
        onChange={(event) =>
          onChange(event.target.value === PLATFORM_DEFAULT ? null : event.target.value)
        }
        disabled={disabled}
        data-testid={testId}
      >
        <option value={PLATFORM_DEFAULT}>平台默认 Platform default</option>
        {options.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export interface AllowedModelsChecklistProps {
  readonly models: readonly ModelRow[];
  readonly selected: readonly string[];
  readonly onChange: (allowedModels: readonly string[]) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/** The 允许的模型 checklist. An empty selection is *every* catalog model (`allowedModels: []` on
 *  the wire), not "none" — said on the control rather than left to be discovered. */
export function AllowedModelsChecklist({
  models,
  selected,
  onChange,
  disabled = false,
  testId,
}: AllowedModelsChecklistProps) {
  function toggle(id: string): void {
    onChange(selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id]);
  }

  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="field-label">
        允许的模型 Allowed models
        <span className="field-hint" style={{ margin: 0 }}>
          {' '}
          — 不勾 = 目录里全部 none ticked = every catalog model
        </span>
      </legend>
      <div className="stack-s model-checklist" data-testid={testId}>
        {models.length === 0 ? (
          <p className="field-hint">目录里还没有模型。 No models in the catalog yet.</p>
        ) : (
          models.map((model) => (
            <label className="checkbox" key={model.id}>
              <input
                type="checkbox"
                checked={selected.includes(model.id)}
                onChange={() => toggle(model.id)}
                disabled={disabled}
              />
              <span className="mono">{model.id}</span>
            </label>
          ))
        )}
      </div>
    </fieldset>
  );
}
