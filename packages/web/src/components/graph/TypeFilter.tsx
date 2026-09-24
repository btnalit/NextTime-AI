import type { OntologyObjectTypeWire } from '@nexttime/shared';
import { useT } from '../../lib/i18n.js';
import { Field, Input, Select } from '../ui/Field.js';

export interface TypeFilterProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** `list_types{kind:'object'}` rows (already filtered / sorted by `objectTypeOptions`).
   *  `undefined` while loading or when the call failed — the control degrades to a text input so
   *  a type can still be typed (the kernel's `search{objectType}` takes any string). */
  readonly types: readonly OntologyObjectTypeWire[] | undefined;
  readonly disabled?: boolean;
}

/** components/graph/TypeFilter: the ObjectType selector of the search form — every ObjectType of
 *  the workspace's published ontology (`list_types`), plus "全部类型 All types". */
export function TypeFilter({ id, value, onChange, types, disabled }: TypeFilterProps) {
  const t = useT();
  return (
    <Field id={id} label={t('类型', 'Type')}>
      {types === undefined ? (
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="ObjectType"
          disabled={disabled}
          mono
          data-testid="graph-type-input"
        />
      ) : (
        <Select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          data-testid="graph-type-select"
        >
          <option value="">{t('全部类型', 'All types')}</option>
          {types.map((type) => (
            <option key={type.name} value={type.name} title={type.description}>
              {type.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
