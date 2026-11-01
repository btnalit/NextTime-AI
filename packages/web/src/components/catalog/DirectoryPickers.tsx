import { type ReactNode, useState } from 'react';
import { actionHint, actionLabel } from '../../lib/capability-labels.js';
import { capabilityModeLabel, groupCapabilitiesByMode } from '../../lib/catalog-pickers.js';
import type { CapabilityNameRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';

/**
 * components/catalog/DirectoryPickers: the pickers a definition's lists are chosen with — a
 * checklist over a directory (gates, Skills) and the capability checklist grouped by mode. The
 * Worker editor's fields first; S11 GO15b also the plan editor's 「对 Worker 的调整」, which picks
 * from the same directories.
 */

export function toggleListItem(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export interface CheckboxOption {
  readonly id: string;
  readonly label: ReactNode;
}

/** A `<fieldset>` of checkboxes over a directory list (capabilities / gates / skills) — the same
 *  "checklist + own inherit-less selection" shape `AgentProfileForm.tsx`'s local `ChecklistField`
 *  already established for exactly this kind of picker, minus the "inherit workspace default"
 *  toggle (no such semantics exist for a WorkerDefinition's own declared needs). Never silently
 *  drops an already-selected id/name just because the loaded directory does not carry it (still
 *  loading, a 403, or a value the directory no longer lists) — `extra` appends it after the
 *  directory's own options, labeled with the raw value itself, so a pre-filled selection is always
 *  visible and never lost on submit. */
export function CheckboxListField({
  legend,
  hint,
  error,
  required,
  options,
  selected,
  onToggle,
  disabled,
  testId,
  emptyHint,
}: {
  readonly legend: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly options: readonly CheckboxOption[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly emptyHint: ReactNode;
}) {
  const known = new Set(options.map((option) => option.id));
  const extra = selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id }));
  const rendered = [...options, ...extra];
  return (
    <div className="field" data-testid={testId}>
      <span className="field-label">
        {legend}
        {required ? (
          <span className="field-required" aria-hidden>
            *
          </span>
        ) : null}
      </span>
      {rendered.length === 0 ? (
        <p className="text-3 text-small">{emptyHint}</p>
      ) : (
        <fieldset className="stack-s" aria-label={typeof legend === 'string' ? legend : testId}>
          {rendered.map((option) => (
            <label className="checkbox" key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={() => onToggle(option.id)}
                disabled={disabled}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {hint !== undefined && !error ? <p className="field-hint">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The capability checklist (console-ux-3): `list_capability_names` returns 100+ names, so they are
 * grouped by the `mode` each row already carries (observe / write / propose / execute), with a
 * name filter and a "select all" per group that acts on the rows the filter leaves visible.
 * Selected names outside the directory are kept in their own group, as `CheckboxListField` does.
 */
export function CapabilityPickerField({
  label,
  hint,
  error,
  required,
  rows,
  selected,
  onChange,
  disabled,
  emptyHint,
  testId = 'wd-capabilities',
  idPrefix,
}: {
  /** The field's label (default 「能力」). */
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly rows: readonly CapabilityNameRow[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly disabled?: boolean;
  readonly emptyHint: ReactNode;
  /** The field's test id, and the prefix of its parts' (`<testId>-filter`, `-count`, `-group-…`):
   *  one per page, so the filter's id is unique too. */
  readonly testId?: string;
  /** The filter input's id prefix, when the test id is not unique on the page (default: the test
   *  id). */
  readonly idPrefix?: string;
}) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const known = new Set(rows.map((row) => row.name));
  const extraRows = selected
    .filter((name) => !known.has(name))
    .map((name) => ({ name, mode: '__unlisted__' }));
  const groups = groupCapabilitiesByMode([...rows, ...extraRows], filter, (name) =>
    actionLabel(name, t),
  );
  const filtering = filter.trim() !== '';

  function setGroup(names: readonly string[], on: boolean): void {
    if (on) onChange([...selected, ...names.filter((name) => !selected.includes(name))]);
    else onChange(selected.filter((name) => !names.includes(name)));
  }

  function toggleCollapsed(mode: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(mode)) next.delete(mode);
      else next.add(mode);
      return next;
    });
  }

  return (
    <div className="field" data-testid={testId}>
      <span className="field-label">
        {label ?? t('能力', 'capabilities')}
        {required ? (
          <span className="field-required" aria-hidden>
            *
          </span>
        ) : null}
      </span>
      {rows.length + extraRows.length === 0 ? (
        <p className="text-3 text-small">{emptyHint}</p>
      ) : (
        <>
          <div className="row-wrap">
            <input
              id={`${idPrefix ?? testId}-filter`}
              className="input input-mono"
              aria-label={t('筛选能力', 'Filter capabilities')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('按名称筛选…', 'Filter by name…')}
              data-testid={`${testId}-filter`}
              // Narrows the list, saves nothing: not an edit to ask about (legacy 497 rule).
              data-no-discard-guard
            />
            <span className="text-3 text-small" data-testid={`${testId}-count`}>
              {t(`已选 ${selected.length} 个`, `${selected.length} selected`)}
            </span>
          </div>
          {groups.length === 0 ? (
            <p className="text-3 text-small" data-testid={`${testId}-no-match`}>
              {t('没有名称匹配的能力。', 'No capability name matches.')}
            </p>
          ) : null}
          {groups.map((group) => {
            const names = group.rows.map((row) => row.name);
            const allOn = names.every((name) => selected.includes(name));
            const pickedInGroup = names.filter((name) => selected.includes(name)).length;
            const groupLabel =
              group.mode === '__unlisted__'
                ? t('目录外（已选）', 'Not in the directory (selected)')
                : capabilityModeLabel(group.mode, t);
            const open = filtering || !collapsed.has(group.mode);
            return (
              <fieldset
                key={group.mode}
                className="stack-s"
                aria-label={groupLabel}
                data-testid={`${testId}-group-${group.mode}`}
              >
                <div className="row-wrap">
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => toggleCollapsed(group.mode)}
                    aria-expanded={open}
                    disabled={filtering}
                  >
                    {open ? '▾' : '▸'} {groupLabel} ({pickedInGroup}/{names.length})
                  </Button>
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => setGroup(names, !allOn)}
                    disabled={disabled}
                    data-testid={`${testId}-group-toggle-${group.mode}`}
                  >
                    {allOn
                      ? filtering
                        ? t('取消选择筛选结果', 'Clear the filtered ones')
                        : t('取消本组', 'Clear group')
                      : filtering
                        ? t('全选筛选结果', 'Select the filtered ones')
                        : t('全选本组', 'Select group')}
                  </Button>
                </div>
                {open
                  ? group.rows.map((row) => (
                      <label className="checkbox" key={row.name}>
                        <input
                          type="checkbox"
                          checked={selected.includes(row.name)}
                          onChange={() => setGroup([row.name], !selected.includes(row.name))}
                          disabled={disabled}
                        />
                        {/* Audit P1-8: what it does first, the registry name as the secondary
                         *  text a builder recognizes from docs and errors. */}
                        <span title={actionHint(row.name, t) ?? undefined}>
                          {actionLabel(row.name, t)}{' '}
                          <span className="mono text-3 text-small">{row.name}</span>
                        </span>
                      </label>
                    ))
                  : null}
              </fieldset>
            );
          })}
        </>
      )}
      {hint !== undefined && !error ? <p className="field-hint">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
